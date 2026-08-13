"""MEXC spot adapter: protobuf/JSON depth feed + REST order entry + fill push.

The load-bearing fact about this venue
--------------------------------------
**MEXC has no order-entry WebSocket.** Orders go out over `POST /api/v3/order`;
the WebSocket carries market data and a private user-data stream. So the
"private WS order routing" goal is met halfway here, and the half that is
achievable is the half that actually pays:

  * The *outbound* handshake cost is removed by keeping a warm HTTP/1.1
    keep-alive pool with TLS already negotiated. A cold TLS handshake to MEXC
    is 2 RTT (~60-120 ms from a Tokyo VPS); a warm one is 0. Pre-warming the
    pool at startup and refreshing it on an idle timer is what buys the
    latency, not the protocol.
  * The *inbound* wait is removed by taking the fill from the private stream
    push instead of polling. `scripts/arblive.py` sleeps 350 ms and then issues
    a `GET /api/v3/order` per leg — that alone is ~1 s of dead time across a
    triangle, which is more than the whole latency budget.

MEXC's order ack does not carry fill quantities (there is no `newOrderRespType`
here), so the private stream is not an optimization — it is the only low-latency
way to learn what filled.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import urllib.parse
from typing import Any, Callable, Iterable, Sequence

from ..book import Level
from ..clock import now_ns, wall_ms
from ..config import MEXC, VenueSpec
from . import protobuf as pb
from .base import (DepthFrame, FillEvent, OrderRejected, OrderRequest,
                   OrderResult, OrderStatus, RateLimited, Side, Snapshot,
                   TimeInForce, VenueError)

__all__ = ["MexcFeed", "MexcRouter", "sign_query", "MexcCredentials"]

_TIF_WIRE = {TimeInForce.IOC: "IMMEDIATE_OR_CANCEL", TimeInForce.FOK: "FILL_OR_KILL"}

# MEXC order states -> our vocabulary. NEW/PARTIALLY_FILLED are transient for an
# IOC; anything else ends the leg.
_STATUS = {
    "NEW": OrderStatus.NEW, "1": OrderStatus.NEW,
    "FILLED": OrderStatus.FILLED, "2": OrderStatus.FILLED,
    "PARTIALLY_FILLED": OrderStatus.PARTIAL, "3": OrderStatus.PARTIAL,
    "CANCELED": OrderStatus.CANCELED, "4": OrderStatus.CANCELED,
    "PARTIALLY_CANCELED": OrderStatus.CANCELED, "5": OrderStatus.CANCELED,
}


def sign_query(secret: str, params: dict) -> tuple[str, str]:
    """MEXC v3 signature: HMAC-SHA256 over the urlencoded query string."""
    qs = urllib.parse.urlencode(params)
    sig = hmac.new(secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
    return qs, sig


class MexcCredentials:
    __slots__ = ("key", "secret")

    def __init__(self, key: str, secret: str) -> None:
        self.key = key
        self.secret = secret

    @property
    def armed(self) -> bool:
        return bool(self.key and self.secret)


# ---------------------------------------------------------------------- feed

def _num(s: Any) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return -1.0


class _PbLayout:
    """Discovered field numbers for one protobuf channel.

    Discovery beats hardcoding here: MEXC publishes `.proto` files but has
    already renumbered once, and a wrong constant produces a *plausible* book
    rather than an exception. The structure of a depth message is distinctive
    enough to find by inspection — repeated nested messages whose first two
    fields are numeric strings — so the adapter finds it once per channel and
    then uses the cached numbers on the hot path.
    """

    __slots__ = ("body_field", "asks_field", "bids_field", "from_field",
                 "to_field", "symbol_field")

    def __init__(self) -> None:
        self.body_field = 0
        self.asks_field = 0
        self.bids_field = 0
        self.from_field = 0
        self.to_field = 0
        self.symbol_field = 0

    @property
    def known(self) -> bool:
        return bool(self.body_field and (self.asks_field or self.bids_field))


def _looks_like_levels(msg: dict[int, list[Any]]) -> bool:
    """A depth *item* is {1: "price", 2: "qty"} with both numeric strings."""
    if not msg:
        return False
    p = pb.as_str(msg.get(1))
    q = pb.as_str(msg.get(2))
    return _num(p) > 0 and _num(q) >= 0


def _read_levels(values: list[Any]) -> list[Level]:
    out: list[Level] = []
    for raw in values:
        if not isinstance(raw, bytes):
            continue
        try:
            item = pb.decode(raw)
        except pb.ProtobufError:
            continue
        p, q = _num(pb.as_str(item.get(1))), _num(pb.as_str(item.get(2)))
        if p > 0 and q >= 0:
            out.append((p, q))
    return out


class MexcFeed:
    """Public depth stream decoder for MEXC spot.

    `wire="protobuf"` (the current default host) decodes with the schema-free
    reader; `wire="json"` speaks the legacy `spot@public.increase.depth.v3.api`
    channel, which is easier to eyeball when something looks wrong.
    """

    def __init__(self, spec: VenueSpec = MEXC, symbols: Iterable[str] = (),
                 http: Any = None, wire: str | None = None) -> None:
        self.spec = spec
        self.wire = wire or spec.wire
        self.http = http
        self.symbol_set = set(symbols)
        self._layouts: dict[str, _PbLayout] = {}
        self.decode_errors = 0
        self.frames_decoded = 0

    # -------------------------------------------------------- subscriptions

    def channels_for(self, symbols: Sequence[str]) -> list[str]:
        tpl = (self.spec.depth_channel if self.wire == "protobuf"
               else "spot@public.increase.depth.v3.api@{symbol}")
        return [tpl.format(symbol=s) for s in symbols]

    def subscribe_message(self, channels: Sequence[str]) -> str:
        return json.dumps({"method": "SUBSCRIPTION", "params": list(channels)})

    def unsubscribe_message(self, channels: Sequence[str]) -> str:
        return json.dumps({"method": "UNSUBSCRIPTION", "params": list(channels)})

    def ping_message(self) -> str:
        # MEXC drops a socket after 60 s of silence even when subscribed.
        return json.dumps({"method": "PING"})

    # --------------------------------------------------------------- decode

    def decode(self, raw: str | bytes) -> list[DepthFrame]:
        recv = now_ns()
        try:
            if isinstance(raw, (bytes, bytearray)):
                # Control replies come back as JSON text even on the pb host.
                if raw[:1] in (b"{", b"["):
                    return self._decode_json(raw.decode("utf-8"), recv)
                return self._decode_pb(bytes(raw), recv)
            return self._decode_json(raw, recv)
        except Exception:  # noqa: BLE001 - a bad frame must never kill the feed
            self.decode_errors += 1
            return []

    def _decode_json(self, text: str, recv: int) -> list[DepthFrame]:
        msg = json.loads(text)
        if not isinstance(msg, dict):
            return []
        d = msg.get("d")
        if not isinstance(d, dict):
            return []                       # PONG / subscription ack
        symbol = msg.get("s") or d.get("s")
        if not symbol:
            return []
        bids = [(_num(x.get("p")), _num(x.get("v"))) for x in (d.get("bids") or [])]
        asks = [(_num(x.get("p")), _num(x.get("v"))) for x in (d.get("asks") or [])]
        bids = [(p, q) for p, q in bids if p > 0 and q >= 0]
        asks = [(p, q) for p, q in asks if p > 0 and q >= 0]
        first = int(_num(d.get("fromVersion") or d.get("r") or 0)) or 0
        last = int(_num(d.get("toVersion") or d.get("r") or 0)) or 0
        if first and not last:
            last = first
        self.frames_decoded += 1
        return [DepthFrame(symbol, first, last, bids, asks,
                           int(msg.get("t") or 0), False, recv)]

    def _decode_pb(self, raw: bytes, recv: int) -> list[DepthFrame]:
        top = pb.decode(raw)
        channel = pb.as_str(top.get(1))
        layout = self._layouts.get(channel)
        if layout is None or not layout.known:
            layout = self._discover(top)
            if not layout.known:
                self.decode_errors += 1
                return []
            self._layouts[channel] = layout

        symbol = pb.as_str(top.get(layout.symbol_field or 3))
        if not symbol or (self.symbol_set and symbol not in self.symbol_set):
            # Field 3 was not the symbol on this channel; re-discover once.
            symbol = self._find_symbol(top)
            if not symbol:
                self.decode_errors += 1
                return []
        body = pb.as_message(top.get(layout.body_field))
        if not body:
            self.decode_errors += 1
            return []
        asks = _read_levels(body.get(layout.asks_field, [])) if layout.asks_field else []
        bids = _read_levels(body.get(layout.bids_field, [])) if layout.bids_field else []
        first = int(_num(pb.as_str(body.get(layout.from_field)))) if layout.from_field else 0
        last = int(_num(pb.as_str(body.get(layout.to_field)))) if layout.to_field else 0
        if first < 0:
            first = 0
        if last <= 0:
            last = first
        # Sanity gate: a book whose best bid sits above its best ask means the
        # ask/bid fields are swapped. Correct it rather than feed a fake edge.
        if bids and asks and max(p for p, _ in bids) > min(p for p, _ in asks) * 1.5:
            bids, asks = asks, bids
            layout.asks_field, layout.bids_field = layout.bids_field, layout.asks_field
        self.frames_decoded += 1
        ts = int(_num(pb.as_str(top.get(5)))) if top.get(5) else 0
        return [DepthFrame(symbol, first, last, bids, asks,
                           ts if ts > 0 else wall_ms(), False, recv)]

    def _find_symbol(self, top: dict[int, list[Any]]) -> str:
        for _fno, vals in sorted(top.items()):
            s = pb.as_str(vals)
            if s and (not self.symbol_set or s in self.symbol_set):
                if s.isalnum() and s.isupper():
                    return s
        return ""

    def _discover(self, top: dict[int, list[Any]]) -> _PbLayout:
        """Locate the depth body and its ask/bid/version fields by structure."""
        layout = _PbLayout()
        for fno, vals in sorted(top.items()):
            for v in vals:
                if not isinstance(v, bytes) or len(v) < 4:
                    continue
                try:
                    body = pb.decode(v)
                except pb.ProtobufError:
                    continue
                level_fields = []
                num_fields = []
                for bfno, bvals in sorted(body.items()):
                    if any(isinstance(x, bytes) and _looks_like_levels(pb.as_message([x]))
                           for x in bvals):
                        level_fields.append(bfno)
                    elif _num(pb.as_str(bvals)) >= 0 and pb.as_str(bvals):
                        num_fields.append(bfno)
                if not level_fields:
                    continue
                layout.body_field = fno
                # MEXC's declared order is asks=1, bids=2; the price sanity
                # check in `_decode_pb` corrects it if that ever flips.
                layout.asks_field = level_fields[0]
                layout.bids_field = level_fields[1] if len(level_fields) > 1 else 0
                versions = [f for f in num_fields
                            if _num(pb.as_str(body.get(f))) >= 1]
                if len(versions) >= 2:
                    a, b = versions[-2], versions[-1]
                    va, vb = _num(pb.as_str(body.get(a))), _num(pb.as_str(body.get(b)))
                    layout.from_field, layout.to_field = (a, b) if va <= vb else (b, a)
                elif versions:
                    layout.from_field = layout.to_field = versions[0]
                layout.symbol_field = 3
                return layout
        return layout

    # ------------------------------------------------------------- snapshot

    async def fetch_snapshot(self, symbol: str) -> Snapshot:
        """REST depth snapshot. Never awaited from the frame loop — the feed
        schedules it as a task so decoding continues while it is in flight."""
        if self.http is None:
            raise VenueError("no HTTP client bound to the feed")
        url = f"{self.spec.rest_base}{self.spec.snapshot_path}"
        data = await self.http.get_json(url, {"symbol": symbol,
                                              "limit": self.spec.snapshot_limit})
        if not isinstance(data, dict):
            raise VenueError(f"bad snapshot for {symbol}", data, retriable=True)
        bids = [(_num(p), _num(q)) for p, q in data.get("bids", [])]
        asks = [(_num(p), _num(q)) for p, q in data.get("asks", [])]
        return Snapshot(symbol, int(data.get("lastUpdateId") or 0),
                        [(p, q) for p, q in bids if p > 0 and q > 0],
                        [(p, q) for p, q in asks if p > 0 and q > 0], now_ns())


# -------------------------------------------------------------------- router

class MexcRouter:
    """REST order entry over a pre-warmed pool, fills from the private stream.

    `submit()` returns on the venue ack, which for MEXC carries only an order
    id. The fill arrives on `spot@private.deals` / `spot@private.orders` and
    resolves the future that `wait_fill()` is holding — so a leg completes one
    network hop after the match, not one poll interval.
    """

    def __init__(self, creds: MexcCredentials, http: Any, spec: VenueSpec = MEXC,
                 recv_window_ms: int | None = None) -> None:
        self.spec = spec
        self.creds = creds
        self.http = http
        self.recv_window = recv_window_ms or spec.recv_window_ms
        self._pending: dict[str, asyncio.Future] = {}
        self._results: dict[str, OrderResult] = {}
        self._fill_cbs: list[Callable[[FillEvent], None]] = []
        self._listen_key = ""
        self._ka_task: asyncio.Task | None = None
        self.submitted = 0
        self.rejected = 0

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        if not self.creds.armed:
            return                          # disarmed: paper path only
        self._listen_key = await self._create_listen_key()
        self._ka_task = asyncio.create_task(self._keepalive_loop(),
                                            name="mexc-listenkey-keepalive")

    async def close(self) -> None:
        if self._ka_task:
            self._ka_task.cancel()
            try:
                await self._ka_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()

    @property
    def listen_key(self) -> str:
        return self._listen_key

    def private_url(self) -> str:
        return f"{self.spec.ws_private}?listenKey={self._listen_key}"

    def private_channels(self) -> list[str]:
        suffix = ".pb" if self.spec.wire == "protobuf" else ""
        return [f"spot@private.orders.v3.api{suffix}",
                f"spot@private.deals.v3.api{suffix}",
                f"spot@private.account.v3.api{suffix}"]

    async def _create_listen_key(self) -> str:
        d = await self._signed("POST", "/api/v3/userDataStream", {})
        key = (d or {}).get("listenKey", "")
        if not key:
            raise VenueError("could not create listenKey", d)
        return key

    async def _keepalive_loop(self) -> None:
        """MEXC expires a listenKey after 60 minutes; refresh well inside that.

        A dead key does not raise — it simply stops delivering fills, which
        would strand a leg chain waiting on a push that never comes. Hence the
        generous margin and the re-create on failure.
        """
        while True:
            await asyncio.sleep(1500)       # 25 min
            try:
                await self._signed("PUT", "/api/v3/userDataStream",
                                   {"listenKey": self._listen_key})
            except Exception:  # noqa: BLE001
                try:
                    self._listen_key = await self._create_listen_key()
                except Exception:  # noqa: BLE001
                    pass

    # ---------------------------------------------------------------- HTTP

    async def _signed(self, method: str, path: str, params: dict) -> Any:
        if not self.creds.armed:
            raise VenueError("router is disarmed (no API key)")
        p = {**params, "timestamp": wall_ms(), "recvWindow": self.recv_window}
        qs, sig = sign_query(self.creds.secret, p)
        url = f"{self.spec.rest_base}{path}?{qs}&signature={sig}"
        return await self.http.request_json(
            method, url, headers={"X-MEXC-APIKEY": self.creds.key})

    # --------------------------------------------------------------- orders

    async def submit(self, req: OrderRequest) -> OrderResult:
        """Send one IOC/FOK limit. Returns at the ack, not at the fill."""
        params = {
            "symbol": req.symbol,
            "side": req.side.wire,
            "type": _TIF_WIRE[req.tif],
            "quantity": _fmt(req.qty),
            "price": _fmt(req.price),
            "newClientOrderId": req.client_id,
        }
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req.client_id] = fut
        sent = now_ns()
        try:
            resp = await self._signed("POST", self.spec.order_path, params)
        except RateLimited:
            self._pending.pop(req.client_id, None)
            raise
        except Exception as e:  # noqa: BLE001
            self._pending.pop(req.client_id, None)
            raise VenueError(f"order send failed: {e}", None, retriable=False) from e
        ack = now_ns()
        self.submitted += 1
        if not isinstance(resp, dict) or resp.get("code") not in (None, 200, 0):
            self._pending.pop(req.client_id, None)
            self.rejected += 1
            raise OrderRejected(f"{req.symbol} rejected: {resp}", resp)
        oid = str(resp.get("orderId") or "")
        res = OrderResult(client_id=req.client_id, order_id=oid,
                          status=OrderStatus.NEW, sent_ns=sent, ack_ns=ack,
                          raw=resp)
        # Some responses do carry the fill; take it when present.
        if resp.get("executedQty") is not None:
            res.filled_base = _num(resp.get("executedQty"))
            res.filled_quote = _num(resp.get("cummulativeQuoteQty"))
            res.status = _STATUS.get(str(resp.get("status")), OrderStatus.NEW)
            if res.filled_base > 0:
                res.avg_price = res.filled_quote / res.filled_base
        self._results[req.client_id] = res
        if res.status.terminal and not fut.done():
            res.fill_ns = ack
            fut.set_result(res)
        return res

    async def wait_fill(self, client_id: str, timeout_s: float) -> OrderResult:
        """Await the private-stream push; fall back to one REST query.

        The REST fallback is a safety net for a dropped private socket, not the
        normal path. It costs a round trip, so if it starts firing regularly
        that is a feed bug to fix, not a latency budget to accept.
        """
        fut = self._pending.get(client_id)
        if fut is None:
            return self._results.get(client_id) or OrderResult(
                client_id, "", OrderStatus.UNKNOWN)
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout_s)
        except asyncio.TimeoutError:
            res = await self._query_fallback(client_id)
            self._pending.pop(client_id, None)
            return res
        finally:
            self._pending.pop(client_id, None)

    async def _query_fallback(self, client_id: str) -> OrderResult:
        base = self._results.get(client_id) or OrderResult(
            client_id, "", OrderStatus.UNKNOWN)
        try:
            d = await self._signed("GET", self.spec.order_path,
                                   {"symbol": _symbol_of(base), "origClientOrderId": client_id}
                                   if _symbol_of(base) else
                                   {"origClientOrderId": client_id})
        except Exception:  # noqa: BLE001
            return base
        if isinstance(d, dict) and d.get("orderId"):
            base.order_id = str(d["orderId"])
            base.filled_base = _num(d.get("executedQty"))
            base.filled_quote = _num(d.get("cummulativeQuoteQty"))
            base.status = _STATUS.get(str(d.get("status")), OrderStatus.UNKNOWN)
            base.fill_ns = now_ns()
            if base.filled_base > 0:
                base.avg_price = base.filled_quote / base.filled_base
        return base

    async def cancel(self, symbol: str, client_id: str) -> Any:
        return await self._signed("DELETE", self.spec.order_path,
                                  {"symbol": symbol, "origClientOrderId": client_id})

    async def balances(self) -> dict[str, float]:
        d = await self._signed("GET", "/api/v3/account", {})
        out: dict[str, float] = {}
        for b in (d or {}).get("balances", []):
            free = _num(b.get("free"))
            if free > 0:
                out[b.get("asset", "")] = free
        return out

    # ---------------------------------------------------------------- fills

    def on_fill(self, cb: Callable[[FillEvent], None]) -> None:
        self._fill_cbs.append(cb)

    def handle_private_frame(self, ev: FillEvent) -> None:
        """Route a decoded private-stream event to the waiting leg."""
        for cb in self._fill_cbs:
            try:
                cb(ev)
            except Exception:  # noqa: BLE001
                pass
        res = self._results.get(ev.client_id)
        if res is None:
            res = OrderResult(ev.client_id, ev.order_id, ev.status)
            self._results[ev.client_id] = res
        # Deals arrive per-trade; accumulate rather than overwrite, or a
        # two-print IOC reports only its second print.
        if ev.status is OrderStatus.PARTIAL or not res.status.terminal:
            res.filled_base = max(res.filled_base, ev.filled_base)
            res.filled_quote = max(res.filled_quote, ev.filled_quote)
        res.order_id = ev.order_id or res.order_id
        res.status = ev.status
        res.fee_asset = ev.fee_asset or res.fee_asset
        res.fee_amount = max(res.fee_amount, ev.fee_amount)
        res.fill_ns = ev.recv_ns or now_ns()
        if res.filled_base > 0:
            res.avg_price = res.filled_quote / res.filled_base
        fut = self._pending.get(ev.client_id)
        if fut is not None and not fut.done() and ev.status.terminal:
            fut.set_result(res)

    def decode_private(self, raw: str | bytes) -> list[FillEvent]:
        """Decode a private user-data frame into fill events.

        JSON shape is handled directly; protobuf frames go through the same
        structure-first reader as market data.
        """
        recv = now_ns()
        try:
            if isinstance(raw, (bytes, bytearray)) and raw[:1] not in (b"{", b"["):
                return self._decode_private_pb(bytes(raw), recv)
            text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
            msg = json.loads(text)
        except Exception:  # noqa: BLE001
            return []
        d = msg.get("d") if isinstance(msg, dict) else None
        if not isinstance(d, dict):
            return []
        cid = str(d.get("c") or d.get("clientOrderId") or "")
        if not cid:
            return []
        status = _STATUS.get(str(d.get("s") or d.get("status")), OrderStatus.UNKNOWN)
        filled = _num(d.get("cv") or d.get("executedQty"))
        amount = _num(d.get("ca") or d.get("cummulativeQuoteQty"))
        return [FillEvent(str(msg.get("s") or d.get("symbol") or ""), cid,
                          str(d.get("i") or d.get("orderId") or ""), status,
                          max(filled, 0.0), max(amount, 0.0),
                          str(d.get("N") or ""), max(_num(d.get("n")), 0.0),
                          int(msg.get("t") or 0), recv)]

    def _decode_private_pb(self, raw: bytes, recv: int) -> list[FillEvent]:
        try:
            top = pb.decode(raw)
        except pb.ProtobufError:
            return []
        symbol = pb.as_str(top.get(3))
        for _fno, vals in sorted(top.items()):
            for v in vals:
                if not isinstance(v, bytes) or len(v) < 4:
                    continue
                try:
                    body = pb.decode(v)
                except pb.ProtobufError:
                    continue
                strs = {f: pb.as_str(vs) for f, vs in body.items()
                        if isinstance(vs[0], bytes)}
                cid = next((s for s in strs.values()
                            if s.startswith(("arb-", "hedge-", "unwind-"))), "")
                if not cid:
                    continue
                nums = sorted((f, _num(s)) for f, s in strs.items() if _num(s) >= 0)
                filled = nums[0][1] if nums else 0.0
                quote = nums[1][1] if len(nums) > 1 else 0.0
                return [FillEvent(symbol, cid, "", OrderStatus.UNKNOWN,
                                  filled, quote, "", 0.0, 0, recv)]
        return []


def _fmt(x: float) -> str:
    """Fixed-point, no exponent — MEXC rejects `1e-05` outright."""
    return f"{x:.10f}".rstrip("0").rstrip(".") or "0"


def _symbol_of(res: OrderResult) -> str:
    raw = res.raw if isinstance(res.raw, dict) else {}
    return str(raw.get("symbol") or "")
