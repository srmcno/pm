"""Unit tests for the arbitrage engine. Stdlib only — no network, no keys.

    python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from engine.book import (ApplyResult, BookSide, BookState, OrderBook,
                         walk_buy, walk_buy_base, walk_sell)
from engine.clock import LatencyHistogram, StageTimer
from engine.config import MEXC, GATE, RiskLimits
from engine.execution import CycleStatus, ExecutionManager
from engine.graph import (BUY, SELL, CycleIndex, bellman_ford_cycles,
                          build_adjacency)
from engine.risk import RiskEngine
from engine.selftest import SimVenue, build_scenario
from engine.shm import BookSlab
from engine.sizing import (SymbolFilters, quantize_down, quantize_up,
                           simulate_cycle, solve_cycle_size)
from engine.telemetry import SurvivalTracker
from engine.venues.base import OrderStatus, TimeInForce
from engine.venues.mexc import MexcFeed, sign_query
from engine.venues.protobuf import decode as pb_decode


# --------------------------------------------------------------------- book

class TestBookSide(unittest.TestCase):
    def test_ordering_and_deletion(self):
        asks = BookSide(is_bid=False)
        for p, q in ((1.02, 5), (1.00, 3), (1.05, 9)):
            asks.set(p, q)
        self.assertEqual(asks.best_price(), 1.00)
        self.assertEqual([p for p, _ in asks.iter_levels()], [1.00, 1.02, 1.05])
        asks.set(1.00, 0)                        # zero quantity deletes
        self.assertEqual(asks.best_price(), 1.02)
        self.assertEqual(len(asks), 2)

    def test_bids_iterate_descending(self):
        bids = BookSide(is_bid=True)
        for p, q in ((0.98, 1), (0.99, 2), (0.97, 3)):
            bids.set(p, q)
        self.assertEqual([p for p, _ in bids.iter_levels()], [0.99, 0.98, 0.97])
        self.assertEqual(bids.best(), (0.99, 2))

    def test_qty_update_is_not_structural(self):
        s = BookSide(is_bid=False)
        self.assertTrue(s.set(1.0, 5))           # insert  -> structural
        self.assertFalse(s.set(1.0, 7))          # update  -> not structural
        self.assertTrue(s.set(1.0, 0))           # delete  -> structural
        self.assertFalse(s.set(1.0, 0))          # no-op


class TestOrderBookSequencing(unittest.TestCase):
    def test_buffers_until_snapshot_then_replays(self):
        b = OrderBook("X", "mexc", strict=True)
        self.assertIs(b.apply_delta(11, 11, [(0.99, 5)], []), ApplyResult.BUFFERED)
        self.assertIs(b.apply_delta(12, 12, [], [(1.02, 3)]), ApplyResult.BUFFERED)
        self.assertTrue(b.install_snapshot(10, [(0.98, 10)], [(1.01, 10)]))
        self.assertIs(b.state, BookState.LIVE)
        self.assertEqual(b.last_id, 12)
        self.assertEqual(b.best_bid(), 0.99)
        self.assertEqual(b.best_ask(), 1.01)

    def test_strict_gap_detected(self):
        b = OrderBook("X", "mexc", strict=True)
        b.install_snapshot(10, [(1.0, 1)], [(1.1, 1)])
        self.assertIs(b.apply_delta(11, 11, [], []), ApplyResult.APPLIED)
        self.assertIs(b.apply_delta(13, 13, [], []), ApplyResult.GAP)
        self.assertFalse(b.live)
        self.assertEqual(b.gap_count, 1)

    def test_loose_sequencing_accepts_overlap(self):
        """Gate allows U <= last+1 <= u; the same frame must be a gap on MEXC."""
        gate = OrderBook("X", "gate", strict=False)
        gate.install_snapshot(10, [(1.0, 1)], [(1.1, 1)])
        self.assertIs(gate.apply_delta(8, 12, [], []), ApplyResult.APPLIED)
        self.assertEqual(gate.last_id, 12)

        mexc = OrderBook("X", "mexc", strict=True)
        mexc.install_snapshot(10, [(1.0, 1)], [(1.1, 1)])
        self.assertIs(mexc.apply_delta(8, 12, [], []), ApplyResult.GAP)

    def test_stale_frames_ignored(self):
        b = OrderBook("X", strict=False)
        b.install_snapshot(50, [(1.0, 1)], [(1.1, 1)])
        self.assertIs(b.apply_delta(40, 45, [(9.9, 1)], []), ApplyResult.IGNORED)
        self.assertEqual(b.best_bid(), 1.0)

    def test_snapshot_older_than_buffer_refuses_to_go_live(self):
        b = OrderBook("X", "mexc", strict=True)
        b.apply_delta(100, 100, [(1.0, 1)], [])   # buffered, far ahead
        self.assertFalse(b.install_snapshot(10, [(1.0, 1)], [(1.1, 1)]))
        self.assertIs(b.state, BookState.SYNCING)

    def assertNotCrossed(self, b: OrderBook):
        bid, ask = b.best_bid(), b.best_ask()
        self.assertFalse(bid > 0 and ask > 0 and bid >= ask,
                         f"book left crossed: {bid} / {ask}")

    def test_top_changed_flag_gates_publication(self):
        b = OrderBook("X", strict=False)
        b.install_snapshot(1, [(0.99, 5), (0.98, 5)], [(1.01, 5), (1.02, 5)])
        self.assertTrue(b.top_changed)              # a snapshot always publishes
        b.apply_delta(2, 2, [(0.98, 9)], [])        # deep level: no touch move
        self.assertFalse(b.top_changed)
        b.apply_delta(3, 3, [(0.995, 1)], [])       # new best bid
        self.assertTrue(b.top_changed)
        b.apply_delta(4, 4, [(0.995, 0)], [])       # best bid deleted
        self.assertTrue(b.top_changed)
        self.assertEqual(b.best_bid(), 0.99)

    def test_crossed_snapshot_is_uncrossed(self):
        b = OrderBook("X", strict=False)
        b.install_snapshot(1, [(1.05, 5), (0.98, 1)], [(1.00, 2), (1.10, 4)])
        self.assertNotCrossed(b)
        # The smaller resting side yields when neither side is newer.
        self.assertEqual(b.best_bid(), 1.05)
        self.assertEqual(b.best_ask(), 1.10)

    def test_new_bid_clears_stale_asks(self):
        """A delete we never saw must not become a fictional edge."""
        b = OrderBook("X", strict=False)
        b.install_snapshot(1, [(0.99, 5)], [(1.00, 2), (1.01, 3)])
        b.apply_delta(2, 2, [(1.005, 9)], [])    # new bid crosses the 1.00 ask
        self.assertNotCrossed(b)
        self.assertEqual(b.best_bid(), 1.005)
        self.assertEqual(b.best_ask(), 1.01)     # only the crossed ask went

    def test_new_ask_clears_stale_bids(self):
        b = OrderBook("X", strict=False)
        b.install_snapshot(1, [(0.99, 5), (0.98, 3)], [(1.02, 2)])
        b.apply_delta(2, 2, [], [(0.985, 7)])
        self.assertNotCrossed(b)
        self.assertEqual(b.best_ask(), 0.985)
        self.assertEqual(b.best_bid(), 0.98)


class TestWalks(unittest.TestCase):
    def test_walk_buy_consumes_levels_in_order(self):
        asks = [(1.0, 10.0), (1.1, 10.0)]
        w = walk_buy(asks, 15.0, 0.0)
        self.assertTrue(w.complete)
        # $10 buys 10 @ 1.0; remaining $5 buys 4.5454 @ 1.1
        self.assertAlmostEqual(w.filled, 10 + 5 / 1.1, places=9)
        self.assertEqual(w.levels, 2)
        self.assertEqual(w.worst_px, 1.1)

    def test_walk_incomplete_when_book_too_thin(self):
        w = walk_buy([(1.0, 1.0)], 100.0, 0.0)
        self.assertFalse(w.complete)
        self.assertEqual(w.filled, 0.0)

    def test_walk_sell_and_fee(self):
        w = walk_sell([(2.0, 5.0), (1.0, 100.0)], 10.0, 0.001)
        self.assertTrue(w.complete)
        gross = 5 * 2.0 + 5 * 1.0
        self.assertAlmostEqual(w.filled, gross * 0.999, places=9)
        self.assertAlmostEqual(w.vwap, gross / 10.0, places=9)

    def test_walk_buy_base_is_inverse_of_walk_buy(self):
        asks = [(1.0, 10.0), (1.1, 10.0)]
        w = walk_buy(asks, 15.0, 0.0)
        back = walk_buy_base(asks, w.filled, 0.0)
        self.assertAlmostEqual(back.filled, 15.0, places=9)


# -------------------------------------------------------------------- graph

class TestGraph(unittest.TestCase):
    def setUp(self):
        self.info = {
            "FOOUSDT": {"base": "FOO", "quote": "USDT", "taker": 0.0},
            "FOOUSDC": {"base": "FOO", "quote": "USDC", "taker": 0.0},
            "USDCUSDT": {"base": "USDC", "quote": "USDT", "taker": 0.0},
        }
        self.index = CycleIndex(self.info, "USDT", ("USDC",))

    def test_enumerates_both_directions(self):
        paths = {t.path for t in self.index.triangles}
        self.assertIn("USDT→FOO→USDC→USDT", paths)
        self.assertIn("USDT→USDC→FOO→USDT", paths)

    def test_leg_units_chain(self):
        """Each leg's destination must be the next leg's source."""
        for t in self.index.triangles:
            for a, b in zip(t.legs, t.legs[1:]):
                self.assertEqual(a.dst, b.src, t.path)
            self.assertEqual(t.legs[-1].dst, t.legs[0].src)

    def test_inverted_index_covers_every_leg(self):
        for cid, t in enumerate(self.index.triangles):
            for s in t.symbols:
                self.assertIn(cid, self.index.by_symbol[s])

    def test_profitable_cycle_detected_and_priced(self):
        quotes = {"FOOUSDT": (0.99, 100, 1.00, 100),
                  "FOOUSDC": (1.01, 100, 1.02, 100),
                  "USDCUSDT": (1.00, 100, 1.001, 100)}
        opps = self.index.evaluate_dirty(["FOOUSDT"], quotes, min_bps=1.0)
        self.assertEqual(len(opps), 1)
        self.assertAlmostEqual(opps[0].screen_bps, 100.0, places=6)
        self.assertEqual(opps[0].path, "USDT→FOO→USDC→USDT")

    def test_fees_kill_a_marginal_edge(self):
        info = {k: {**v, "taker": 0.001} for k, v in self.info.items()}
        idx = CycleIndex(info, "USDT", ("USDC",))
        quotes = {"FOOUSDT": (0.99, 100, 1.00, 100),
                  "FOOUSDC": (1.001, 100, 1.02, 100),
                  "USDCUSDT": (1.00, 100, 1.001, 100)}
        self.assertEqual(idx.evaluate_dirty(["FOOUSDT"], quotes, 1.0), [])

    def test_dirty_evaluation_matches_full_sweep(self):
        quotes = {"FOOUSDT": (0.99, 100, 1.00, 100),
                  "FOOUSDC": (1.01, 100, 1.02, 100),
                  "USDCUSDT": (1.00, 100, 1.001, 100)}
        full = {o.path for o in self.index.evaluate_all(quotes, 1.0)}
        dirty = {o.path for o in
                 self.index.evaluate_dirty(self.info, quotes, 1.0)}
        self.assertEqual(full, dirty)

    def test_bellman_ford_agrees_with_triangle_index(self):
        quotes = {"FOOUSDT": (0.99, 100, 1.00, 100),
                  "FOOUSDC": (1.01, 100, 1.02, 100),
                  "USDCUSDT": (1.00, 100, 1.001, 100)}
        cycles = bellman_ford_cycles(build_adjacency(self.info), quotes,
                                     min_bps=1.0)
        self.assertTrue(cycles)
        self.assertAlmostEqual(cycles[0]["bps"], 100.0, places=1)

    def test_bellman_ford_silent_when_no_edge(self):
        quotes = {"FOOUSDT": (0.99, 100, 1.00, 100),
                  "FOOUSDC": (0.99, 100, 1.00, 100),
                  "USDCUSDT": (1.00, 100, 1.001, 100)}
        self.assertEqual(bellman_ford_cycles(build_adjacency(self.info), quotes,
                                             min_bps=1.0), [])


# ------------------------------------------------------------------- sizing

class TestSizing(unittest.TestCase):
    def setUp(self):
        self.info, self.depth, self.filters, self.pairs = build_scenario()
        self.index = CycleIndex(self.info, "USDT")
        self.tri = next(t for t in self.index.triangles
                        if t.path == "USDT→FOO→USDC→USDT")

    def test_quantize_directions(self):
        self.assertAlmostEqual(quantize_down(1.2345, 0.001), 1.234, places=9)
        self.assertAlmostEqual(quantize_up(1.2341, 0.001), 1.235, places=9)
        self.assertAlmostEqual(quantize_down(0.3, 0.1), 0.3, places=9)  # ULP guard

    def test_yield_is_monotone_non_increasing_in_size(self):
        prev = float("inf")
        for s in (1, 2, 5, 10, 20, 40, 80):
            p = simulate_cycle(self.tri, self.depth, float(s), self.filters,
                               quantize=False)
            if not p.feasible:
                break
            self.assertLessEqual(p.bps, prev + 1e-6, f"non-monotone at {s}")
            prev = p.bps

    def test_solver_hits_the_target_and_respects_the_cap(self):
        for target in (10.0, 40.0, 80.0):
            plan = solve_cycle_size(self.tri, self.depth, self.filters,
                                    min_bps=target, max_usd=50.0)
            self.assertIsNotNone(plan, f"no plan at {target} bps")
            self.assertGreaterEqual(plan.bps, target - 1e-6)
            self.assertLessEqual(plan.capital_usd, 50.0 + 1e-9)

    def test_solver_refuses_an_impossible_target(self):
        self.assertIsNone(solve_cycle_size(self.tri, self.depth, self.filters,
                                           min_bps=5000.0, max_usd=50.0))

    def test_quantization_never_overstates_capital(self):
        plan = solve_cycle_size(self.tri, self.depth, self.filters,
                                min_bps=10.0, max_usd=50.0)
        self.assertIsNotNone(plan)
        # bps is measured against what leg 1 actually spends, not the request.
        self.assertAlmostEqual(plan.capital_usd, plan.legs[0].quote_amount,
                               places=9)
        self.assertLessEqual(plan.capital_usd, plan.size_usd + 1e-9)

    def test_min_notional_blocks_dust(self):
        f = {s: SymbolFilters(s, v["base"], v["quote"], 0.0005,
                              tick_size=1e-6, step_size=1e-3, min_notional=1e6)
             for s, v in self.info.items()}
        p = simulate_cycle(self.tri, self.depth, 10.0, f, quantize=True)
        self.assertFalse(p.feasible)
        self.assertIn("minNotional", p.reason)

    def test_thin_book_is_infeasible_not_partial(self):
        thin = dict(self.depth)
        thin["FOOUSDT"] = ([(0.99, 1.0)], [(1.0, 0.5)])
        p = simulate_cycle(self.tri, thin, 100.0, self.filters)
        self.assertFalse(p.feasible)
        self.assertIn("too thin", p.reason)


# --------------------------------------------------------------------- risk

class TestRisk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="risk-test-")
        self.limits = RiskLimits(bankroll_usd=20.0, max_stake_per_cycle_usd=10.0,
                                 max_daily_stake_usd=25.0, min_edge_bps=10.0,
                                 max_signal_age_ms=40.0,
                                 stop_file=os.path.join(self.tmp, "STOP"))
        self.risk = RiskEngine(self.limits, "USDT")
        self.risk.set_balances({"USDT": 1000.0})

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ok(self, **kw):
        args = dict(size_usd=10.0, bps=50.0, signal_age_ms=1.0,
                    book_age_ms=1.0, symbols=["A", "B"])
        args.update(kw)
        return self.risk.check_cycle(**args)

    def test_accepts_a_clean_cycle(self):
        self.assertTrue(self.ok())

    def test_rejects_thin_edge_and_stale_signal(self):
        self.assertFalse(self.ok(bps=5.0))
        self.assertFalse(self.ok(signal_age_ms=500.0))
        self.assertFalse(self.ok(book_age_ms=99_999.0))

    def test_daily_stake_cap(self):
        self.risk.record_stake(20.0)
        self.assertFalse(self.ok(size_usd=10.0))   # only $5 of budget left

    def test_stop_file_halts(self):
        with open(self.limits.stop_file, "w") as f:
            f.write("halt")
        v = self.ok()
        self.assertFalse(v)
        self.assertTrue(self.risk.halted)

    def test_symbol_lease_blocks_concurrent_cycles(self):
        self.risk.lease(["A"])
        self.assertFalse(self.ok(symbols=["A", "C"]))
        self.assertTrue(self.ok(symbols=["D", "C"]))
        self.risk.release(["A"])
        self.assertTrue(self.ok(symbols=["A", "C"]))

    def test_daily_loss_limit_trips_the_switch(self):
        self.risk.record_pnl(-self.limits.max_daily_loss_usd - 0.01)
        self.assertTrue(self.risk.halted)
        self.assertFalse(self.ok())

    def test_ledger_tracks_and_clears_inventory(self):
        led = self.risk.ledger
        led.credit("FOO", 100.0, 10.0)
        led.mark("FOO", 0.1)
        self.assertAlmostEqual(led.stranded_usd(), 10.0, places=6)
        led.debit("FOO", 100.0, 9.5)
        self.assertEqual(led.open_positions(), [])
        self.assertAlmostEqual(led.realized_usd, -0.5, places=6)

    def test_unmarked_inventory_falls_back_to_cost(self):
        self.risk.ledger.credit("BAR", 5.0, 7.25)
        self.assertAlmostEqual(self.risk.ledger.stranded_usd(), 7.25, places=6)


# ---------------------------------------------------------------- execution

def _mgr(depth, filters, pairs, tmp, **kw):
    limits = RiskLimits(bankroll_usd=1000.0, max_stake_per_cycle_usd=50.0,
                        max_daily_stake_usd=1000.0, max_daily_loss_usd=1000.0,
                        min_edge_bps=10.0, max_signal_age_ms=10_000.0,
                        max_book_age_ms=10_000.0,
                        stop_file=os.path.join(tmp, "STOP"))
    risk = RiskEngine(limits, "USDT")
    risk.set_balances({"USDT": 1000.0})
    venue = SimVenue(depth, filters, **kw)
    mgr = ExecutionManager(venue, risk, filters, lambda s: depth.get(s), pairs,
                           "USDT", limits, first_leg_tif=TimeInForce.FOK,
                           bridges=("USDC", "BTC", "ETH"))
    return mgr, venue, risk


class TestExecution(unittest.TestCase):
    def setUp(self):
        self.info, self.depth, self.filters, self.pairs = build_scenario()
        idx = CycleIndex(self.info, "USDT")
        self.tri = next(t for t in idx.triangles
                        if t.path == "USDT→FOO→USDC→USDT")
        self.plan = solve_cycle_size(self.tri, self.depth, self.filters,
                                     min_bps=10.0, max_usd=10.0)
        self.assertIsNotNone(self.plan)
        self.tmp = tempfile.mkdtemp(prefix="exec-test-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cycle(self, **kw):
        mgr, venue, risk = _mgr(self.depth, self.filters, self.pairs,
                                self.tmp, **kw)
        rep = asyncio.run(mgr.execute(self.plan, detected_ns=0))
        return rep, venue, risk

    def test_clean_cycle_sends_three_legs_and_profits(self):
        rep, venue, _ = self.run_cycle()
        self.assertIs(rep.status, CycleStatus.COMPLETE)
        self.assertEqual(len(venue.orders), 3)
        self.assertGreater(rep.realized_usd, 0)
        self.assertEqual([o.tif for o in venue.orders],
                         [TimeInForce.FOK, TimeInForce.IOC, TimeInForce.IOC])

    def test_leg1_no_fill_costs_nothing(self):
        rep, venue, risk = self.run_cycle(fail_symbols=["FOOUSDT"])
        self.assertIs(rep.status, CycleStatus.NO_FILL)
        self.assertEqual(len(venue.orders), 1)
        self.assertEqual(rep.deployed_usd, 0.0)
        self.assertEqual(risk.ledger.open_positions(), [])

    def test_leg1_partial_resizes_downstream_legs(self):
        rep, venue, _ = self.run_cycle(partial_symbols={"FOOUSDT": 0.4})
        self.assertIs(rep.status, CycleStatus.COMPLETE)
        # Leg 2 must be sized from the actual fill, not the plan.
        self.assertLess(venue.orders[1].qty, self.plan.legs[1].order_qty)
        self.assertAlmostEqual(venue.orders[1].qty,
                               self.plan.legs[1].order_qty * 0.4,
                               delta=self.plan.legs[1].order_qty * 0.02)

    def test_leg3_failure_triggers_unwind_and_leaves_no_inventory(self):
        rep, venue, risk = self.run_cycle(fail_symbols=["USDCUSDT"])
        self.assertIn(rep.status, (CycleStatus.UNWOUND, CycleStatus.STRANDED))
        symbols = [o.symbol for o in venue.orders]
        self.assertIn("USDCUSDT", symbols)
        if rep.status is CycleStatus.UNWOUND:
            # It escaped via the other pair rather than sitting on the bag.
            self.assertGreater(symbols.count("FOOUSDC") + symbols.count("FOOUSDT"), 2)
            self.assertEqual(risk.ledger.open_positions(), [])
            self.assertGreater(rep.returned_usd, 0.0)

    def test_stranded_cycle_halts_the_engine(self):
        rep, _, risk = self.run_cycle(fail_symbols=["USDCUSDT", "FOOUSDC",
                                                    "FOOUSDT"])
        self.assertIs(rep.status, CycleStatus.NO_FILL)   # leg 1 never filled
        self.assertFalse(risk.halted)

    def test_report_serializes(self):
        rep, _, _ = self.run_cycle()
        d = rep.as_dict()
        self.assertEqual(d["status"], "COMPLETE")
        self.assertEqual(len(d["legs"]), 3)
        self.assertIn("timingsUs", d)


# ---------------------------------------------------------- shared memory

class TestSlab(unittest.TestCase):
    def test_roundtrip_and_dirty_detection(self):
        symbols = ["AUSDT", "BUSDT", "CUSDT"]
        slab = BookSlab(symbols, depth=4)
        try:
            b = OrderBook("BUSDT")
            b.install_snapshot(7, [(0.9, 1.0), (0.8, 2.0)], [(1.1, 3.0)])
            seqs = [slab.seq_of(i) for i in range(len(symbols))]
            self.assertTrue(slab.write("BUSDT", b))
            dirty = slab.changed_since(seqs)
            self.assertEqual(dirty, [1])
            self.assertEqual(slab.changed_since(seqs), [])   # idempotent

            v = slab.read("BUSDT")
            self.assertIsNotNone(v)
            self.assertTrue(v.live)
            self.assertEqual(v.last_id, 7)
            self.assertEqual(v.best_bid(), 0.9)
            self.assertEqual(v.best_ask(), 1.1)
            self.assertEqual(v.bid_levels, [(0.9, 1.0), (0.8, 2.0)])
        finally:
            slab.unlink()

    def test_depth_is_truncated_not_corrupted(self):
        slab = BookSlab(["AUSDT"], depth=2)
        try:
            b = OrderBook("AUSDT")
            b.install_snapshot(1, [(3.0, 1), (2.0, 1), (1.0, 1)],
                               [(4.0, 1), (5.0, 1), (6.0, 1)])
            slab.write("AUSDT", b)
            v = slab.read("AUSDT")
            self.assertEqual(len(v.bid_levels), 2)
            self.assertEqual(v.bid_levels, [(3.0, 1.0), (2.0, 1.0)])
            self.assertEqual(v.ask_levels, [(4.0, 1.0), (5.0, 1.0)])
        finally:
            slab.unlink()


# ------------------------------------------------------------------ venues

class TestMexcWire(unittest.TestCase):
    def test_signature_is_stable(self):
        qs, sig = sign_query("secret", {"symbol": "BTCUSDT", "side": "BUY"})
        self.assertEqual(qs, "symbol=BTCUSDT&side=BUY")
        self.assertEqual(len(sig), 64)
        self.assertEqual(sig, sign_query("secret", {"symbol": "BTCUSDT",
                                                    "side": "BUY"})[1])

    def test_json_depth_frame_decodes(self):
        feed = MexcFeed(MEXC, ["BTCUSDT"], wire="json")
        raw = ('{"c":"spot@public.increase.depth.v3.api@BTCUSDT",'
               '"d":{"bids":[{"p":"100.5","v":"2"}],'
               '"asks":[{"p":"100.7","v":"3"}],"r":"88"},'
               '"s":"BTCUSDT","t":1700000000000}')
        frames = feed.decode(raw)
        self.assertEqual(len(frames), 1)
        f = frames[0]
        self.assertEqual(f.symbol, "BTCUSDT")
        self.assertEqual(f.bids, [(100.5, 2.0)])
        self.assertEqual(f.asks, [(100.7, 3.0)])
        self.assertEqual((f.first_id, f.last_id), (88, 88))

    def test_control_frames_decode_to_nothing(self):
        feed = MexcFeed(MEXC, ["BTCUSDT"], wire="json")
        self.assertEqual(feed.decode('{"id":0,"code":0,"msg":"PONG"}'), [])
        self.assertEqual(feed.decode("not json at all"), [])

    def test_channels_respect_the_subscription_limit(self):
        symbols = [f"S{i}USDT" for i in range(95)]
        feed = MexcFeed(MEXC, symbols)
        chans = feed.channels_for(symbols)
        self.assertEqual(len(chans), 95)
        self.assertEqual(MEXC.conns_needed(95), 4)     # ceil(95 / 30)
        self.assertEqual(MEXC.conns_needed(2100), 70)  # the real number

    def test_venue_specs_encode_the_facts_that_matter(self):
        self.assertFalse(MEXC.ws_order_entry)   # REST-only order entry
        self.assertTrue(MEXC.strict_sequencing)
        self.assertTrue(GATE.ws_order_entry)    # spot.order_place exists
        self.assertFalse(GATE.strict_sequencing)


class TestProtobufReader(unittest.TestCase):
    @staticmethod
    def _varint(n: int) -> bytes:
        out = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)

    def _field(self, no: int, payload: bytes) -> bytes:
        return self._varint((no << 3) | 2) + self._varint(len(payload)) + payload

    def test_decodes_nested_messages_and_strings(self):
        item = self._field(1, b"1.25") + self._field(2, b"10")
        body = self._field(1, item)
        msg = self._field(1, b"spot@x") + self._field(4, body)
        top = pb_decode(msg)
        self.assertEqual(top[1][0], b"spot@x")
        inner = pb_decode(top[4][0])
        level = pb_decode(inner[1][0])
        self.assertEqual((level[1][0], level[2][0]), (b"1.25", b"10"))

    def test_truncated_message_raises(self):
        from engine.venues.protobuf import ProtobufError
        with self.assertRaises(ProtobufError):
            pb_decode(self._varint((1 << 3) | 2) + self._varint(50) + b"short")

    def test_mexc_protobuf_depth_frame_is_discovered(self):
        """The structure-first decoder must find levels without a schema."""
        def level(p, q):
            return self._field(1, p.encode()) + self._field(2, q.encode())
        body = (self._field(1, level("101.0", "5"))      # asks
                + self._field(2, level("100.0", "7"))    # bids
                + self._field(3, b"100") + self._field(4, b"101"))
        msg = (self._field(1, b"spot@public.aggre.depth.v3.api.pb@100ms@BTCUSDT")
               + self._field(3, b"BTCUSDT") + self._field(7, body))
        feed = MexcFeed(MEXC, ["BTCUSDT"])
        frames = feed.decode(msg)
        self.assertEqual(len(frames), 1, "protobuf depth frame not decoded")
        f = frames[0]
        self.assertEqual(f.symbol, "BTCUSDT")
        self.assertEqual(f.asks, [(101.0, 5.0)])
        self.assertEqual(f.bids, [(100.0, 7.0)])
        self.assertEqual((f.first_id, f.last_id), (100, 101))


class TestGateWire(unittest.TestCase):
    def test_order_book_update_decodes_with_U_and_u(self):
        from engine.venues.gate import GateFeed
        feed = GateFeed(GATE, {"BTCUSDT": "BTC_USDT"})
        raw = ('{"time":1,"channel":"spot.order_book_update","event":"update",'
               '"result":{"t":1,"s":"BTC_USDT","U":10,"u":14,'
               '"b":[["100.0","1"]],"a":[["101.0","0"]]}}')
        f = feed.decode(raw)[0]
        self.assertEqual(f.symbol, "BTCUSDT")
        self.assertEqual((f.first_id, f.last_id), (10, 14))
        self.assertEqual(f.asks, [(101.0, 0.0)])   # zero = deletion, preserved

    def test_ws_signature_shape(self):
        from engine.venues.gate import ws_signature
        sig = ws_signature("secret", "spot.orders", "subscribe", 1611541000)
        self.assertEqual(len(sig), 128)            # SHA-512 hex


# --------------------------------------------------------------- telemetry

class TestTelemetry(unittest.TestCase):
    def test_survival_tracks_appearance_to_disappearance(self):
        t = SurvivalTracker()
        self.assertEqual(t.observe_batch({"k1": (20.0, "A→B→C")}), [])
        dead = t.observe_batch({})
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]["key"], "k1")
        self.assertGreaterEqual(dead[0]["survivedMs"], 0.0)
        self.assertEqual(t.summary()["observed"], 1)

    def test_peak_bps_is_retained(self):
        t = SurvivalTracker()
        t.observe_batch({"k": (10.0, "p")})
        t.observe_batch({"k": (30.0, "p")})
        t.observe_batch({"k": (12.0, "p")})
        self.assertEqual(t.observe_batch({})[0]["peakBps"], 30.0)

    def test_histogram_percentiles_are_ordered(self):
        h = LatencyHistogram("t")
        for v in range(1, 1001):
            h.record(v * 1000)
        self.assertLessEqual(h.percentile(50), h.percentile(95))
        self.assertLessEqual(h.percentile(95), h.percentile(99))
        self.assertEqual(h.count, 1000)
        self.assertGreater(h.snapshot()["p99Us"], h.snapshot()["p50Us"])

    def test_histogram_ignores_negative_samples(self):
        h = LatencyHistogram("t")
        h.record(-5)
        self.assertEqual(h.count, 0)

    def test_stage_timer_spans(self):
        t = StageTimer()
        t.mark("a")
        t.mark("b")
        spans = t.spans()
        self.assertEqual(set(spans), {"t0->a", "a->b"})
        self.assertGreaterEqual(t.elapsed_ns(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
