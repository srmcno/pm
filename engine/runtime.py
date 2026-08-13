"""Process wiring: ingestion -> compute -> execution.

Topology
--------
    ┌── ingestion shard 0 ─┐
    │   N websockets       │  decode + apply deltas + write slab
    ├── ingestion shard 1 ─┤ ──────────────► [ shared-memory book slab ]
    │        ...           │                          │  seqlock reads
    └── ingestion shard k ─┘                          ▼
                                          ┌── compute engine ──┐
      dirty symbols ─────────────────────►│  quote refresh     │
                                          │  cycle evaluate    │
                                          │  depth-walk size   │
                                          └────────┬───────────┘
                                                   │ CyclePlan
                                                   ▼
                                          ┌── execution worker ─┐
                                          │  risk gate          │
                                          │  IOC leg chain      │
                                          │  unwind / hedge     │
                                          └─────────────────────┘

Single process or many
----------------------
`Engine` runs everything on one event loop by default, which is the right
choice up to the point where decode CPU starts stealing from cycle evaluation.
Past that, set `ingest_shards > 1` with `multiprocess=True` and the shards fork:
they publish into the same slab, and the compute engine discovers dirty symbols
via `BookSlab.changed_since` instead of a callback. Nothing else changes —
which is the whole reason the slab exists.

The GIL is the reason this seam exists at all. Threads would not help: decoding
210 k frames/s and evaluating cycles are both CPU-bound Python, and they would
simply take turns at the worst possible moments.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import time
from typing import Any, Callable, Iterable, Mapping, Sequence

from .book import BookState, OrderBook
from .clock import LatencyHistogram, now_ns, wall_ms
from .config import BASE, EngineConfig, VenueSpec, VENUES, load_config
from .crossvenue import CrossVenueMonitor
from .execution import CycleStatus, ExecutionManager
from .graph import CycleIndex, Opportunity, Quote, bellman_ford_cycles
from .risk import RiskEngine
from .sizing import SymbolFilters, solve_cycle_size
from .telemetry import Telemetry
from .venues.base import TimeInForce

__all__ = ["Engine", "build_universe", "main"]


def build_universe(info: Mapping[str, Mapping], quote: str = "USDT",
                   bridges: Sequence[str] = (), max_symbols: int = 4096
                   ) -> tuple[dict[str, dict], dict[str, SymbolFilters],
                              dict[tuple[str, str], str]]:
    """Trim `exchangeInfo` to the symbols that can appear in a cycle.

    Anything that cannot reach the quote asset in one or two hops is dead
    weight: it costs a subscription slot (30 per socket on MEXC) and buys
    nothing. Keeping the universe tight is what makes 70 sockets enough.
    """
    pairs: dict[tuple[str, str], str] = {}
    for sym, s in info.items():
        pairs[(s["base"], s["quote"])] = sym
    reachable = {quote, *bridges}
    keep: dict[str, dict] = {}
    for sym, s in info.items():
        if s["quote"] in reachable or s["base"] in reachable:
            keep[sym] = dict(s)
        if len(keep) >= max_symbols:
            break
    filters = {
        sym: SymbolFilters(
            symbol=sym, base=s["base"], quote=s["quote"],
            taker=float(s.get("taker", 0.0005)),
            tick_size=float(s.get("tickSize") or 0.0),
            step_size=float(s.get("stepSize") or 0.0),
            min_qty=float(s.get("minQty") or 0.0),
            min_notional=float(s.get("minNotional") or 0.0))
        for sym, s in keep.items()}
    return keep, filters, pairs


class Engine:
    """Everything, wired. `run()` is the process entry point."""

    def __init__(self, cfg: EngineConfig, info: Mapping[str, Mapping],
                 router: Any = None, feed_factory: Callable | None = None,
                 slab: Any = None) -> None:
        self.cfg = cfg
        self.info, self.filters, self.pairs = build_universe(
            info, cfg.quote, cfg.bridges, cfg.max_symbols)
        self.symbols = sorted(self.info)
        self.index = CycleIndex(self.info, cfg.quote, cfg.bridges)
        self.quotes: dict[str, Quote] = {}
        self.books: dict[str, OrderBook] = {}
        self.slab = slab
        self.router = router
        self.feed_factory = feed_factory

        self.risk = RiskEngine(cfg.risk, cfg.quote, cfg.journal_path)
        self.telemetry = Telemetry(self.depth_of, self.filters,
                                   cfg.decay_checkpoints_ms, cfg.telemetry_path)
        self.exec: ExecutionManager | None = None
        if router is not None:
            self.exec = ExecutionManager(
                router, self.risk, self.filters, self.depth_of, self.pairs,
                cfg.quote, cfg.risk, cfg.journal_path,
                first_leg_tif=TimeInForce.FOK, bridges=cfg.bridges,
                on_report=self._on_report)

        self._dirty: set[str] = set()
        self._dirty_lock = asyncio.Lock()
        self._pools: list[Any] = []
        self._running = False
        self._inflight: set[asyncio.Task] = set()
        self.eval_hist = LatencyHistogram("compute.evaluate")
        self.size_hist = LatencyHistogram("compute.depth_walk")
        self.signals = 0
        self.dispatched = 0
        self.cross: CrossVenueMonitor | None = None

    # ------------------------------------------------------------ book access

    def depth_of(self, symbol: str):
        """(bid_levels, ask_levels) for the sizer, telemetry and unwinds."""
        b = self.books.get(symbol)
        if b is not None and b.state is BookState.LIVE:
            return b.bids, b.asks
        if self.slab is not None:
            v = self.slab.read(symbol)
            if v is not None and v.live:
                return v.bid_levels, v.ask_levels
        return None

    def attach_book(self, book: OrderBook) -> None:
        self.books[book.symbol] = book

    def mark_dirty(self, symbol: str) -> None:
        """Called from the ingestion path — must stay O(1) and never await."""
        self._dirty.add(symbol)
        b = self.books.get(symbol)
        if b is not None:
            bid, ask = b.best_bid(), b.best_ask()
            if bid > 0 and ask > 0:
                bq = b.bids.qty.get(bid, 0.0)
                aq = b.asks.qty.get(ask, 0.0)
                self.quotes[symbol] = (bid, bq, ask, aq)

    # ----------------------------------------------------------- compute loop

    async def compute_loop(self, interval_s: float = 0.0) -> None:
        """Drain the dirty set, evaluate the touched cycles, dispatch winners.

        `interval_s=0` means "as fast as the loop allows" — the batch is
        whatever accumulated while the previous batch was being evaluated,
        which is a natural, self-tuning form of coalescing: quiet markets get
        per-frame latency, busy markets get bigger batches instead of falling
        behind.
        """
        cfg = self.cfg
        while self._running:
            if not self._dirty:
                await asyncio.sleep(interval_s or 0.001)
                continue
            batch = self._dirty
            self._dirty = set()
            t0 = now_ns()
            opps = self.index.evaluate_dirty(batch, self.quotes,
                                             cfg.evaluate_min_bps, t0)
            self.eval_hist.record(now_ns() - t0)
            self.telemetry.count("evaluated", len(batch))
            if opps:
                self.signals += len(opps)
                self._track_survival(opps)
                await self._handle(opps)
            await asyncio.sleep(interval_s)

    def _track_survival(self, opps: Sequence[Opportunity]) -> None:
        self.telemetry.survival.observe_batch(
            {o.tri.key: (o.screen_bps, o.tri.path) for o in opps})

    def _set_hot(self, symbols: Iterable[str]) -> None:
        """Ask the feeds for full-depth publication on these symbols.

        Screening needs only the touch; sizing needs 20 levels. Marking the
        handful of symbols under active evaluation as hot means the other
        ~2,000 pay the shared-memory write only when their touch actually
        moves, which is where most of the publish budget goes.
        """
        hot = set(symbols)
        for pool in self._pools:
            for shard in pool.shards:
                shard.set_hot(hot)

    async def _handle(self, opps: Sequence[Opportunity]) -> None:
        cfg = self.cfg
        if self._pools:
            self._set_hot({s for o in opps[:6] for s in o.tri.symbols})
        for opp in opps[:6]:
            depth = {}
            ok = True
            oldest_ns = 0
            for sym in opp.tri.symbols:
                d = self.depth_of(sym)
                if not d:
                    ok = False
                    break
                depth[sym] = d
                b = self.books.get(sym)
                if b is not None:
                    oldest_ns = max(oldest_ns, b.age_ns())
            if not ok:
                continue
            t0 = now_ns()
            plan = solve_cycle_size(
                opp.tri, depth, self.filters,
                min_bps=cfg.risk.min_edge_bps,
                max_usd=min(cfg.risk.max_stake_per_cycle_usd,
                            cfg.risk.bankroll_usd),
                min_usd=1.0)
            self.size_hist.record(now_ns() - t0)
            if plan is None:
                self.telemetry.count("sized_out")
                continue
            opp.verified_bps = plan.bps
            opp.size_usd = plan.capital_usd
            opp.profit_usd = plan.profit_usd
            self.telemetry.count("verified")
            self.telemetry.decay.observe(opp.tri, plan.bps, plan.capital_usd,
                                         opp.detected_ns)
            if self.exec is None or not cfg.live:
                self.telemetry.count("paper_only")
                continue
            self.dispatched += 1
            task = asyncio.create_task(
                self.exec.execute(plan, opp.detected_ns, oldest_ns / 1e6))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)

    def _on_report(self, rep) -> None:
        self.telemetry.count(f"cycle_{rep.status.value.lower()}")
        self.telemetry.budget.record("exec.tick_to_trade",
                                     rep.tick_to_trade_ms * 1e6)

    # ------------------------------------------------------ discovery worker

    async def discovery_loop(self, every_s: float = 15.0) -> None:
        """Periodic Bellman-Ford sweep for routes the 3-cycle index misses.

        Deliberately slow and off the hot path: O(V·E) is seconds, not
        microseconds. Its job is to notice that a 4-leg route has been quietly
        profitable all afternoon, not to trade a tick.
        """
        while self._running:
            await asyncio.sleep(every_s)
            t0 = now_ns()
            try:
                cycles = await asyncio.to_thread(
                    bellman_ford_cycles, self.index.adj, dict(self.quotes),
                    12, 6, self.cfg.evaluate_min_bps)
            except Exception:  # noqa: BLE001
                continue
            self.telemetry.budget.record("compute.bellman_ford", now_ns() - t0)
            long_routes = [c for c in cycles if c["length"] > 3]
            if long_routes:
                self.telemetry.count("long_routes", len(long_routes))
                self.telemetry.counters["lastLongRoute"] = 0
                self._last_long_routes = long_routes

    # ------------------------------------------------------------- telemetry

    async def telemetry_loop(self, every_s: float = 5.0) -> None:
        while self._running:
            await asyncio.sleep(every_s)
            self.publish()

    def publish(self) -> dict:
        self.telemetry.budget.adopt([self.eval_hist, self.size_hist])
        if self.exec is not None:
            self.telemetry.budget.adopt(
                [self.exec.send_hist, self.exec.fill_hist, self.exec.cycle_hist])
        extra = {
            "universe": {
                "symbols": len(self.symbols),
                "live": sum(1 for b in self.books.values()
                            if b.state is BookState.LIVE),
                **self.index.stats(),
            },
            "signals": self.signals,
            "dispatched": self.dispatched,
            "risk": self.risk.snapshot(),
            "execution": self.exec.stats() if self.exec else None,
            "feeds": [p.stats() for p in self._pools],
            "cross": self.cross.summary() if self.cross else None,
            "live": self.cfg.live,
        }
        return self.telemetry.publish(extra)

    # ------------------------------------------------------------------ life

    async def start_feeds(self) -> None:
        from .feed import ConnectionPool
        if self.feed_factory is None:
            return
        for name in self.cfg.venues:
            spec = VENUES[name]
            pool = ConnectionPool(spec, self.feed_factory, self.symbols,
                                  self.cfg.ingest_shards, slab=self.slab,
                                  on_dirty=self.mark_dirty)
            for shard in pool.shards:
                for sym, book in shard.books.items():
                    self.attach_book(book)
            self._pools.append(pool)
            await pool.start()

    async def run(self, duration_s: float = 0.0) -> None:
        self._running = True
        if self.router is not None:
            await self.router.start()
        await self.start_feeds()
        tasks = [
            asyncio.create_task(self.compute_loop(), name="compute"),
            asyncio.create_task(self.discovery_loop(), name="discovery"),
            asyncio.create_task(self.telemetry_loop(), name="telemetry"),
        ]
        try:
            if duration_s:
                await asyncio.sleep(duration_s)
            else:
                await asyncio.gather(*tasks)
        finally:
            await self.stop(tasks)

    async def stop(self, tasks: Iterable[asyncio.Task] = ()) -> None:
        self._running = False
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._inflight:
            await asyncio.wait(set(self._inflight), timeout=5.0)
        for p in self._pools:
            await p.stop()
        if self.router is not None:
            await self.router.close()
        self.publish()


# ------------------------------------------------------------------- CLI

def _load_info_from_cache() -> dict:
    """Reuse the polling desk's cached `exchangeInfo` when it is there."""
    path = os.path.join(BASE, "data", "cache", "mexc_info.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _plan(cfg: EngineConfig) -> None:
    """Print the sizing arithmetic without touching the network."""
    info = _load_info_from_cache()
    if not info:
        print("No cached exchangeInfo. Populate data/cache/mexc_info.json by "
              "running `python3 scripts/arb.py scan` once, or start the engine "
              "with `run` (which fetches it live).")
        return
    keep, filters, pairs = build_universe(info, cfg.quote, cfg.bridges,
                                          cfg.max_symbols)
    index = CycleIndex(keep, cfg.quote, cfg.bridges)
    print(f"universe           {len(info)} listed -> {len(keep)} in-scope symbols")
    st = index.stats()
    print(f"currencies         {st['currencies']}")
    print(f"triangles          {st['triangles']:,}")
    print(f"cycles/symbol      mean {st['meanCyclesPerSymbol']}, "
          f"max {st['maxCyclesPerSymbol']}")
    for name in cfg.venues:
        spec = VENUES[name]
        n = spec.conns_needed(len(keep))
        print(f"{name:<6} sockets     {n} "
              f"({len(keep)} subs / {spec.max_subs_per_conn} per connection)")
        print(f"{name:<6} ws order    {'yes' if spec.ws_order_entry else 'NO — REST only'}")
    print(f"shards             {cfg.ingest_shards}")
    print(f"slab bytes         {len(keep) * (32 + cfg.depth_levels * 4 * 8):,}")
    print(f"live trading       {'ARMED' if cfg.live else 'disarmed (paper)'}")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python3 -m engine",
        description="Event-driven triangular / cross-venue arbitrage engine.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan", help="print universe + connection-pool arithmetic")
    st = sub.add_parser("selftest", help="run the full pipeline on synthetic books")
    st.add_argument("--cycles", type=int, default=3)
    r = sub.add_parser("run", help="live/paper engine (needs aiohttp+websockets)")
    r.add_argument("--minutes", type=float, default=0.0)
    r.add_argument("--live", action="store_true",
                   help="ARM real order routing (needs MEXC_API_KEY/SECRET)")
    ap.add_argument("--config", default=os.path.join(BASE, "data", "arb",
                                                     "engine-config.json"))
    args = ap.parse_args(argv)
    cfg = load_config(args.config)

    if args.cmd == "plan":
        _plan(cfg)
        return 0
    if args.cmd == "selftest":
        from .selftest import run_selftest
        return run_selftest(cfg, args.cycles)
    if args.cmd == "run":
        cfg.live = bool(getattr(args, "live", False))
        from .live import run_live
        return asyncio.run(run_live(cfg, (args.minutes or 0) * 60))
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
