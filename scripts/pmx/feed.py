#!/usr/bin/env python3
"""Sub-second detection of tracked wallets' fills, from two independent feeds.

Everything below was verified against Polygon mainnet and the live APIs on
2026-08-13; the notes matter because most published guidance is stale.

  The CLOB user WebSocket cannot do this job. Its docs are explicit -- "the
  user stream delivers order changes and trade updates for the authenticated
  account" -- so it shows you your own fills and nobody else's. Watching other
  wallets in real time means reading the chain.

  The exchange moved. The address in most guides, 0x4bFb41d5..., produced 32
  logs in a ten-minute sample; the live contract 0xE111... produced 29,138 in
  the same window, and the Neg Risk exchange another 6,051. An engine pointed
  at the old address sees essentially nothing and reports no error.

  The event signature changed with it. The current OrderFilled is
      OrderFilled(bytes32 indexed orderHash, address indexed maker,
                  address indexed taker, uint8 side, uint256 tokenId,
                  uint256 makerAmountFilled, uint256 takerAmountFilled,
                  uint256 fee, bytes32 builder, bytes32 metadata)
  topic0 = 0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee
  confirmed as the dominant topic on both exchanges. The older 8-parameter
  form hashes to a topic that no longer appears.

  `maker` is the wallet. Sampling live logs and resolving each maker against
  the data API returned an account for 6 of 6, with matching prices seconds
  apart -- the field is the same proxyWallet the leaderboards and /activity
  key on. Both sides of a match emit their own OrderFilled (the counterparty
  shows the exchange itself as `taker`), so indexing on `maker` alone catches
  a tracked wallet whether it took or made.

  The global /trades feed is far staler than it looks, and this is the
  finding that matters most for edge decay. Measured against block time on
  2026-08-13:

      data-api /trades   (global)      260s behind the chain
      data-api /activity (per wallet)    4-14s behind the chain
      Polygon eth_getLogs                 0-2s (one block)

  The timestamps /trades returns are correct -- they match block time to the
  second -- but the endpoint serves a cached window minutes old and does not
  advance between rapid polls (three polls two seconds apart returned the
  same rows, ageing 224.9s -> 227.0s -> 229.1s). Polling it every 30s does
  not give 30s detection; it gives roughly four minutes, before any consensus
  logic runs. The per-wallet /activity endpoint does not have this problem,
  which is why the REST reconciler below is built on /activity and the global
  feed is not used for detection at all.

The REST feed stays alongside the chain as the reconciler: it carries titles
and condition ids for free, so it backfills metadata and catches anything a
dropped connection missed.
"""
import json
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

import requests

import pmlib

CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B"
NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59"
ORDER_FILLED_TOPIC = ("0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba9"
                      "0b1a89f2ea84d8ee")
USDC_DECIMALS = 6
SHARE_DECIMALS = 6

TOKEN_CACHE = os.path.join(pmlib.CACHE_DIR, "tokens.json")


@dataclass
class Fill:
    """One tracked wallet's fill, normalized across both feeds."""

    wallet: str
    timestamp: int
    token_id: str
    side: str                    # "BUY" | "SELL"
    price: float
    shares: float
    usdc: float
    source: str                  # "chain" | "rest"
    tx: str = ""
    condition_id: str = ""
    outcome_index: int = None
    title: str = ""
    slug: str = ""
    event_slug: str = ""
    detected_at: float = 0.0

    @property
    def key(self):
        """Identity stable across both feeds, for deduplication."""
        return (self.wallet.lower(), self.tx.lower(), self.token_id,
                self.side, round(self.shares, 4))

    @property
    def latency_s(self):
        return max(0.0, (self.detected_at or 0) - self.timestamp)


# ------------------------------------------------------------- token lookup

class TokenMap:
    """tokenId -> market identity, cached on disk.

    On-chain logs name a tokenId and nothing else, so this is what turns a
    log line into "wallet X bought No on market Y". Gamma resolves it via
    ?clob_token_ids=<id>, verified working.
    """

    def __init__(self, path=TOKEN_CACHE):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path) as f:
                self.cache = json.load(f)
        except (OSError, ValueError):
            self.cache = {}
        self._lock = threading.Lock()

    def save(self):
        with self._lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.cache, f)
            os.replace(tmp, self.path)

    def get(self, token_id):
        hit = self.cache.get(token_id)
        if hit is not None:
            return hit or None
        rows = pmlib.get_json(f"{pmlib.GAMMA_API}/markets",
                              {"clob_token_ids": token_id})
        if not rows:
            self.cache[token_id] = {}          # negative cache; retried on reload
            return None
        m = rows[0]
        try:
            tokens = json.loads(m.get("clobTokenIds") or "[]")
            outcomes = json.loads(m.get("outcomes") or "[]")
        except (ValueError, TypeError):
            tokens, outcomes = [], []
        idx = tokens.index(token_id) if token_id in tokens else None
        entry = {
            "conditionId": m.get("conditionId"),
            "outcomeIndex": idx,
            "outcome": outcomes[idx] if idx is not None and idx < len(outcomes) else None,
            "outcomes": outcomes,
            "question": m.get("question"),
            "slug": m.get("slug"),
            "endDate": m.get("endDate"),
            "negRisk": bool(m.get("negRisk")),
        }
        self.cache[token_id] = entry
        return entry

    def prime(self, token_ids):
        for t in token_ids:
            self.get(t)
        self.save()


def resolve_outcome_index(trade, outcomes):
    """Repair the data API's outcomeIndex, which is often a 999 sentinel.

    999 is a placeholder, not an index. Consuming it as one buckets flow under
    an outcome that does not exist, and every downstream price lookup then
    fails the `index < len(prices)` test and drops the signal without a word.

    Its frequency is bursty and depends on which markets happen to be active:
    two samples of the global /trades feed minutes apart measured 54% and 2.8%
    of rows, the high one dominated by the 5-minute BTC up/down markets. The
    per-wallet /activity endpoint returned 0 of 1,800 rows affected, which is
    one more reason the reconciler is built on it. The outcome NAME is always
    present, so that is what gets trusted.
    """
    idx = trade.get("outcomeIndex")
    if isinstance(idx, int) and 0 <= idx < max(1, len(outcomes or [])):
        return idx
    name = (trade.get("outcome") or "").strip().lower()
    for i, o in enumerate(outcomes or []):
        if str(o).strip().lower() == name:
            return i
    return None


# ------------------------------------------------------------ on-chain feed

def decode_order_filled(log):
    """Decode one v2 OrderFilled log into direction, price and size.

    USDC and outcome tokens are both 6-decimal, so the ratio of the two
    filled amounts is the price directly. For a BUY (side 0) the maker pays
    USDC and receives shares; for a SELL the legs swap.
    """
    topics = log.get("topics") or []
    if len(topics) < 4:
        return None
    data = (log.get("data") or "0x")[2:]
    words = [int(data[i:i + 64], 16) for i in range(0, len(data), 64)]
    if len(words) < 5:
        return None
    side_raw, token_id, maker_amt, taker_amt = words[0], words[1], words[2], words[3]
    if maker_amt == 0 or taker_amt == 0:
        return None
    if side_raw == 0:                                   # BUY
        side, usdc, shares = "BUY", maker_amt / 1e6, taker_amt / 1e6
    else:                                               # SELL
        side, usdc, shares = "SELL", taker_amt / 1e6, maker_amt / 1e6
    if shares <= 0:
        return None
    return {
        "wallet": "0x" + topics[2][-40:],
        "counterparty": "0x" + topics[3][-40:],
        "token_id": str(token_id),
        "side": side,
        "price": usdc / shares,
        "shares": shares,
        "usdc": usdc,
        "fee": words[4] / 1e6,
        "tx": log.get("transactionHash") or "",
        "block": int(log.get("blockNumber", "0x0"), 16),
    }


class OnChainFeed:
    """Polls Polygon logs for the tracked wallets' fills.

    Polygon blocks are ~2s, so a 1s poll of eth_getLogs detects a fill within
    about a block -- the same latency a WebSocket subscription gives, without
    the extra dependency or the silent-death failure mode of a dropped
    socket. Set `ws_url` to use eth_subscribe instead where the extra
    fraction of a second matters and `websockets` is installed.
    """

    # Stay this many blocks behind the reported head. Public RPC endpoints
    # are load-balanced pools whose members index at slightly different
    # speeds, so a query whose toBlock is the head that one node just
    # reported is rejected by another with "invalid block range params".
    # Observed directly: a 2-block window ending at the head failed while a
    # 3-block window ending one block earlier succeeded, repeatedly.
    SAFETY_BLOCKS = 2
    # Never ask for more than this in one request. Polymarket produces
    # ~70,000 OrderFilled logs per 1,000 blocks, so an unbounded catch-up
    # after a stall would return tens of megabytes and time out.
    MAX_RANGE = 200

    def __init__(self, rpc_url, watch_set, token_map=None, lookback_blocks=12,
                 session=None):
        self.rpc = rpc_url
        self.watch = {w.lower() for w in watch_set}
        self.tokens = token_map or TokenMap()
        self.lookback = lookback_blocks
        self.s = session or requests.Session()
        self.last_block = None
        self._id = 0

    def _rpc(self, method, params):
        self._id += 1
        r = self.s.post(self.rpc, json={"jsonrpc": "2.0", "id": self._id,
                                        "method": method, "params": params},
                        timeout=30)
        r.raise_for_status()
        out = r.json()
        if "error" in out:
            raise RuntimeError(out["error"])
        return out["result"]

    def block_number(self):
        return int(self._rpc("eth_blockNumber", []), 16)

    def poll(self):
        """Fills from tracked wallets since the last poll."""
        head = self.block_number() - self.SAFETY_BLOCKS
        if self.last_block is None:
            self.last_block = max(0, head - self.lookback)
        if head <= self.last_block:
            return []
        frm = self.last_block + 1
        to = min(head, frm + self.MAX_RANGE - 1)
        logs = self._rpc("eth_getLogs", [{
            "fromBlock": hex(frm), "toBlock": hex(to),
            "address": [CTF_EXCHANGE, NEG_RISK_EXCHANGE],
            "topics": [ORDER_FILLED_TOPIC],
        }])
        # Advance only as far as we actually read, so a capped range is
        # resumed on the next poll rather than skipped.
        self.last_block = to
        now = time.time()
        out = []
        for log in logs:
            wallet = "0x" + (log.get("topics") or ["", "", ""])[2][-40:]
            if wallet.lower() not in self.watch:
                continue
            d = decode_order_filled(log)
            if not d:
                continue
            meta = self.tokens.get(d["token_id"]) or {}
            out.append(Fill(
                wallet=d["wallet"], timestamp=int(now), token_id=d["token_id"],
                side=d["side"], price=d["price"], shares=d["shares"],
                usdc=d["usdc"], source="chain", tx=d["tx"],
                condition_id=meta.get("conditionId") or "",
                outcome_index=meta.get("outcomeIndex"),
                title=meta.get("question") or "",
                slug=meta.get("slug") or "", detected_at=now))
        if out:
            self.tokens.save()
        return out


# ---------------------------------------------------------------- REST feed

class DataApiFeed:
    """The reconciler, built on per-wallet /activity rather than /trades.

    One request per tracked wallet is more calls than a single global page,
    but the global page is minutes stale (see the module docstring) and this
    one is seconds fresh. For a 60-wallet list at eight threads that is a
    couple of seconds per sweep, which is the right trade: the whole point of
    the redesign is that detection lag is the dominant cost.
    """

    def __init__(self, watch_set, token_map=None, workers=8, limit=100):
        self.watch = sorted({w.lower() for w in watch_set})
        self.tokens = token_map or TokenMap()
        self.workers, self.limit = workers, limit
        self.last_ts = {w: int(time.time()) for w in self.watch}

    def _one(self, wallet):
        since = self.last_ts.get(wallet, 0)
        rows = pmlib.get_json(f"{pmlib.DATA_API}/activity",
                              {"user": wallet, "limit": self.limit,
                               "type": "TRADE", "sortBy": "TIMESTAMP",
                               "sortDirection": "DESC"}) or []
        now = time.time()
        out, newest = [], since
        for t in rows:
            ts = t.get("timestamp") or 0
            newest = max(newest, ts)
            if ts <= since:
                break                      # rows are newest-first
            token_id = str(t.get("asset") or "")
            meta = self.tokens.get(token_id) if token_id else {}
            meta = meta or {}
            outcomes = meta.get("outcomes")
            if not outcomes and t.get("conditionId"):
                m = pmlib.MarketResolver().get(t["conditionId"]) or {}
                outcomes = m.get("outcomes")
            oi = resolve_outcome_index(t, outcomes)
            size = t.get("size") or 0.0
            price = t.get("price") or 0.0
            out.append(Fill(
                wallet=wallet, timestamp=ts, token_id=token_id,
                side=t.get("side") or "BUY", price=price, shares=size,
                usdc=(t.get("usdcSize") or size * price), source="rest",
                tx=t.get("transactionHash") or "",
                condition_id=t.get("conditionId") or meta.get("conditionId") or "",
                outcome_index=oi, title=t.get("title") or "",
                slug=t.get("slug") or meta.get("slug") or "",
                event_slug=t.get("eventSlug") or "", detected_at=now))
        self.last_ts[wallet] = newest
        return out

    def prime(self, at=None):
        """Mark everything up to now as already seen.

        Call this after backfilling history. Without it the first poll
        replays every fill that landed while the seed was running -- a couple
        of minutes for 60 wallets -- and reports them as freshly detected,
        which poisons the measured latency the dashboard publishes.
        """
        now = int(at or time.time())
        self.last_ts = {w: now for w in self.watch}

    def poll(self):
        from concurrent.futures import ThreadPoolExecutor
        fresh = []
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            for rows in ex.map(self._one, self.watch):
                fresh.extend(rows)
        return fresh


# -------------------------------------------------------------- dual feed

class DualFeed:
    """Both feeds, deduplicated, newest wins on metadata.

    The chain is the trigger and the REST feed is the safety net. A fill seen
    on both is emitted once, from whichever arrived first, with any missing
    condition id or title backfilled from the REST copy.
    """

    def __init__(self, watch_set, rpc_url=None, dedupe_size=20000):
        self.tokens = TokenMap()
        self.chain = OnChainFeed(rpc_url, watch_set, self.tokens) if rpc_url else None
        self.rest = DataApiFeed(watch_set, self.tokens)
        self.seen = OrderedDict()
        self.dedupe_size = dedupe_size
        self.stats = {"chain": 0, "rest": 0, "duplicates": 0,
                      "chainLatency": [], "restLatency": []}

    def _remember(self, fill):
        if fill.key in self.seen:
            self.stats["duplicates"] += 1
            return False
        self.seen[fill.key] = fill.timestamp
        while len(self.seen) > self.dedupe_size:
            self.seen.popitem(last=False)
        return True

    def poll(self):
        out = []
        if self.chain:
            try:
                for f in self.chain.poll():
                    if self._remember(f):
                        self.stats["chain"] += 1
                        out.append(f)
            except Exception as e:                        # noqa: BLE001
                print(f"  chain feed error (falling back to REST): {e}",
                      flush=True)
        try:
            for f in self.rest.poll():
                if self._remember(f):
                    self.stats["rest"] += 1
                    self.stats["restLatency"].append(f.latency_s)
                    out.append(f)
        except Exception as e:                            # noqa: BLE001
            print(f"  rest feed error: {e}", flush=True)
        out.sort(key=lambda f: f.timestamp)
        return out

    def summary(self):
        lat = self.stats["restLatency"][-200:]
        return {"chainFills": self.stats["chain"],
                "restFills": self.stats["rest"],
                "duplicatesSuppressed": self.stats["duplicates"],
                "restMedianLatencyS": (sorted(lat)[len(lat) // 2] if lat else None)}
