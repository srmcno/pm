#!/usr/bin/env python3
"""Unit tests for the Kraken viability trial's pure math."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import krakenarb  # noqa: E402
from krakenarb import (TooSmall, build_cycles, cycle_fee_bps,   # noqa: E402
                       leg_fill, parse_pairs, screen_cycles, verify_cycle)


def pairs_fixture():
    """A tiny Kraken-shaped AssetPairs payload: SOL/USD, SOL/XBT, XBT/USD."""
    return {
        "SOLUSD": {"wsname": "SOL/USD", "status": "online",
                   "fees": [[0, 0.40], [10000, 0.35]],
                   "ordermin": "0.02", "costmin": "0.5"},
        "SOLXBT": {"wsname": "SOL/XBT", "status": "online",
                   "fees": [[0, 0.40]],
                   "ordermin": "0.02", "costmin": "0.00002"},
        "XXBTZUSD": {"wsname": "XBT/USD", "status": "online",
                     "fees": [[0, 0.40]],
                     "ordermin": "0.00005", "costmin": "0.5"},
    }


class TestParsePairs(unittest.TestCase):
    def test_wsname_split_and_fee_fraction(self):
        info = parse_pairs(pairs_fixture())
        self.assertEqual(info["XXBTZUSD"]["base"], "XBT")
        self.assertEqual(info["XXBTZUSD"]["quote"], "USD")
        self.assertAlmostEqual(info["SOLUSD"]["taker"], 0.004)
        self.assertAlmostEqual(info["SOLUSD"]["orderMin"], 0.02)
        self.assertAlmostEqual(info["SOLUSD"]["costMin"], 0.5)

    def test_offline_and_malformed_pairs_are_dropped(self):
        raw = pairs_fixture()
        raw["DEADUSD"] = {"wsname": "DEAD/USD", "status": "cancel_only",
                          "fees": [[0, 0.40]]}
        raw["NOWS"] = {"status": "online", "fees": [[0, 0.40]]}
        info = parse_pairs(raw)
        self.assertNotIn("DEADUSD", info)
        self.assertNotIn("NOWS", info)

    def test_missing_fee_schedule_defaults_conservatively(self):
        raw = {"ABCUSD": {"wsname": "ABC/USD", "status": "online"}}
        info = parse_pairs(raw)
        self.assertAlmostEqual(info["ABCUSD"]["taker"], krakenarb.DEFAULT_TAKER)


class TestCycles(unittest.TestCase):
    def setUp(self):
        self.info = parse_pairs(pairs_fixture())

    def test_both_directions_enumerated(self):
        cycles = build_cycles(self.info)
        paths = {(c[3], c[4]) for c in cycles}
        self.assertIn(("SOL", "XBT"), paths)
        self.assertIn(("XBT", "SOL"), paths)

    def test_fee_hurdle_is_three_legs_compounded(self):
        legs = [["SOLUSD", "buy"], ["SOLXBT", "sell"], ["XXBTZUSD", "sell"]]
        bps = cycle_fee_bps(self.info, legs)
        # 1 - (1-0.004)^3 = ~119.5 bps
        self.assertAlmostEqual(bps, (1 - 0.996 ** 3) * 10_000, places=6)

    def test_screen_finds_a_real_dislocation_net_of_fees(self):
        # XBT at 100k; SOL fairly 200 USD = 0.002 XBT, but SOL/USD asks 197:
        # buy SOL cheap in USD, sell for XBT, sell XBT for USD.
        book = {"SOLUSD": (196.9, 50, 197.0, 50),
                "SOLXBT": (0.002, 50, 0.00201, 50),
                "XXBTZUSD": (100_000.0, 5, 100_010.0, 5)}
        cycles = build_cycles(self.info)
        hits = screen_cycles(cycles, book, self.info, min_bps=1.0)
        self.assertTrue(hits)
        top = hits[0]
        # gross edge ~152bps minus ~120bps of fees leaves ~32bps
        self.assertGreater(top["screenBps"], 20)
        self.assertLess(top["screenBps"], 60)
        self.assertAlmostEqual(top["feeBps"], (1 - 0.996 ** 3) * 10_000, places=1)

    def test_fees_kill_a_thin_dislocation(self):
        # Same books but SOL/USD only ~50bps cheap — under the fee hurdle.
        book = {"SOLUSD": (198.9, 50, 199.0, 50),
                "SOLXBT": (0.002, 50, 0.00201, 50),
                "XXBTZUSD": (100_000.0, 5, 100_010.0, 5)}
        cycles = build_cycles(self.info)
        self.assertEqual(screen_cycles(cycles, book, self.info, min_bps=1.0), [])


class TestLegFill(unittest.TestCase):
    def setUp(self):
        self.meta = {"taker": 0.004, "orderMin": 0.02, "costMin": 0.5}

    def test_buy_walks_asks_net_of_fee(self):
        asks = [(100.0, 1.0), (101.0, 5.0)]
        got = leg_fill([], asks, self.meta, 150.0, "buy")
        # 1.0 @ 100 + ~0.495 @ 101, then 0.4% fee
        self.assertAlmostEqual(got, (1.0 + 50.0 / 101.0) * 0.996, places=6)

    def test_buy_below_cost_minimum_raises_too_small(self):
        asks = [(100.0, 10.0)]
        with self.assertRaises(TooSmall):
            leg_fill([], asks, self.meta, 0.4, "buy")

    def test_buy_result_below_volume_minimum_raises_too_small(self):
        meta = dict(self.meta, orderMin=1.0)
        asks = [(100.0, 10.0)]
        with self.assertRaises(TooSmall):
            leg_fill([], asks, meta, 50.0, "buy")

    def test_sell_below_volume_minimum_raises_too_small(self):
        bids = [(100.0, 10.0)]
        with self.assertRaises(TooSmall):
            leg_fill(bids, [], self.meta, 0.01, "sell")

    def test_thin_book_is_not_a_fill(self):
        asks = [(100.0, 0.5)]
        self.assertIsNone(leg_fill([], asks, self.meta, 100.0, "buy"))

    def test_buy_minimum_checks_gross_volume_not_fee_net(self):
        # Gross order volume is 1.0, exactly at the minimum; the venue
        # validates the submitted volume before fees, so the 0.996 net
        # receipt must not read as a rejection.
        meta = dict(self.meta, orderMin=1.0)
        asks = [(100.0, 10.0)]
        got = leg_fill([], asks, meta, 100.0, "buy")
        self.assertAlmostEqual(got, 1.0 * 0.996)

    def test_sell_minimum_checks_gross_notional_not_fee_net(self):
        # Gross proceeds 100 clear a 99.8 cost minimum even though the
        # fee-net receipt (99.6) is below it.
        meta = dict(self.meta, costMin=99.8)
        bids = [(100.0, 10.0)]
        got = leg_fill(bids, [], meta, 1.0, "sell")
        self.assertAlmostEqual(got, 100.0 * 0.996)


class TestVerifyCycle(unittest.TestCase):
    def test_depth_walk_confirms_and_sizes_the_edge(self):
        info = parse_pairs(pairs_fixture())
        books = {
            "SOLUSD": ([(196.9, 100.0)], [(197.0, 100.0)]),
            "SOLXBT": ([(0.002, 100.0)], [(0.00201, 100.0)]),
            "XXBTZUSD": ([(100_000.0, 1.0)], [(100_010.0, 1.0)]),
        }
        opp = {"legs": [["SOLUSD", "buy"], ["SOLXBT", "sell"],
                        ["XXBTZUSD", "sell"]],
               "path": "USD→SOL→XBT→USD", "screenBps": 30.0, "feeBps": 119.5}
        self.assertTrue(verify_cycle(opp, info, books))
        self.assertIn(opp["sizeUsd"], krakenarb.SIZES)
        self.assertGreater(opp["profitUsd"], 0)
        # Every viable size must respect the $0.5/0.02-SOL leg minimums,
        # so the $5 start size is present (5 USD -> ~0.025 SOL clears both).
        self.assertIn(5.0, opp["viable"])

    def test_venue_minimum_blocks_small_sizes_but_not_larger_ones(self):
        raw = pairs_fixture()
        raw["SOLUSD"]["costmin"] = "15"   # venue demands $15+ per order
        info = parse_pairs(raw)
        books = {
            "SOLUSD": ([(196.9, 100.0)], [(197.0, 100.0)]),
            "SOLXBT": ([(0.002, 100.0)], [(0.00201, 100.0)]),
            "XXBTZUSD": ([(100_000.0, 1.0)], [(100_010.0, 1.0)]),
        }
        opp = {"legs": [["SOLUSD", "buy"], ["SOLXBT", "sell"],
                        ["XXBTZUSD", "sell"]],
               "path": "USD→SOL→XBT→USD", "screenBps": 30.0, "feeBps": 119.5}
        # A too-small rejection at $5 and $10 must not hide the $20 and
        # $40 candidates that clear the venue minimum.
        self.assertTrue(verify_cycle(opp, info, books))
        self.assertNotIn(5.0, opp.get("viable", {}))
        self.assertNotIn(10.0, opp.get("viable", {}))
        self.assertIn(20.0, opp["viable"])
        self.assertIn(40.0, opp["viable"])

    def test_thin_book_still_ends_the_size_ladder(self):
        info = parse_pairs(pairs_fixture())
        books = {
            "SOLUSD": ([(196.9, 100.0)], [(197.0, 0.03)]),   # ~$6 of asks
            "SOLXBT": ([(0.002, 100.0)], [(0.00201, 100.0)]),
            "XXBTZUSD": ([(100_000.0, 1.0)], [(100_010.0, 1.0)]),
        }
        opp = {"legs": [["SOLUSD", "buy"], ["SOLXBT", "sell"],
                        ["XXBTZUSD", "sell"]],
               "path": "USD→SOL→XBT→USD", "screenBps": 30.0, "feeBps": 119.5}
        verify_cycle(opp, info, books)
        self.assertNotIn(10.0, opp.get("viable", {}))
        self.assertNotIn(20.0, opp.get("viable", {}))
        self.assertNotIn(40.0, opp.get("viable", {}))


class TestReplayMath(unittest.TestCase):
    def test_one_scan_delay_repricing(self):
        import json
        import tempfile
        info = parse_pairs(pairs_fixture())
        with tempfile.TemporaryDirectory() as td:
            old = krakenarb.HIST_DIR
            krakenarb.HIST_DIR = td
            try:
                rows = [
                    {"t": 1000, "verified": [
                        {"path": "USD→SOL→XBT→USD",
                         "legs": [["SOLUSD", "buy"], ["SOLXBT", "sell"],
                                  ["XXBTZUSD", "sell"]],
                         "sizeUsd": 10.0, "profitUsd": 0.05}],
                     "tops": {}},
                    {"t": 1030, "verified": [], "tops": {
                        "SOLUSD": [196.9, 197.0],
                        "SOLXBT": [0.002, 0.00201],
                        "XXBTZUSD": [100_000.0, 100_010.0]}},
                ]
                with open(os.path.join(td, "20260813.jsonl"), "w") as f:
                    for r in rows:
                        f.write(json.dumps(r) + "\n")
                r = krakenarb.replay_backtest(info)
            finally:
                krakenarb.HIST_DIR = old
        self.assertEqual(r["edges"], 1)
        self.assertEqual(r["refillable"], 1)
        self.assertAlmostEqual(r["atomicUsd"], 0.05)
        # Delayed leg math: 10/197 SOL -> XBT at 0.002 -> USD at 100k,
        # each leg net of 0.4%.
        expect = 10.0 / 197.0 * 0.996 * 0.002 * 0.996 * 100_000.0 * 0.996 - 10.0
        self.assertAlmostEqual(r["delayedUsd"], round(expect, 4), places=4)


if __name__ == "__main__":
    unittest.main(verbosity=1)
