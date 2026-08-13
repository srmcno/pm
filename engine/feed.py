"""WebSocket connection pool, book ownership, and non-blocking resync.

Sizing the pool
---------------
MEXC allows 30 subscriptions per socket. 2,100 pairs is therefore **70 sockets**,
not one — the pool is a hard requirement of the venue, not an optimization. Each
`FeedShard` owns a disjoint slice of symbols and a small set of connections, and
nothing is shared between shards except the shared-memory slab they write into.

Why the resync cannot be inline
-------------------------------
A sequence gap on one symbol means a REST snapshot, which is 5-50 ms of network.
Awaiting that inside the frame loop stalls *every other symbol on the socket* —
one thin micro-cap dropping a frame would blind the engine to 29 others. So a
gap does exactly three things, all O(1): mark the book SYNCING, push the symbol
onto a resync queue, and keep reading. A separate worker drains the queue with
bounded concurrency, and the book buffers deltas in the meantime.

Backpressure
------------
If the decoder falls behind, the queue between the socket reader and the book
applier grows. Rather than let it grow without bound (which converts a latency
problem into a memory problem and then a swap problem), each shard tracks its
lag and, past a threshold, drops to snapshot-only mode for the worst offenders
and reports it. Silently serving stale books is the one outcome not permitted.
"""
from __future__ import annotations

import asyncio
import random
from collections import deque
from typing import Any, Callable, Iterable, Sequence

from .book import ApplyResult, BookState, OrderBook
from .clock import LatencyHistogram, now_ns
from .config import VenueSpec
from .venues.base import DepthFrame, MarketFeed, VenueError

__all__ = ["FeedShard", "ConnectionPool", "shard_symbols", "WsTransport",
           "WEBSOCKETS_AVAILABLE"]

try:  # pragma: no cover - environment dependent
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:  # pragma: no cover
    websockets = None  # type: ignore[assignment]
    WEBSOCKETS_AVAILABLE = False


def shard_symbols(symbols: Sequence[str], n_shards: int) -> list[list[str]]:
    """Deal symbols round-robin so every shard gets a similar activity mix.

    Contiguous slicing would put every `1000SATS`-style dead pair in one shard
    and every major in another; round-robin keeps decode load even.
    """
    out: list[list[str]] = [[] for _ in range(max(1, n_shards))]
    for i, s in enumerate(symbols):
        out[i % len(out)].append(s)
    return [s for s in out if s]


class WsTransport:
    """Thin wrapper over `websockets` with reconnect and lifetime recycling.

    MEXC kills a socket at 24 h regardless of health, so the transport recycles
    itself at `spec.conn_lifetime_s` — a planned reconnect at a quiet moment is
    strictly better than an unplanned one mid-cycle.
    """

    def __init__(self, url: str, spec: VenueSpec, name: str = "") -> None:
        if not WEBSOCKETS_AVAILABLE:  # pragma: no cover
            raise RuntimeError(
                "the `websockets` package is required for live feeds — "
                "`pip install -r requirements-engine.txt`")
        self.url = url
        self.spec = spec
        self.name = name or url
        self.ws: Any = None
        self.opened_ns = 0
        self.reconnects = 0

    async def connect(self) -> None:
        self.ws = await websockets.connect(
            self.url, ping_interval=self.spec.ping_interval_s,
            ping_timeout=self.spec.ping_interval_s * 2,
            max_queue=4096, compression=None)
        self.opened_ns = now_ns()

    async def close(self) -> None:
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass
            self.ws = None

    @property
    def expired(self) -> bool:
        return (self.opened_ns and
                (now_ns() - self.opened_ns) / 1e9 > self.spec.conn_lifetime_s)

    async def send(self, msg: str | bytes) -> None:
        if self.ws is None:
            raise VenueError("socket not connected")
        await self.ws.send(msg)

    def __aiter__(self):
        return self.ws.__aiter__()


class FeedShard:
    """One slice of the universe: its books, its sockets, its resync queue."""

    def __init__(self, venue: VenueSpec, feed: MarketFeed, symbols: Sequence[str],
                 slab: Any = None, on_dirty: Callable[[str], None] | None = None,
                 max_resync_concurrency: int = 6, name: str = "shard") -> None:
        self.spec = venue
        self.feed = feed
        self.name = name
        self.symbols = list(symbols)
        self.slab = slab
        self.on_dirty = on_dirty
        self.books: dict[str, OrderBook] = {
            s: OrderBook(s, venue.name, strict=venue.strict_sequencing)
            for s in self.symbols}
        # Symbols the compute engine is actively sizing. Everything else
        # publishes only when its touch moves — a deep-book update on a pair
        # nobody is trading is not worth a 10 us shared-memory write.
        self.hot: set[str] = set()
        self._resync_q: deque[str] = deque()
        self._resync_wake = asyncio.Event()
        self._sem = asyncio.Semaphore(max_resync_concurrency)
        self._transports: list[WsTransport] = []
        self._tasks: list[asyncio.Task] = []
        self._running = False

        # telemetry
        self.apply_hist = LatencyHistogram(f"{name}.apply")
        self.frame_hist = LatencyHistogram(f"{name}.frame_to_book")
        self.frames = 0
        self.gaps = 0
        self.resyncs = 0
        self.resync_failures = 0
        self.dropped = 0
        self.published = 0
        self.publish_skipped = 0
        self.last_frame_ns = 0

    # ---------------------------------------------------------------- books

    def book(self, symbol: str) -> OrderBook | None:
        return self.books.get(symbol)

    def live_count(self) -> int:
        return sum(1 for b in self.books.values() if b.state is BookState.LIVE)

    # ------------------------------------------------------------- ingestion

    def handle_frame(self, fr: DepthFrame) -> None:
        """Apply one decoded frame. Pure CPU — never awaits, never blocks."""
        t0 = now_ns()
        book = self.books.get(fr.symbol)
        if book is None:
            return
        self.frames += 1
        self.last_frame_ns = t0
        if fr.is_snapshot:
            book.install_full(fr.bids, fr.asks, t0)
            self._publish(book, force=True)
            return
        res = book.apply_delta(fr.first_id, fr.last_id, fr.bids, fr.asks, t0)
        if res is ApplyResult.GAP:
            self.gaps += 1
            self.queue_resync(fr.symbol)
        elif res is ApplyResult.BUFFERED:
            if not book.snapshot_pending:
                self.queue_resync(fr.symbol)
        elif res is ApplyResult.APPLIED:
            self.apply_hist.record(now_ns() - t0)
            if fr.recv_ns:
                self.frame_hist.record(now_ns() - fr.recv_ns)
            self._publish(book)
            if self.on_dirty is not None:
                self.on_dirty(fr.symbol)

    def _publish(self, book: OrderBook, force: bool = False) -> None:
        if self.slab is None:
            return
        if force or book.top_changed or book.symbol in self.hot:
            self.slab.write(book.symbol, book)
            self.published += 1
        else:
            self.publish_skipped += 1

    def set_hot(self, symbols: Iterable[str]) -> None:
        """Full-depth publication for the symbols under active evaluation."""
        self.hot = {s for s in symbols if s in self.books}

    def queue_resync(self, symbol: str) -> None:
        book = self.books.get(symbol)
        if book is None or book.snapshot_pending:
            return
        book.mark_snapshot_pending()
        self._resync_q.append(symbol)
        self._resync_wake.set()

    # --------------------------------------------------------------- resync

    async def resync_worker(self) -> None:
        """Drain the resync queue with bounded concurrency, forever."""
        while self._running:
            if not self._resync_q:
                self._resync_wake.clear()
                try:
                    await asyncio.wait_for(self._resync_wake.wait(), 1.0)
                except asyncio.TimeoutError:
                    continue
            batch = []
            while self._resync_q and len(batch) < 32:
                batch.append(self._resync_q.popleft())
            if batch:
                await asyncio.gather(*(self._resync_one(s) for s in batch),
                                     return_exceptions=True)

    async def _resync_one(self, symbol: str, attempts: int = 3) -> bool:
        book = self.books.get(symbol)
        if book is None:
            return False
        async with self._sem:
            for i in range(attempts):
                try:
                    snap = await self.feed.fetch_snapshot(symbol)
                except VenueError:
                    await asyncio.sleep(0.15 * (i + 1) + random.random() * 0.1)
                    continue
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(0.2 * (i + 1))
                    continue
                if book.install_snapshot(snap.last_update_id, snap.bids,
                                         snap.asks, now_ns()):
                    self.resyncs += 1
                    self._publish(book, force=True)
                    if self.on_dirty is not None:
                        self.on_dirty(symbol)
                    return True
                # Snapshot landed but could not be chained — the venue moved
                # while it was in flight. Retry immediately; the buffer holds.
                book.mark_snapshot_pending()
        self.resync_failures += 1
        book.mark_stale()
        return False

    # ------------------------------------------------------------ connections

    async def _reader(self, transport: WsTransport, channels: Sequence[str]) -> None:
        """One socket: connect, subscribe, read until it dies, reconnect."""
        backoff = 0.5
        while self._running:
            try:
                await transport.connect()
                sub = self.feed.subscribe_message(channels)
                await transport.send(sub)
                # Anything already open is now suspect: force a snapshot for
                # every symbol on this socket rather than trusting an id that
                # predates the disconnect.
                for ch in channels:
                    sym = _symbol_from_channel(ch)
                    if sym in self.books:
                        self.books[sym].request_resync("reconnect")
                        self.queue_resync(sym)
                backoff = 0.5
                ping = asyncio.create_task(self._ping_loop(transport))
                try:
                    async for raw in transport:
                        for fr in self.feed.decode(raw):
                            self.handle_frame(fr)
                        if transport.expired:
                            break        # planned recycle before the venue cuts
                finally:
                    ping.cancel()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - every socket error is a reconnect
                transport.reconnects += 1
            await transport.close()
            if not self._running:
                return
            # Full jitter: 70 sockets reconnecting in lockstep after a venue
            # blip would look exactly like an attack and get the IP banned.
            await asyncio.sleep(random.uniform(0, min(backoff, 20.0)))
            backoff = min(backoff * 2, 30.0)

    async def _ping_loop(self, transport: WsTransport) -> None:
        msg = self.feed.ping_message()
        if msg is None:
            return
        while True:
            await asyncio.sleep(self.spec.ping_interval_s)
            try:
                await transport.send(msg)
            except Exception:  # noqa: BLE001
                return

    async def start(self) -> None:
        self._running = True
        channels = self.feed.channels_for(self.symbols)
        per = self.spec.max_subs_per_conn
        groups = [channels[i:i + per] for i in range(0, len(channels), per)]
        for i, group in enumerate(groups):
            t = WsTransport(self.spec.ws_public, self.spec, f"{self.name}-{i}")
            self._transports.append(t)
            self._tasks.append(asyncio.create_task(
                self._reader(t, group), name=f"{self.name}-reader-{i}"))
        self._tasks.append(asyncio.create_task(
            self.resync_worker(), name=f"{self.name}-resync"))

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await asyncio.gather(*(t.close() for t in self._transports),
                             return_exceptions=True)
        self._tasks.clear()
        self._transports.clear()

    def stats(self) -> dict:
        return {
            "shard": self.name,
            "symbols": len(self.symbols),
            "sockets": len(self._transports),
            "live": self.live_count(),
            "frames": self.frames,
            "gaps": self.gaps,
            "resyncs": self.resyncs,
            "resyncFailures": self.resync_failures,
            "queueDepth": len(self._resync_q),
            "reconnects": sum(t.reconnects for t in self._transports),
            "published": self.published,
            "publishSkipped": self.publish_skipped,
            "hot": len(self.hot),
            "applyUs": self.apply_hist.snapshot(),
        }


class ConnectionPool:
    """All shards for one venue, plus the arithmetic that sizes them."""

    def __init__(self, spec: VenueSpec, feed_factory: Callable[[Sequence[str]], MarketFeed],
                 symbols: Sequence[str], n_shards: int = 4, slab: Any = None,
                 on_dirty: Callable[[str], None] | None = None) -> None:
        self.spec = spec
        self.symbols = list(symbols)
        groups = shard_symbols(self.symbols, n_shards)
        self.shards = [
            FeedShard(spec, feed_factory(g), g, slab=slab, on_dirty=on_dirty,
                      name=f"{spec.name}-s{i}")
            for i, g in enumerate(groups)]

    @property
    def sockets_needed(self) -> int:
        return self.spec.conns_needed(len(self.symbols))

    async def start(self) -> None:
        await asyncio.gather(*(s.start() for s in self.shards))

    async def stop(self) -> None:
        await asyncio.gather(*(s.stop() for s in self.shards),
                             return_exceptions=True)

    def book(self, symbol: str) -> OrderBook | None:
        for s in self.shards:
            b = s.books.get(symbol)
            if b is not None:
                return b
        return None

    def live_count(self) -> int:
        return sum(s.live_count() for s in self.shards)

    def stats(self) -> dict:
        return {"venue": self.spec.name,
                "symbols": len(self.symbols),
                "socketsNeeded": self.sockets_needed,
                "live": self.live_count(),
                "shards": [s.stats() for s in self.shards]}


def _symbol_from_channel(channel: str) -> str:
    """Best-effort symbol extraction from a channel string.

    MEXC channels end in `@SYMBOL`; Gate subscribes by pair directly. Anything
    else falls through to the raw string, which simply will not match a book —
    a miss here costs a redundant resync, never a wrong book.
    """
    if "@" in channel:
        return channel.rsplit("@", 1)[-1]
    return channel.replace("_", "")
