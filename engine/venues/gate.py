"""Gate.io spot adapter: `spot.order_book_update` feed + true WS order entry.

Gate is the venue where "private WS order routing" is literally achievable —
WS v4 exposes `spot.order_place`, so an order leaves over a socket that is
already open and authenticated. That removes the request-side TLS/HTTP framing
entirely, which is worth roughly one RTT versus even a warm keep-alive POST.

Sequencing differs from MEXC in a way the book must know about: Gate frames
carry `U` (first id) and `u` (last id) and **overlap is legal**, so the
acceptance rule is `U <= last_applied + 1 <= u` rather than strict equality.
That is `VenueSpec.strict_sequencing = False`.

Caveat worth stating plainly: the subscribe/auth envelope below follows Gate's
documented `channel=<channel>&event=<event>&time=<time>` HMAC-SHA512 scheme,
which is well specified. The `spot.order_place` request envelope is *less* well
documented publicly, so `GateRouter` ships with `ws_order_entry` gated behind
an explicit flag and a REST fallback that is known-good. Verify the WS envelope
against Gate's current docs before arming it — the failure mode of a wrong
envelope is a silently unplaced leg, which is the worst kind.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any, Callable, Iterable, Sequence

from ..book import Level
from ..clock import now_ns, wall_ms
from ..config import GATE, VenueSpec
from .base import (DepthFrame, FillEvent, OrderRejected, OrderRequest,
                   OrderResult, OrderStatus, Side, Snapshot, TimeInForce,
                   VenueError)

__all__ = ["GateFeed", "GateRouter", "GateCredentials", "ws_signature",
           "to_gate_pair", "from_gate_pair"]

_TIF_WIRE = {TimeInForce.IOC: "ioc", TimeInForce.FOK: "fok"}

_STATUS = {
    "open": OrderStatus.NEW,
    "closed": OrderStatus.FILLED,
    "cancelled": OrderStatus.CANCELED,
    "canceled": OrderStatus.CANCELED,
    "expired": OrderStatus.EXPIRED,
}


def to_gate_pair(symbol: str, base: str, quote: str) -> str:
    """`FOOUSDT` -> `FOO_USDT`. Gate underscores; MEXC concatenates."""
    return f"{base}_{quote}"


def from_gate_pair(pair: str) -> str:
    return pair.replace("_", "")


def ws_signature(secret: str, channel: str, event: str, ts: int) -> str:
    """Gate WS auth: HMAC-SHA512 over `channel=..&event=..&time=..`."""
    payload = f"channel={channel}&event={event}&time={ts}"
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha512).hexdigest()


class GateCredentials:
    __slots__ = ("key", "secret")

    def __init__(self, key: str, secret: str) -> None:
        self.key = key
        self.secret = secret

    @property
    def armed(self) -> bool:
        return bool(self.key and self.secret)


def _num(x: Any) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return -1.0


class GateFeed:
    """Decoder for `spot.order_book_update` (incremental) frames."""

    def __init__(self, spec: VenueSpec = GATE, symbol_map: dict[str, str] | None = None,
                 http: Any = None, interval: str = "100ms", depth: int = 20) -> None:
        self.spec = spec
        self.http = http
        self.interval = interval
        self.depth = depth
        # canonical (FOOUSDT) -> gate pair (FOO_USDT), both directions
        self.to_gate = dict(symbol_map or {})
        self.from_gate = {v: k for k, v in self.to_gate.items()}
        self.decode_errors = 0
        self.frames_decoded = 0

    def channels_for(self, symbols: Sequence[str]) -> list[str]:
        return [self.to_gate.get(s, s) for s in symbols]

    def subscribe_message(self, channels: Sequence[str]) -> str:
        # Gate takes one pair per subscribe payload for order_book_update.
        return json.dumps({
            "time": int(time.time()),
            "channel": self.spec.depth_channel,
            "event": "subscribe",
            "payload": [channels[0], self.interval] if len(channels) == 1
            else [c for c in channels],
        })

    def subscribe_messages(self, channels: Sequence[str]) -> list[str]:
        """One message per pair — the shape Gate actually accepts."""
        return [json.dumps({"time": int(time.time()),
                            "channel": self.spec.depth_channel,
                            "event": "subscribe",
                            "payload": [c, self.interval]}) for c in channels]

    def unsubscribe_message(self, channels: Sequence[str]) -> str:
        return json.dumps({"time": int(time.time()),
                           "channel": self.spec.depth_channel,
                           "event": "unsubscribe",
                           "payload": [channels[0], self.interval]})

    def ping_message(self) -> str:
        return json.dumps({"time": int(time.time()), "channel": "spot.ping"})

    def decode(self, raw: str | bytes) -> list[DepthFrame]:
        recv = now_ns()
        try:
            text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
            msg = json.loads(text)
        except Exception:  # noqa: BLE001
            self.decode_errors += 1
            return []
        if not isinstance(msg, dict) or msg.get("event") != "update":
            return []                        # subscribe ack / pong
        r = msg.get("result")
        if not isinstance(r, dict):
            return []
        pair = r.get("s") or ""
        symbol = self.from_gate.get(pair, from_gate_pair(pair))
        bids = [(_num(p), _num(q)) for p, q in (r.get("b") or [])]
        asks = [(_num(p), _num(q)) for p, q in (r.get("a") or [])]
        self.frames_decoded += 1
        return [DepthFrame(symbol, int(r.get("U") or 0), int(r.get("u") or 0),
                           [(p, q) for p, q in bids if p > 0 and q >= 0],
                           [(p, q) for p, q in asks if p > 0 and q >= 0],
                           int(r.get("t") or 0), False, recv)]

    async def fetch_snapshot(self, symbol: str) -> Snapshot:
        if self.http is None:
            raise VenueError("no HTTP client bound to the feed")
        pair = self.to_gate.get(symbol, symbol)
        url = f"{self.spec.rest_base}{self.spec.snapshot_path}"
        data = await self.http.get_json(url, {"currency_pair": pair,
                                              "limit": self.spec.snapshot_limit,
                                              "with_id": "true"})
        if not isinstance(data, dict):
            raise VenueError(f"bad snapshot for {symbol}", data, retriable=True)
        return Snapshot(symbol, int(data.get("id") or 0),
                        [(_num(p), _num(q)) for p, q in data.get("bids", [])],
                        [(_num(p), _num(q)) for p, q in data.get("asks", [])],
                        now_ns())


class GateRouter:
    """Order entry over the private WebSocket, with a REST fallback.

    `send_ws` is injected by the runtime once the private socket is up; until
    then (or when `use_ws=False`) every order takes the REST path, so a feed
    problem degrades latency instead of stopping trading.
    """

    def __init__(self, creds: GateCredentials, http: Any, spec: VenueSpec = GATE,
                 symbol_map: dict[str, str] | None = None, use_ws: bool = False) -> None:
        self.spec = spec
        self.creds = creds
        self.http = http
        self.use_ws = use_ws and spec.ws_order_entry
        self.to_gate = dict(symbol_map or {})
        self.send_ws: Callable[[str], Any] | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._results: dict[str, OrderResult] = {}
        self._fill_cbs: list[Callable[[FillEvent], None]] = []
        self._authed = False
        self.submitted = 0
        self.rejected = 0

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()

    # ------------------------------------------------------------------ auth

    def login_message(self) -> str:
        ts = int(time.time())
        return json.dumps({
            "time": ts, "channel": "spot.login", "event": "api",
            "payload": {"api_key": self.creds.key, "timestamp": str(ts),
                        "req_id": f"login-{ts}",
                        "signature": ws_signature(self.creds.secret,
                                                  "spot.login", "api", ts)},
        })

    def subscribe_orders_message(self, pairs: Sequence[str]) -> str:
        ts = int(time.time())
        return json.dumps({
            "time": ts, "channel": "spot.orders", "event": "subscribe",
            "payload": list(pairs),
            "auth": {"method": "api_key", "KEY": self.creds.key,
                     "SIGN": ws_signature(self.creds.secret, "spot.orders",
                                          "subscribe", ts)},
        })

    def mark_authed(self, ok: bool = True) -> None:
        self._authed = ok

    # ---------------------------------------------------------------- orders

    def _ws_order_message(self, req: OrderRequest) -> str:
        ts = int(time.time())
        pair = self.to_gate.get(req.symbol, req.symbol)
        return json.dumps({
            "time": ts, "channel": "spot.order_place", "event": "api",
            "payload": {
                "req_id": req.client_id,
                "req_param": {
                    "text": f"t-{req.client_id}",
                    "currency_pair": pair,
                    "type": "limit",
                    "account": "spot",
                    "side": req.side.wire.lower(),
                    "amount": _fmt(req.qty),
                    "price": _fmt(req.price),
                    "time_in_force": _TIF_WIRE[req.tif],
                },
            },
            "auth": {"method": "api_key", "KEY": self.creds.key,
                     "SIGN": ws_signature(self.creds.secret, "spot.order_place",
                                          "api", ts)},
        })

    async def submit(self, req: OrderRequest) -> OrderResult:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req.client_id] = fut
        sent = now_ns()
        if self.use_ws and self._authed and self.send_ws is not None:
            await self.send_ws(self._ws_order_message(req))
            self.submitted += 1
            return OrderResult(req.client_id, "", OrderStatus.NEW, sent_ns=sent,
                               ack_ns=now_ns())
        res = await self._rest_submit(req, sent)
        self._results[req.client_id] = res
        if res.status.terminal and not fut.done():
            fut.set_result(res)
        return res

    async def _rest_submit(self, req: OrderRequest, sent_ns: int) -> OrderResult:
        if not self.creds.armed:
            raise VenueError("gate router is disarmed (no API key)")
        pair = self.to_gate.get(req.symbol, req.symbol)
        body = {"currency_pair": pair, "type": "limit", "account": "spot",
                "side": req.side.wire.lower(), "amount": _fmt(req.qty),
                "price": _fmt(req.price), "time_in_force": _TIF_WIRE[req.tif],
                "text": f"t-{req.client_id}"}
        payload = json.dumps(body)
        headers = self._rest_headers("POST", "/api/v4" + self.spec.order_path, "", payload)
        resp = await self.http.request_json(
            "POST", f"{self.spec.rest_base}{self.spec.order_path}",
            headers=headers, data=payload)
        self.submitted += 1
        if not isinstance(resp, dict) or resp.get("id") is None:
            self.rejected += 1
            raise OrderRejected(f"{req.symbol} rejected: {resp}", resp)
        filled = _num(resp.get("filled_amount") or resp.get("filled_total") and 0)
        base_filled = max(_num(resp.get("filled_amount")), 0.0)
        quote_filled = max(_num(resp.get("filled_total")), 0.0)
        res = OrderResult(req.client_id, str(resp["id"]),
                          _STATUS.get(str(resp.get("status")), OrderStatus.UNKNOWN),
                          base_filled, quote_filled,
                          sent_ns=sent_ns, ack_ns=now_ns(), fill_ns=now_ns(),
                          raw=resp)
        if res.filled_base > 0:
            res.avg_price = res.filled_quote / res.filled_base
        return res

    def _rest_headers(self, method: str, path: str, query: str, body: str) -> dict:
        """Gate REST v4 signing: SHA-512 body hash inside an HMAC-SHA512."""
        ts = str(int(time.time()))
        body_hash = hashlib.sha512(body.encode()).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{body_hash}\n{ts}"
        sign = hmac.new(self.creds.secret.encode(), payload.encode(),
                        hashlib.sha512).hexdigest()
        return {"KEY": self.creds.key, "SIGN": sign, "Timestamp": ts,
                "Content-Type": "application/json", "Accept": "application/json"}

    async def wait_fill(self, client_id: str, timeout_s: float) -> OrderResult:
        fut = self._pending.get(client_id)
        if fut is None:
            return self._results.get(client_id) or OrderResult(
                client_id, "", OrderStatus.UNKNOWN)
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout_s)
        except asyncio.TimeoutError:
            return self._results.get(client_id) or OrderResult(
                client_id, "", OrderStatus.UNKNOWN)
        finally:
            self._pending.pop(client_id, None)

    async def balances(self) -> dict[str, float]:
        headers = self._rest_headers("GET", "/api/v4/spot/accounts", "", "")
        d = await self.http.request_json(
            "GET", f"{self.spec.rest_base}/spot/accounts", headers=headers)
        out: dict[str, float] = {}
        for row in d or []:
            v = _num(row.get("available"))
            if v > 0:
                out[row.get("currency", "")] = v
        return out

    def on_fill(self, cb: Callable[[FillEvent], None]) -> None:
        self._fill_cbs.append(cb)

    def handle_private_frame(self, raw: str | bytes) -> list[FillEvent]:
        """Decode a `spot.orders` push or a `spot.order_place` API reply."""
        recv = now_ns()
        try:
            text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
            msg = json.loads(text)
        except Exception:  # noqa: BLE001
            return []
        if not isinstance(msg, dict):
            return []
        channel = msg.get("channel", "")
        rows: list[dict] = []
        if channel == "spot.orders" and msg.get("event") == "update":
            rows = [r for r in (msg.get("result") or []) if isinstance(r, dict)]
        elif channel in ("spot.order_place", "spot.login"):
            ack = (msg.get("result") or {})
            if channel == "spot.login":
                self.mark_authed(not ack.get("errs"))
                return []
            data = ack.get("data") or {}
            row = data.get("result") if isinstance(data, dict) else None
            if isinstance(row, dict):
                rows = [row]
        events: list[FillEvent] = []
        for r in rows:
            text_id = str(r.get("text") or "")
            cid = text_id[2:] if text_id.startswith("t-") else text_id
            ev = FillEvent(
                from_gate_pair(str(r.get("currency_pair") or "")), cid,
                str(r.get("id") or ""),
                _STATUS.get(str(r.get("status")), OrderStatus.UNKNOWN),
                max(_num(r.get("filled_amount")), 0.0),
                max(_num(r.get("filled_total")), 0.0),
                str(r.get("fee_currency") or ""), max(_num(r.get("fee")), 0.0),
                int(_num(r.get("update_time")) or 0), recv)
            events.append(ev)
            self._apply(ev)
        return events

    def _apply(self, ev: FillEvent) -> None:
        for cb in self._fill_cbs:
            try:
                cb(ev)
            except Exception:  # noqa: BLE001
                pass
        res = self._results.get(ev.client_id)
        if res is None:
            res = OrderResult(ev.client_id, ev.order_id, ev.status)
            self._results[ev.client_id] = res
        res.filled_base = max(res.filled_base, ev.filled_base)
        res.filled_quote = max(res.filled_quote, ev.filled_quote)
        res.status = ev.status
        res.order_id = ev.order_id or res.order_id
        res.fill_ns = ev.recv_ns
        if res.filled_base > 0:
            res.avg_price = res.filled_quote / res.filled_base
        fut = self._pending.get(ev.client_id)
        if fut is not None and not fut.done() and ev.status.terminal:
            fut.set_result(res)


def _fmt(x: float) -> str:
    return f"{x:.10f}".rstrip("0").rstrip(".") or "0"
