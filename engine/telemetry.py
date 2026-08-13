"""Microstructure telemetry: edge decay, edge survival, and latency budget.

Three questions this answers, all of which the polling desk could only guess at:

1. **How fast does an edge decay?** `DecayTracker` re-prices a signalled cycle
   against the live book at T+25 ms, T+100 ms and T+500 ms. The ratio of
   surviving yield to the yield at T0 is the empirical answer to "how late can
   we be". If the T+100 ms number is already zero, no amount of engineering
   below 100 ms matters — the edge is gone before any router could reach it,
   and the honest move is to stop.

2. **How long does a dislocation persist?** `SurvivalTracker` watches each
   distinct cycle key from first sight to disappearance and builds the
   distribution. Median survival is the single most useful number for deciding
   whether to chase an edge at all.

3. **Where does our own latency go?** `LatencyBudget` folds the per-stage
   histograms — frame decode, book apply, graph evaluate, order send, ack,
   fill — into one tick-to-trade breakdown, so a regression is attributable
   instead of merely visible.

The decay tracker deliberately measures against *our own book*, not against a
replay. That means it is measuring the thing we would actually have traded on,
including our own staleness — which is the point.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Callable, Iterable, Mapping, Sequence

from .clock import LatencyHistogram, now_ns, wall_ms
from .graph import Triangle
from .sizing import DepthSource, SymbolFilters, simulate_cycle

__all__ = ["DecayTracker", "SurvivalTracker", "LatencyBudget", "Telemetry"]


@dataclass
class DecaySample:
    key: str
    path: str
    t0_bps: float
    size_usd: float
    detected_ns: int
    points: dict[int, float] = field(default_factory=dict)   # ms -> bps

    def capture_ratio(self, ms: int) -> float | None:
        v = self.points.get(ms)
        if v is None or self.t0_bps <= 0:
            return None
        return max(0.0, v) / self.t0_bps


class DecayTracker:
    """Schedules T+N ms re-evaluations of a signalled cycle."""

    def __init__(self, depth: Callable[[str], object],
                 filters: Mapping[str, SymbolFilters],
                 checkpoints_ms: Sequence[int] = (25, 100, 500),
                 keep: int = 2000) -> None:
        self.depth = depth
        self.filters = filters
        self.checkpoints = tuple(sorted(checkpoints_ms))
        self.samples: deque[DecaySample] = deque(maxlen=keep)
        self._agg: dict[int, list[float]] = {ms: [] for ms in self.checkpoints}
        self._tasks: set[asyncio.Task] = set()

    def observe(self, tri: Triangle, t0_bps: float, size_usd: float,
                detected_ns: int | None = None) -> DecaySample:
        s = DecaySample(tri.key, tri.path, t0_bps, size_usd,
                        detected_ns or now_ns())
        self.samples.append(s)
        for ms in self.checkpoints:
            t = asyncio.create_task(self._sample_later(tri, s, ms))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)
        return s

    async def _sample_later(self, tri: Triangle, s: DecaySample, ms: int) -> None:
        # Sleep the *remaining* time, so a checkpoint stays honest even when
        # the loop was busy when `observe` was called.
        elapsed_ms = (now_ns() - s.detected_ns) / 1e6
        await asyncio.sleep(max(0.0, (ms - elapsed_ms) / 1000.0))
        bps = self._reprice(tri, s.size_usd)
        s.points[ms] = bps
        if bps > float("-inf"):
            self._agg[ms].append(min(1.5, max(-1.0, bps / s.t0_bps))
                                 if s.t0_bps > 0 else 0.0)
            self._agg[ms] = self._agg[ms][-2000:]

    def _reprice(self, tri: Triangle, size_usd: float) -> float:
        depth: dict = {}
        for sym in tri.symbols:
            d = self.depth(sym)
            if not d:
                return float("-inf")
            depth[sym] = d
        plan = simulate_cycle(tri, depth, size_usd, self.filters, quantize=False)
        return plan.bps if plan.feasible else float("-inf")

    def summary(self) -> dict:
        out = {"samples": len(self.samples), "checkpoints": {}}
        for ms in self.checkpoints:
            vals = self._agg[ms]
            if not vals:
                out["checkpoints"][f"T+{ms}ms"] = None
                continue
            srt = sorted(vals)
            n = len(srt)
            out["checkpoints"][f"T+{ms}ms"] = {
                "n": n,
                "meanCapture": round(sum(srt) / n, 4),
                "medianCapture": round(srt[n // 2], 4),
                "survivedShare": round(sum(1 for v in srt if v > 0) / n, 4),
            }
        return out

    async def drain(self, timeout: float = 2.0) -> None:
        if self._tasks:
            await asyncio.wait(set(self._tasks), timeout=timeout)


class SurvivalTracker:
    """First-seen to last-seen duration for each distinct edge."""

    def __init__(self, max_ms: int = 60_000, keep: int = 5000) -> None:
        self.max_ms = max_ms
        self._open: dict[str, tuple[int, float, str]] = {}   # key -> (t0, bps, path)
        self.closed: deque[dict] = deque(maxlen=keep)
        self.hist = LatencyHistogram("edge.survival", lo_us=1000.0,
                                     hi_us=120_000_000.0, per_decade=12)

    def observe_batch(self, live_keys: Mapping[str, tuple[float, str]]) -> list[dict]:
        """Feed the currently-visible edges; returns the ones that just died."""
        t = now_ns()
        for key, (bps, path) in live_keys.items():
            if key not in self._open:
                self._open[key] = (t, bps, path)
            else:
                t0, best, path0 = self._open[key]
                if bps > best:
                    self._open[key] = (t0, bps, path0)
        dead = []
        for key in list(self._open):
            if key in live_keys:
                continue
            t0, best, path = self._open.pop(key)
            dur_ms = (t - t0) / 1e6
            self.hist.record(t - t0)
            row = {"key": key, "path": path, "peakBps": round(best, 2),
                   "survivedMs": round(dur_ms, 1), "closedAt": wall_ms()}
            self.closed.append(row)
            dead.append(row)
        return dead

    def summary(self) -> dict:
        rows = list(self.closed)
        if not rows:
            return {"observed": 0, "open": len(self._open)}
        durs = sorted(r["survivedMs"] for r in rows)
        n = len(durs)
        return {
            "observed": n,
            "open": len(self._open),
            "medianMs": round(durs[n // 2], 1),
            "p90Ms": round(durs[min(n - 1, int(n * 0.9))], 1),
            "maxMs": round(durs[-1], 1),
            "underOneSecondShare": round(sum(1 for d in durs if d < 1000) / n, 3),
        }


class LatencyBudget:
    """The tick-to-trade breakdown, assembled from named histograms."""

    def __init__(self) -> None:
        self.stages: dict[str, LatencyHistogram] = {}

    def hist(self, name: str) -> LatencyHistogram:
        h = self.stages.get(name)
        if h is None:
            h = LatencyHistogram(name)
            self.stages[name] = h
        return h

    def record(self, name: str, ns: float) -> None:
        self.hist(name).record(ns)

    def adopt(self, hists: Iterable[LatencyHistogram]) -> None:
        for h in hists:
            self.stages[h.name] = h

    def summary(self) -> dict:
        out = {n: h.snapshot() for n, h in sorted(self.stages.items())}
        p50_total = sum(h.percentile(50) for h in self.stages.values()
                        if ".total" not in h.name)
        out["_estimatedP50TotalUs"] = round(p50_total / 1000, 1)
        return out


class Telemetry:
    """One object the runtime hands around; publishes a single JSON payload."""

    def __init__(self, depth: Callable[[str], object],
                 filters: Mapping[str, SymbolFilters],
                 checkpoints_ms: Sequence[int] = (25, 100, 500),
                 out_path: str | None = None) -> None:
        self.decay = DecayTracker(depth, filters, checkpoints_ms)
        self.survival = SurvivalTracker()
        self.budget = LatencyBudget()
        self.out_path = out_path
        self.started_ns = now_ns()
        self.counters: dict[str, int] = defaultdict(int)

    def count(self, name: str, n: int = 1) -> None:
        self.counters[name] += n

    def payload(self, extra: dict | None = None) -> dict:
        return {
            "updatedAt": wall_ms(),
            "uptimeS": round((now_ns() - self.started_ns) / 1e9, 1),
            "decay": self.decay.summary(),
            "survival": self.survival.summary(),
            "latency": self.budget.summary(),
            "counters": dict(self.counters),
            **(extra or {}),
        }

    def publish(self, extra: dict | None = None) -> dict:
        p = self.payload(extra)
        if self.out_path:
            try:
                os.makedirs(os.path.dirname(self.out_path), exist_ok=True)
                tmp = self.out_path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(p, f)
                os.replace(tmp, self.out_path)   # atomic: never serve a half file
            except OSError:
                pass
        return p
