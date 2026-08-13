"""In-memory L2 order book with delta application and gap detection.

Design notes that matter for latency
------------------------------------
Each side keeps a *sorted ascending* `list[float]` of prices plus a `dict`
price -> qty. Deltas are the common case and they overwhelmingly touch price
levels that already exist, which is a pure `dict` store: O(1), no reordering.
Only structural changes (a new level, or a level deleted by a zero quantity)
touch the sorted list, and those go through `bisect.insort` / `del` — a C-level
memmove over a few thousand floats, tens of nanoseconds in practice.

Both sides are stored ascending. Asks walk forward from index 0; bids walk
backward from the end. Keeping one ordering convention avoids a negated-price
trick that reliably produces sign bugs at 3 a.m.

Sequencing
----------
Venues disagree about how they number diffs:

  * MEXC pushes `fromVersion` / `toVersion` and requires strict contiguity —
    `fromVersion == last_applied + 1`, else you have lost a frame.
  * Gate pushes `U` (first id) / `u` (last id) and allows overlap — a frame is
    acceptable when `U <= last_applied + 1 <= u`.

Both collapse to one rule with a `strict` flag, so the book stays venue-neutral
and the adapters only have to extract `(first, last)`.

Resync
------
`OrderBook` is a state machine: EMPTY -> SYNCING -> LIVE, falling back to
SYNCING on any gap. While SYNCING it *buffers* frames in a bounded deque and
keeps returning `False` from `apply_delta` — it never blocks, and it never
serves a torn book to the graph engine. The owner (see `engine.feed`) launches
the REST snapshot as a task; when it lands, `install_snapshot` replays the
buffer and the book goes LIVE again.
"""
from __future__ import annotations

import enum
from bisect import bisect_left, insort
from collections import deque
from typing import Iterator, Sequence

from .clock import now_ns

__all__ = [
    "BookState", "BookSide", "OrderBook", "Level", "WalkResult",
    "walk_buy", "walk_buy_base", "walk_sell", "ApplyResult",
]

Level = tuple[float, float]  # (price, quantity)


class BookState(enum.IntEnum):
    EMPTY = 0     # nothing received yet
    SYNCING = 1   # snapshot in flight; deltas are being buffered
    LIVE = 2      # contiguous and safe to price against
    STALE = 3     # repeatedly failed to sync; excluded from the graph


class ApplyResult(enum.IntEnum):
    IGNORED = 0    # old frame, already covered by the snapshot
    BUFFERED = 1   # queued while a snapshot is in flight
    APPLIED = 2    # merged into a LIVE book
    GAP = 3        # discontinuity detected; caller must resync


class BookSide:
    """One side of an L2 book: ascending prices plus a price -> qty map."""

    __slots__ = ("prices", "qty", "is_bid")

    def __init__(self, is_bid: bool) -> None:
        self.is_bid = is_bid
        self.prices: list[float] = []     # ascending, always
        self.qty: dict[float, float] = {}

    def __len__(self) -> int:
        return len(self.prices)

    def clear(self) -> None:
        self.prices.clear()
        self.qty.clear()

    def set(self, price: float, quantity: float) -> bool:
        """Apply one level. Returns True if the *structure* changed.

        A zero (or negative) quantity is a deletion — that is the wire
        convention on every venue this engine speaks to.
        """
        if quantity <= 0.0:
            if self.qty.pop(price, None) is not None:
                i = bisect_left(self.prices, price)
                if i < len(self.prices) and self.prices[i] == price:
                    del self.prices[i]
                return True
            return False
        if price in self.qty:
            self.qty[price] = quantity     # hot path: no reordering
            return False
        self.qty[price] = quantity
        insort(self.prices, price)
        return True

    def load(self, levels: Sequence[Level]) -> None:
        """Replace the side wholesale from a snapshot."""
        self.qty = {p: q for p, q in levels if q > 0.0}
        self.prices = sorted(self.qty)

    def best(self) -> Level | None:
        if not self.prices:
            return None
        p = self.prices[-1] if self.is_bid else self.prices[0]
        return p, self.qty[p]

    def best_price(self) -> float:
        if not self.prices:
            return 0.0
        return self.prices[-1] if self.is_bid else self.prices[0]

    def iter_levels(self, limit: int = 0) -> Iterator[Level]:
        """Levels best-first: bids descending, asks ascending."""
        src = reversed(self.prices) if self.is_bid else iter(self.prices)
        n = 0
        for p in src:
            yield p, self.qty[p]
            n += 1
            if limit and n >= limit:
                return

    def top(self, depth: int) -> list[Level]:
        return list(self.iter_levels(depth))

    def notional_within(self, mid: float, band: float) -> float:
        """Quote-currency depth resting within `band` (fractional) of `mid`."""
        lo, hi = mid * (1 - band), mid * (1 + band)
        total = 0.0
        for p, q in self.iter_levels():
            if p < lo or p > hi:
                break
            total += p * q
        return total


class OrderBook:
    """A single symbol's L2 book plus its sequencing state machine."""

    __slots__ = ("symbol", "venue", "bids", "asks", "state", "last_id",
                 "strict", "_buffer", "_max_buffer", "updated_ns", "seq",
                 "resync_count", "gap_count", "last_gap_ns", "_snapshot_pending",
                 "top_changed", "_top")

    def __init__(self, symbol: str, venue: str = "", strict: bool = False,
                 max_buffer: int = 4096) -> None:
        self.symbol = symbol
        self.venue = venue
        self.bids = BookSide(is_bid=True)
        self.asks = BookSide(is_bid=False)
        self.state = BookState.EMPTY
        self.last_id = 0            # last applied update id / version
        self.strict = strict        # MEXC: require exact contiguity
        self._buffer: deque[tuple[int, int, Sequence[Level], Sequence[Level]]] = deque()
        self._max_buffer = max_buffer
        self.updated_ns = 0
        self.seq = 0                # local monotonic revision, for the shm slab
        self.resync_count = 0
        self.gap_count = 0
        self.last_gap_ns = 0
        self._snapshot_pending = False
        # Set by every apply/install: did the *touch* move? Levels deep in the
        # book change constantly and matter only to a cycle already being
        # sized, so the publisher uses this to skip ~most writes.
        self.top_changed = False
        self._top = (0.0, 0.0)

    # ---------------------------------------------------------------- state

    @property
    def live(self) -> bool:
        return self.state is BookState.LIVE

    @property
    def snapshot_pending(self) -> bool:
        return self._snapshot_pending

    def mark_snapshot_pending(self) -> None:
        """Owner is fetching a snapshot; suppress duplicate fetches."""
        self._snapshot_pending = True
        if self.state is not BookState.SYNCING:
            self.state = BookState.SYNCING

    def request_resync(self, reason: str = "") -> None:
        """Drop to SYNCING. Levels are kept until the snapshot lands so the
        cross-venue monitor can still show a (clearly stale) price, but `live`
        goes False immediately so no cycle can be priced off a torn book."""
        self.state = BookState.SYNCING
        self.gap_count += 1
        self.last_gap_ns = now_ns()
        self._buffer.clear()

    def mark_stale(self) -> None:
        self.state = BookState.STALE
        self._snapshot_pending = False
        self._buffer.clear()

    # ---------------------------------------------------------------- deltas

    def _contiguous(self, first: int, last: int) -> bool:
        """Is a frame spanning ids [first, last] the next one we can apply?"""
        want = self.last_id + 1
        if self.strict:
            return first == want
        return first <= want <= last

    def apply_delta(self, first: int, last: int,
                    bids: Sequence[Level], asks: Sequence[Level],
                    ts_ns: int | None = None) -> ApplyResult:
        """Merge one incremental frame.

        `first`/`last` are the venue's update-id span for this frame. Pass
        `first == last == 0` for venues without sequencing (the book then
        trusts arrival order — acceptable only for display feeds, never for
        an execution path).
        """
        if self.state is BookState.SYNCING or self.state is BookState.EMPTY:
            if len(self._buffer) >= self._max_buffer:
                # A buffer this deep means the snapshot is hopelessly behind;
                # dropping the oldest keeps memory bounded and the newest
                # frames are the ones a fresh snapshot can actually chain to.
                self._buffer.popleft()
            self._buffer.append((first, last, tuple(bids), tuple(asks)))
            return ApplyResult.BUFFERED

        if last and last <= self.last_id:
            return ApplyResult.IGNORED          # replay of something we have
        if (first or last) and not self._contiguous(first, last):
            self.request_resync("gap")
            self._buffer.append((first, last, tuple(bids), tuple(asks)))
            return ApplyResult.GAP

        self._merge(bids, asks)
        if last:
            self.last_id = last
        self.updated_ns = ts_ns if ts_ns is not None else now_ns()
        self.seq += 1
        self._note_top()
        return ApplyResult.APPLIED

    def _note_top(self) -> None:
        bp, ap = self.bids.prices, self.asks.prices
        top = (bp[-1] if bp else 0.0, ap[0] if ap else 0.0)
        self.top_changed = top != self._top
        self._top = top

    def _merge(self, bids: Sequence[Level], asks: Sequence[Level]) -> None:
        bset = self.bids.set
        aset = self.asks.set
        new_bid = 0.0
        new_ask = 0.0
        for p, q in bids:
            bset(p, q)
            if q > 0.0 and p > new_bid:
                new_bid = p
        for p, q in asks:
            aset(p, q)
            if q > 0.0 and (new_ask == 0.0 or p < new_ask):
                new_ask = p
        # A crossed book (best bid >= best ask) is not a real market: it is a
        # missed deletion. Trim it rather than emit a fictional 500 bps edge.
        self._uncross(new_bid, new_ask)

    def _uncross(self, new_bid: float = 0.0, new_ask: float = 0.0) -> None:
        """Resolve a crossed touch in favour of the level that just arrived.

        The frame being applied is, by construction, the freshest information
        we have. So when a new bid crosses a resting ask, it is the *ask* that
        should have been deleted and we never saw the delete. Falling back to
        "keep the larger size" only applies when neither side is from this
        frame (a crossed snapshot), which should not happen but does.
        """
        bp, ap = self.bids.prices, self.asks.prices
        for _ in range(256):                    # bounded: never spin on bad data
            if not (bp and ap and bp[-1] >= ap[0]):
                return
            best_bid, best_ask = bp[-1], ap[0]
            bid_is_new = new_bid > 0.0 and best_bid <= new_bid
            ask_is_new = new_ask > 0.0 and best_ask >= new_ask
            if bid_is_new and not ask_is_new:
                self.asks.set(best_ask, 0.0)
            elif ask_is_new and not bid_is_new:
                self.bids.set(best_bid, 0.0)
            elif self.bids.qty[best_bid] <= self.asks.qty[best_ask]:
                self.bids.set(best_bid, 0.0)
            else:
                self.asks.set(best_ask, 0.0)

    def install_snapshot(self, last_update_id: int,
                         bids: Sequence[Level], asks: Sequence[Level],
                         ts_ns: int | None = None) -> bool:
        """Adopt a REST snapshot and replay the buffered deltas onto it.

        Returns True when the book reached LIVE. False means the snapshot was
        already too old for the buffered frames (the venue moved faster than
        our fetch) and the caller must fetch again — the buffer is preserved
        so the next snapshot has a chance to chain.
        """
        self._snapshot_pending = False
        self.bids.load(bids)
        self.asks.load(asks)
        self.last_id = last_update_id
        self._uncross()

        # Discard everything the snapshot already contains.
        while self._buffer and self._buffer[0][1] and self._buffer[0][1] <= last_update_id:
            self._buffer.popleft()

        if self._buffer:
            first, last, _, _ = self._buffer[0]
            if (first or last) and not self._contiguous(first, last):
                # Snapshot lands *after* the buffered frames (we buffered too
                # little) or *before* them with a hole. Either way we cannot
                # prove continuity, so refuse to go LIVE.
                if first > last_update_id + 1:
                    self._buffer.clear()   # hole: buffer is useless, refetch
                    self.state = BookState.SYNCING
                    return False

        self.state = BookState.LIVE
        replayed = 0
        while self._buffer:
            first, last, b, a = self._buffer.popleft()
            if last and last <= self.last_id:
                continue
            if (first or last) and not self._contiguous(first, last):
                self.request_resync("replay-gap")
                return False
            self._merge(b, a)
            if last:
                self.last_id = last
            replayed += 1

        self.resync_count += 1
        self.updated_ns = ts_ns if ts_ns is not None else now_ns()
        self.seq += 1
        self._note_top()
        self.top_changed = True          # a fresh snapshot always republishes
        return True

    def install_full(self, bids: Sequence[Level], asks: Sequence[Level],
                     ts_ns: int | None = None) -> None:
        """Adopt a full-depth push (venues that stream snapshots, not diffs)."""
        self.bids.load(bids)
        self.asks.load(asks)
        self._uncross()
        self.state = BookState.LIVE
        self._snapshot_pending = False
        self.updated_ns = ts_ns if ts_ns is not None else now_ns()
        self.seq += 1
        self._note_top()
        self.top_changed = True

    # ---------------------------------------------------------------- views

    def best_bid(self) -> float:
        return self.bids.best_price()

    def best_ask(self) -> float:
        return self.asks.best_price()

    def mid(self) -> float:
        b, a = self.best_bid(), self.best_ask()
        return (b + a) / 2.0 if b > 0 and a > 0 else 0.0

    def spread_bps(self) -> float:
        b, a = self.best_bid(), self.best_ask()
        if b <= 0 or a <= 0:
            return 0.0
        return (a - b) / ((a + b) / 2.0) * 10_000.0

    def age_ns(self) -> int:
        return now_ns() - self.updated_ns if self.updated_ns else 1 << 62

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (f"<OrderBook {self.venue}:{self.symbol} {self.state.name} "
                f"id={self.last_id} {self.best_bid()}/{self.best_ask()}>")


# ------------------------------------------------------------------- walking

class WalkResult:
    """Outcome of consuming a book side for a target size.

    `filled` is the amount received *after* the taker fee. `vwap` is the raw
    execution price before fees — that is what a limit price must be set from,
    while `filled` is what the next leg gets to spend.
    """

    __slots__ = ("filled", "consumed", "vwap", "levels", "complete", "worst_px")

    def __init__(self, filled: float, consumed: float, vwap: float,
                 levels: int, complete: bool, worst_px: float) -> None:
        self.filled = filled
        self.consumed = consumed
        self.vwap = vwap
        self.levels = levels
        self.complete = complete
        self.worst_px = worst_px

    def __repr__(self) -> str:  # pragma: no cover
        return (f"<Walk filled={self.filled:.8f} vwap={self.vwap:.8f} "
                f"levels={self.levels} complete={self.complete}>")


_EMPTY_WALK = WalkResult(0.0, 0.0, 0.0, 0, False, 0.0)


def walk_buy(asks: BookSide | Sequence[Level], quote_amount: float,
             fee: float) -> WalkResult:
    """Spend `quote_amount` of quote currency crossing the asks.

    Returns base received net of `fee`. `complete` is False when the visible
    book cannot absorb the full amount — the caller must treat that as "this
    size is not executable", never as "fill what you can", because a partial
    leg 1 in a triangle is an open position, not a smaller trade.
    """
    if quote_amount <= 0:
        return _EMPTY_WALK
    levels = asks.iter_levels() if isinstance(asks, BookSide) else iter(asks)
    got = 0.0
    left = quote_amount
    n = 0
    worst = 0.0
    for px, qty in levels:
        if px <= 0 or qty <= 0:
            continue
        n += 1
        worst = px
        cost = px * qty
        if cost >= left:
            got += left / px
            left = 0.0
            break
        got += qty
        left -= cost
    if left > 1e-12 or got <= 0:
        return WalkResult(0.0, quote_amount - left, 0.0, n, False, worst)
    spent = quote_amount
    return WalkResult(got * (1.0 - fee), spent, spent / got, n, True, worst)


def walk_buy_base(asks: BookSide | Sequence[Level], base_amount: float,
                  fee: float) -> WalkResult:
    """Buy an exact `base_amount` crossing the asks; returns quote *spent*.

    The mirror of `walk_buy`, needed after lot-size quantization: once the
    order quantity has been rounded down to a step boundary, the honest cost is
    the cost of that rounded quantity, not a rescaled fraction of the original
    walk. `filled` here is the quote spent (fee is charged on the base
    received, so `consumed` carries the net base).
    """
    if base_amount <= 0:
        return _EMPTY_WALK
    levels = asks.iter_levels() if isinstance(asks, BookSide) else iter(asks)
    spent = 0.0
    left = base_amount
    n = 0
    worst = 0.0
    for px, qty in levels:
        if px <= 0 or qty <= 0:
            continue
        n += 1
        worst = px
        if qty >= left:
            spent += left * px
            left = 0.0
            break
        spent += qty * px
        left -= qty
    if left > 1e-12 or spent <= 0:
        return WalkResult(0.0, 0.0, 0.0, n, False, worst)
    return WalkResult(spent, base_amount * (1.0 - fee), spent / base_amount,
                      n, True, worst)


def walk_sell(bids: BookSide | Sequence[Level], base_amount: float,
              fee: float) -> WalkResult:
    """Sell `base_amount` of base currency crossing the bids.

    Returns quote received net of `fee`.
    """
    if base_amount <= 0:
        return _EMPTY_WALK
    levels = bids.iter_levels() if isinstance(bids, BookSide) else iter(bids)
    got = 0.0
    left = base_amount
    n = 0
    worst = 0.0
    for px, qty in levels:
        if px <= 0 or qty <= 0:
            continue
        n += 1
        worst = px
        if qty >= left:
            got += left * px
            left = 0.0
            break
        got += qty * px
        left -= qty
    if left > 1e-12 or got <= 0:
        return WalkResult(0.0, base_amount - left, 0.0, n, False, worst)
    return WalkResult(got * (1.0 - fee), base_amount, got / base_amount, n, True, worst)
