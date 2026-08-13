"""End-to-end pipeline exercise on synthetic books — no keys, no network.

This exists because "it compiles" is not evidence that an execution path works.
`run_selftest` drives real `OrderBook` objects through real delta frames, real
cycle evaluation, real depth-walked sizing and the real `ExecutionManager`
against a simulated venue that fills, partially fills, and refuses — including
the leg-3 failure that the whole unwind path exists for.

Everything downstream of the socket is the production code. Only the socket and
the matching engine are stubs.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from typing import Any, Mapping, Sequence

from .book import OrderBook, walk_buy, walk_sell
from .clock import now_ns
from .config import EngineConfig, RiskLimits
from .execution import CycleStatus, ExecutionManager
from .graph import BUY, SELL, CycleIndex
from .risk import RiskEngine
from .sizing import SymbolFilters, solve_cycle_size
from .venues.base import (OrderRequest, OrderResult, OrderStatus, Side,
                          TimeInForce)

__all__ = ["SimVenue", "run_selftest", "build_scenario"]


class SimVenue:
    """A matching engine that is honest about the ways real ones disappoint.

    `fail_symbols` refuse outright; `partial_symbols` fill a fraction. Both are
    the normal case on micro-caps, and an execution manager that has never been
    run against them has not been tested.
    """

    spec = None

    def __init__(self, depth: Mapping[str, tuple], filters: Mapping[str, SymbolFilters],
                 fail_symbols: Sequence[str] = (), partial_symbols: Mapping[str, float] | None = None,
                 latency_ms: float = 1.0) -> None:
        self.depth = depth
        self.filters = filters
        self.fail = set(fail_symbols)
        self.partial = dict(partial_symbols or {})
        self.latency_ms = latency_ms
        self.orders: list[OrderRequest] = []
        self.results: dict[str, OrderResult] = {}

    async def start(self) -> None: ...
    async def close(self) -> None: ...
    def on_fill(self, cb) -> None: ...

    async def balances(self) -> dict[str, float]:
        return {"USDT": 1000.0}

    async def submit(self, req: OrderRequest) -> OrderResult:
        self.orders.append(req)
        sent = now_ns()
        await asyncio.sleep(self.latency_ms / 1000.0)
        res = OrderResult(req.client_id, f"sim-{len(self.orders)}",
                          OrderStatus.CANCELED, sent_ns=sent, ack_ns=now_ns(),
                          fill_ns=now_ns())
        if req.symbol in self.fail:
            self.results[req.client_id] = res
            return res                       # IOC that took nothing

        frac = self.partial.get(req.symbol, 1.0)
        book = self.depth.get(req.symbol)
        if not book:
            self.results[req.client_id] = res
            return res
        bids, asks = book
        qty = req.qty * frac
        if req.side is Side.BUY:
            # Only levels at or below the limit are takeable.
            takeable = [(p, q) for p, q in asks if p <= req.price * (1 + 1e-12)]
            filled, spent = 0.0, 0.0
            left = qty
            for p, q in takeable:
                take = min(left, q)
                filled += take
                spent += take * p
                left -= take
                if left <= 1e-15:
                    break
            res.filled_base, res.filled_quote = filled, spent
        else:
            takeable = [(p, q) for p, q in bids if p >= req.price * (1 - 1e-12)]
            filled, got = 0.0, 0.0
            left = qty
            for p, q in takeable:
                take = min(left, q)
                filled += take
                got += take * p
                left -= take
                if left <= 1e-15:
                    break
            res.filled_base, res.filled_quote = filled, got
        if res.filled_base > 0:
            res.avg_price = res.filled_quote / res.filled_base
            res.status = (OrderStatus.FILLED if res.filled_base >= req.qty * 0.999
                          else OrderStatus.CANCELED)   # IOC remainder killed
        self.results[req.client_id] = res
        return res

    async def wait_fill(self, client_id: str, timeout_s: float) -> OrderResult:
        return self.results.get(client_id) or OrderResult(
            client_id, "", OrderStatus.UNKNOWN)


def build_scenario(edge_bps: float = 120.0) -> tuple[dict, dict, dict, dict]:
    """A 3-symbol universe carrying a known edge, with realistic depth."""
    info = {
        "FOOUSDT": {"base": "FOO", "quote": "USDT", "taker": 0.0005},
        "FOOUSDC": {"base": "FOO", "quote": "USDC", "taker": 0.0005},
        "USDCUSDT": {"base": "USDC", "quote": "USDT", "taker": 0.0005},
    }
    lift = 1.0 + edge_bps / 10_000.0 + 0.0015   # cover three taker legs
    depth = {
        "FOOUSDT": ([(0.998, 4000.0), (0.99, 9000.0)],
                    [(1.000, 400.0), (1.004, 4000.0), (1.05, 50_000.0)]),
        "FOOUSDC": ([(1.0 * lift, 300.0), (0.995 * lift, 5000.0)],
                    [(1.01 * lift, 2000.0)]),
        "USDCUSDT": ([(1.0000, 500_000.0)], [(1.0002, 500_000.0)]),
    }
    filters = {s: SymbolFilters(s, info[s]["base"], info[s]["quote"], 0.0005,
                                tick_size=1e-6, step_size=1e-3, min_qty=0.001,
                                min_notional=1.0) for s in info}
    pairs = {(v["base"], v["quote"]): k for k, v in info.items()}
    return info, depth, filters, pairs


async def _scenario(name: str, cfg: EngineConfig, fail: Sequence[str] = (),
                    partial: Mapping[str, float] | None = None) -> tuple:
    info, depth, filters, pairs = build_scenario()
    index = CycleIndex(info, "USDT", cfg.bridges)
    tri = next(t for t in index.triangles if t.path == "USDT→FOO→USDC→USDT")

    plan = solve_cycle_size(tri, depth, filters, min_bps=cfg.risk.min_edge_bps,
                            max_usd=cfg.risk.max_stake_per_cycle_usd, min_usd=1.0)
    if plan is None:
        return name, None, None

    venue = SimVenue(depth, filters, fail_symbols=fail, partial_symbols=partial)
    # A private STOP path per scenario: `halt()` genuinely writes the file, and
    # a shared path would let one scenario's kill switch disarm the next.
    tmp = tempfile.mkdtemp(prefix="arb-selftest-")
    limits = RiskLimits(**{**cfg.risk.as_dict(),
                           "stop_file": os.path.join(tmp, "STOP")})
    risk = RiskEngine(limits, "USDT")
    risk.set_balances({"USDT": 1000.0})
    mgr = ExecutionManager(venue, risk, filters, lambda s: depth.get(s), pairs,
                           "USDT", limits, journal_path=None,
                           first_leg_tif=TimeInForce.FOK, bridges=cfg.bridges)
    try:
        rep = await mgr.execute(plan, detected_ns=now_ns(), book_age_ms=1.0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return name, plan, rep


def _book_roundtrip() -> tuple[bool, str]:
    """Snapshot + buffered deltas + a gap, on a real OrderBook."""
    b = OrderBook("FOOUSDT", "mexc", strict=True)
    b.apply_delta(11, 11, [(0.99, 5.0)], [])
    b.apply_delta(12, 12, [], [(1.02, 3.0)])
    ok = b.install_snapshot(10, [(0.98, 10.0)], [(1.01, 10.0)])
    if not ok or b.last_id != 12:
        return False, f"replay failed (live={ok}, id={b.last_id})"
    if b.best_bid() != 0.99 or b.best_ask() != 1.01:
        return False, f"wrong top after replay {b.best_bid()}/{b.best_ask()}"
    if b.apply_delta(20, 20, [], []).name != "GAP":
        return False, "gap not detected"
    if b.live:
        return False, "book stayed live through a gap"
    return True, f"replayed to id={b.last_id}, gap detected, state={b.state.name}"


def run_selftest(cfg: EngineConfig, _cycles: int = 3) -> int:
    print("engine selftest — synthetic books, simulated venue, real everything else")
    print()
    ok, detail = _book_roundtrip()
    print(f"  [{'PASS' if ok else 'FAIL'}] order book resync   {detail}")
    failures = 0 if ok else 1

    async def go() -> list:
        return [
            await _scenario("clean fill", cfg),
            await _scenario("leg 3 fails", cfg, fail=["USDCUSDT"]),
            await _scenario("leg 1 partial", cfg, partial={"FOOUSDT": 0.4}),
            await _scenario("leg 2 partial", cfg, partial={"FOOUSDC": 0.5}),
            await _scenario("leg 1 no fill", cfg, fail=["FOOUSDT"]),
        ]

    expected = {
        "clean fill": {CycleStatus.COMPLETE},
        "leg 3 fails": {CycleStatus.UNWOUND, CycleStatus.STRANDED},
        "leg 1 partial": {CycleStatus.COMPLETE, CycleStatus.UNWOUND,
                          CycleStatus.EARLY_EXIT},
        "leg 2 partial": {CycleStatus.COMPLETE, CycleStatus.UNWOUND,
                          CycleStatus.STRANDED},
        "leg 1 no fill": {CycleStatus.NO_FILL},
    }
    for name, plan, rep in asyncio.run(go()):
        if rep is None:
            print(f"  [FAIL] {name:<14} no viable plan at "
                  f"{cfg.risk.min_edge_bps} bps")
            failures += 1
            continue
        good = rep.status in expected[name]
        failures += 0 if good else 1
        print(f"  [{'PASS' if good else 'FAIL'}] {name:<14} "
              f"{rep.status.value:<11} plan {plan.bps:6.1f}bps ${plan.capital_usd:6.2f} "
              f"-> realized {rep.realized_bps:+8.1f}bps "
              f"(${rep.realized_usd:+.4f}) legs={len(rep.legs)} "
              f"{rep.reason[:44]}")
    print()
    print(f"  {'all checks passed' if not failures else f'{failures} check(s) FAILED'}")
    return 0 if not failures else 1
