"""Lock-free book publication across processes: a seqlock slab.

Why processes at all
--------------------
CPython's GIL means a decode-heavy ingestion thread and a compute thread do
*not* run in parallel — the ingestion loop for 2,100 symbols would preempt the
cycle evaluator at exactly the wrong microsecond. So ingestion runs in N
separate processes and publishes into `multiprocessing.shared_memory`; the
compute process reads without ever taking a lock.

The seqlock
-----------
Each symbol slot carries an even/odd sequence counter:

    writer:   seq += 1  (now odd — "write in progress")
              ... write levels ...
              seq += 1  (now even — "consistent")

    reader:   s1 = seq;  if s1 odd -> retry
              ... copy levels ...
              s2 = seq;  if s2 != s1 -> retry

Readers never block writers and writers never block readers. A reader that
loses the race simply re-reads; `read_slot` caps retries so a wedged writer
degrades to "no data" instead of a spin. There is exactly one writer per slot,
so this is a single-producer/multi-consumer seqlock, not a general one.

Layout
------
The sequence counters live in a **contiguous prefix array**, not inside their
slots. That is the difference between a 470 us dirty scan and a 30 us one: the
compute process reads all N counters with a single `struct.unpack_from` instead
of N strided reads 672 bytes apart. Levels are likewise packed and unpacked in
one call each rather than per-level.

    [ seq[N] : uint64 ][ pad to 64B ][ slot[0] ][ slot[1] ] ...

    slot:  offset  0   uint64  last_update_id
           offset  8   uint64  updated_ns      (writer's monotonic clock)
           offset 16   uint16  n_bids, n_asks, state, _pad
           offset 24   float64 bid_px[D], bid_qty[D], ask_px[D], ask_qty[D]
"""
from __future__ import annotations

import struct
from multiprocessing import shared_memory
from typing import Iterable, Sequence

from .book import BookSide, Level, OrderBook

__all__ = ["BookSlab", "SlabView", "SLOT_HEADER", "slot_bytes", "build_slab"]

_HDR = struct.Struct("<QQHHHH")          # per-slot header, 24 bytes
_SEQ = struct.Struct("<Q")
SLOT_HEADER = _HDR.size


def slot_bytes(depth: int) -> int:
    return SLOT_HEADER + depth * 4 * 8


def _align(n: int, to: int = 64) -> int:
    return (n + to - 1) // to * to


class BookSlab:
    """Shared-memory array of fixed-depth L2 books, addressed by slot index.

    The symbol -> slot mapping is derived from a sorted symbol list, so every
    process computes identical indices with no coordination.
    """

    def __init__(self, symbols: Sequence[str], depth: int = 20,
                 name: str | None = None, create: bool = True) -> None:
        self.depth = depth
        self.symbols = list(symbols)
        self.index = {s: i for i, s in enumerate(self.symbols)}
        n = max(1, len(self.symbols))
        self.slot_size = slot_bytes(depth)
        self._seq_bytes = n * 8
        self._data_off = _align(self._seq_bytes)
        size = self._data_off + self.slot_size * n

        # Struct objects sized once: one pack per publish, one unpack per read.
        self._levels = struct.Struct(f"<{depth * 4}d")
        self._all_seqs = struct.Struct(f"<{n}Q")

        if create:
            self.shm = shared_memory.SharedMemory(create=True, size=size, name=name)
            self.shm.buf[:size] = b"\x00" * size
        else:
            if name is None:
                raise ValueError("attaching requires the segment name")
            self.shm = shared_memory.SharedMemory(name=name)
        self.name = self.shm.name
        self.buf = self.shm.buf
        self._owner = create
        self._zeros = [0.0] * (depth * 4)

    # ------------------------------------------------------------- lifecycle

    def close(self) -> None:
        try:
            self.buf.release()
        except (BufferError, AttributeError):
            pass
        self.shm.close()

    def unlink(self) -> None:
        self.close()
        if self._owner:
            try:
                self.shm.unlink()
            except FileNotFoundError:
                pass

    def __enter__(self) -> "BookSlab":
        return self

    def __exit__(self, *exc) -> None:
        self.unlink() if self._owner else self.close()

    # ---------------------------------------------------------------- writer

    def write(self, symbol: str, book: OrderBook) -> bool:
        """Publish a book into its slot. One writer per slot, always."""
        slot = self.index.get(symbol)
        if slot is None:
            return False
        self.write_slot(slot, book.last_id, book.updated_ns, int(book.state),
                        book.bids.top(self.depth), book.asks.top(self.depth))
        return True

    def write_slot(self, slot: int, last_id: int, updated_ns: int, state: int,
                   bids: Sequence[Level], asks: Sequence[Level]) -> None:
        buf = self.buf
        d = self.depth
        seq_off = slot * 8
        seq = _SEQ.unpack_from(buf, seq_off)[0] + 1
        _SEQ.pack_into(buf, seq_off, seq)              # odd: write in progress

        nb = len(bids) if len(bids) < d else d
        na = len(asks) if len(asks) < d else d
        vals = self._zeros[:]
        for i in range(nb):
            p, q = bids[i]
            vals[i] = p
            vals[d + i] = q
        for i in range(na):
            p, q = asks[i]
            vals[2 * d + i] = p
            vals[3 * d + i] = q

        base = self._data_off + slot * self.slot_size
        _HDR.pack_into(buf, base, last_id, updated_ns, nb, na, state, 0)
        off = base + SLOT_HEADER
        buf[off:off + self._levels.size] = self._levels.pack(*vals)

        _SEQ.pack_into(buf, seq_off, seq + 1)          # even: consistent

    # ---------------------------------------------------------------- reader

    def read_slot(self, slot: int, retries: int = 8) -> "SlabView | None":
        """Consistent read of one slot, or None if the writer kept winning."""
        buf = self.buf
        d = self.depth
        seq_off = slot * 8
        base = self._data_off + slot * self.slot_size
        off = base + SLOT_HEADER
        for _ in range(retries):
            s1 = _SEQ.unpack_from(buf, seq_off)[0]
            if s1 & 1:
                continue                                # write in progress
            last_id, ts, nb, na, state, _ = _HDR.unpack_from(buf, base)
            if nb > d:
                nb = d
            if na > d:
                na = d
            v = self._levels.unpack_from(buf, off)
            if _SEQ.unpack_from(buf, seq_off)[0] != s1:
                continue
            bids = [(v[i], v[d + i]) for i in range(nb)]
            asks = [(v[2 * d + i], v[3 * d + i]) for i in range(na)]
            return SlabView(self.symbols[slot], s1, last_id, ts, state, bids, asks)
        return None

    def read(self, symbol: str) -> "SlabView | None":
        slot = self.index.get(symbol)
        return None if slot is None else self.read_slot(slot)

    def seq_of(self, slot: int) -> int:
        """Cheap change probe — read the counter without copying levels."""
        return _SEQ.unpack_from(self.buf, slot * 8)[0]

    def all_seqs(self) -> tuple[int, ...]:
        """Every sequence counter in one unpack — the dirty-scan primitive."""
        return self._all_seqs.unpack_from(self.buf, 0)

    def changed_since(self, seqs: list[int]) -> list[int]:
        """Slots whose sequence moved since `seqs`, updating `seqs` in place.

        One bulk unpack, then a fast-path tuple compare that exits in
        microseconds when nothing moved — which, per tick, is the common case
        even in a busy market.
        """
        cur = self._all_seqs.unpack_from(self.buf, 0)
        if len(seqs) != len(cur):
            raise ValueError("sequence vector size mismatch")
        if tuple(seqs) == cur:
            return []
        dirty = []
        for i, s in enumerate(cur):
            if s != seqs[i]:
                seqs[i] = s
                dirty.append(i)
        return dirty


class SlabView:
    """Immutable snapshot of one slot, shaped like the parts of `OrderBook`
    the pricing math actually touches."""

    __slots__ = ("symbol", "seq", "last_id", "updated_ns", "state",
                 "bid_levels", "ask_levels")

    def __init__(self, symbol: str, seq: int, last_id: int, updated_ns: int,
                 state: int, bids: list[Level], asks: list[Level]) -> None:
        self.symbol = symbol
        self.seq = seq
        self.last_id = last_id
        self.updated_ns = updated_ns
        self.state = state
        self.bid_levels = bids
        self.ask_levels = asks

    @property
    def live(self) -> bool:
        return self.state == 2  # BookState.LIVE

    def best_bid(self) -> float:
        return self.bid_levels[0][0] if self.bid_levels else 0.0

    def best_ask(self) -> float:
        return self.ask_levels[0][0] if self.ask_levels else 0.0

    def mid(self) -> float:
        b, a = self.best_bid(), self.best_ask()
        return (b + a) / 2.0 if b > 0 and a > 0 else 0.0

    def as_sides(self) -> tuple[BookSide, BookSide]:
        """Materialize BookSide objects for code that wants the richer
        interface. The walk functions take the raw level lists directly, so
        the hot path never calls this."""
        bids, asks = BookSide(True), BookSide(False)
        bids.load(self.bid_levels)
        asks.load(self.ask_levels)
        return bids, asks


def build_slab(symbols: Iterable[str], depth: int = 20,
               name: str | None = None) -> BookSlab:
    return BookSlab(sorted(set(symbols)), depth=depth, name=name, create=True)
