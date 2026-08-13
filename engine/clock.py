"""Monotonic timing and latency accounting.

Two clocks, deliberately kept apart:

  * `now_ns()` — `perf_counter_ns`, monotonic, immune to NTP steps. Everything
    that measures a *duration* uses this. A wall-clock step during a leg chain
    would otherwise produce negative latencies and poison the histograms.
  * `wall_ms()` — epoch milliseconds, used only for exchange-facing fields
    (signature timestamps, journal rows) where the venue needs real time.

The histogram is log-spaced and fixed-size: recording is O(log B) with no
allocation, so it is safe to call from the hot path. It is not thread-safe by
design — one histogram per thread/process, merged offline.
"""
from __future__ import annotations

import math
import time
from bisect import bisect_right
from typing import Iterable

__all__ = ["now_ns", "wall_ms", "wall_ns", "LatencyHistogram", "StageTimer"]


def now_ns() -> int:
    """Monotonic nanoseconds. Use for every duration measurement."""
    return time.perf_counter_ns()


def wall_ns() -> int:
    """Epoch nanoseconds. Use only for exchange-facing timestamps."""
    return time.time_ns()


def wall_ms() -> int:
    """Epoch milliseconds — what venue signatures and journals want."""
    return time.time_ns() // 1_000_000


def _log_bounds(lo_us: float, hi_us: float, per_decade: int) -> list[float]:
    """Log-spaced bucket upper bounds in nanoseconds."""
    decades = math.log10(hi_us / lo_us)
    n = max(1, int(round(decades * per_decade)))
    return [lo_us * 1000.0 * (10 ** (i * decades / n)) for i in range(n + 1)]


class LatencyHistogram:
    """Fixed-bucket latency histogram over nanosecond samples.

    Default range spans 1 us .. 10 s at 20 buckets per decade (~3.5 % width),
    which is fine enough to distinguish a 40 us book apply from a 400 us one
    and still cover a pathological 4 s REST stall in the same structure.
    """

    __slots__ = ("name", "_bounds", "_counts", "_over", "count", "total_ns",
                 "min_ns", "max_ns")

    def __init__(self, name: str, lo_us: float = 1.0, hi_us: float = 10_000_000.0,
                 per_decade: int = 20) -> None:
        self.name = name
        self._bounds = _log_bounds(lo_us, hi_us, per_decade)
        self._counts = [0] * (len(self._bounds) + 1)
        self._over = 0
        self.count = 0
        self.total_ns = 0
        self.min_ns = 0
        self.max_ns = 0

    def record(self, ns: float) -> None:
        if ns < 0:
            return  # clock went backwards; a negative duration is never real
        i = bisect_right(self._bounds, ns)
        self._counts[i] += 1
        if i == len(self._bounds):
            self._over += 1
        if self.count == 0 or ns < self.min_ns:
            self.min_ns = ns
        if ns > self.max_ns:
            self.max_ns = ns
        self.count += 1
        self.total_ns += ns

    def record_since(self, t0_ns: int) -> float:
        d = now_ns() - t0_ns
        self.record(d)
        return d

    def percentile(self, p: float) -> float:
        """Nanoseconds at percentile `p` in [0, 100]. Bucket upper bound."""
        if not self.count:
            return 0.0
        target = self.count * p / 100.0
        seen = 0
        for i, c in enumerate(self._counts):
            seen += c
            if seen >= target:
                if i >= len(self._bounds):
                    return float(self.max_ns)
                return self._bounds[i]
        return float(self.max_ns)

    @property
    def mean_ns(self) -> float:
        return self.total_ns / self.count if self.count else 0.0

    def snapshot(self) -> dict:
        """Plain dict for journals and the dashboard payload (micros)."""
        return {
            "name": self.name,
            "count": self.count,
            "meanUs": round(self.mean_ns / 1000, 1),
            "p50Us": round(self.percentile(50) / 1000, 1),
            "p95Us": round(self.percentile(95) / 1000, 1),
            "p99Us": round(self.percentile(99) / 1000, 1),
            "maxUs": round(self.max_ns / 1000, 1),
            "overflow": self._over,
        }

    def merge(self, other: "LatencyHistogram") -> None:
        """Fold another histogram of identical geometry into this one."""
        if other._bounds != self._bounds:
            raise ValueError("histogram geometry mismatch")
        for i, c in enumerate(other._counts):
            self._counts[i] += c
        self._over += other._over
        if other.count:
            self.min_ns = min(self.min_ns, other.min_ns) if self.count else other.min_ns
            self.max_ns = max(self.max_ns, other.max_ns)
            self.count += other.count
            self.total_ns += other.total_ns


class StageTimer:
    """Named checkpoints along one signal's life, for tick-to-trade breakdown.

    Stages are recorded as monotonic marks; `spans()` reports the gap between
    consecutive marks so a slow tick-to-trade can be attributed to the frame
    decode, the graph evaluation, or the venue's ack — not just observed.
    """

    __slots__ = ("marks",)

    def __init__(self, t0_ns: int | None = None) -> None:
        self.marks: list[tuple[str, int]] = [("t0", t0_ns if t0_ns is not None else now_ns())]

    def mark(self, name: str) -> int:
        t = now_ns()
        self.marks.append((name, t))
        return t

    @property
    def t0(self) -> int:
        return self.marks[0][1]

    def elapsed_ns(self) -> int:
        return self.marks[-1][1] - self.marks[0][1]

    def spans(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for (an, at), (bn, bt) in zip(self.marks, self.marks[1:]):
            out[f"{an}->{bn}"] = (bt - at) / 1000.0  # microseconds
        return out


def merge_all(hists: Iterable[LatencyHistogram]) -> dict[str, dict]:
    return {h.name: h.snapshot() for h in hists}
