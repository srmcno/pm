#!/usr/bin/env python3
"""Unit tests for the consensus engine.

Run: python3 -m unittest discover -s scripts/tests -v

These cover the arithmetic that decides how much money moves, plus the three
venue quirks that were verified against live Polymarket data and that silently
produce catastrophic answers when handled naively: order book side ordering,
the outcomeIndex sentinel, and the on-chain event layout.
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from pmx import fees                                          # noqa: E402
from pmx.book import Book, round_to_tick                      # noqa: E402
from pmx.calibrate import calibrate, fit_lambda               # noqa: E402
from pmx.config import EngineConfig                           # noqa: E402
from pmx.consensus import (beta_shrink, drift_check, effective_backers,  # noqa: E402
                           expit, implied_win_probability, logit,
                           passes_consensus, vote_value, vote_weight)
from pmx.exits import (ExitDecision, annualized_hold_return,  # noqa: E402
                       captured_fraction, consensus_reversal, exit_order,
                       take_profit)
from pmx.feed import decode_order_filled, resolve_outcome_index  # noqa: E402
from pmx.sizing import (Portfolio, correlation_haircut,       # noqa: E402
                        kelly_fraction, min_viable_bankroll, size_position)


class TestKelly(unittest.TestCase):
    def test_reduces_to_the_specified_formula(self):
        """f* = (w-p)/(1-p) is the zero-cost case of the general form."""
        for w, p in [(0.60, 0.50), (0.95, 0.90), (0.30, 0.20), (0.55, 0.50)]:
            self.assertAlmostEqual(kelly_fraction(w, p, 0.0),
                                   (w - p) / (1 - p), places=9)

    def test_costs_shrink_the_bet(self):
        naive = kelly_fraction(0.95, 0.90, 0.0)
        costed = kelly_fraction(0.95, 0.91, 0.01)
        self.assertLess(costed, naive)
        self.assertGreater(naive / costed, 1.2)   # ~31% oversize if ignored

    def test_no_edge_means_no_bet(self):
        self.assertEqual(kelly_fraction(0.50, 0.50), 0.0)
        self.assertEqual(kelly_fraction(0.40, 0.50), 0.0)   # never negative

    def test_cost_above_payout_is_refused(self):
        self.assertEqual(kelly_fraction(0.99, 1.00, 0.02), 0.0)

    def test_correlation_haircut_halves_the_third_leg(self):
        self.assertEqual(correlation_haircut(0), 1.0)
        self.assertAlmostEqual(correlation_haircut(2, rho=0.5), 0.5)


class TestConsensus(unittest.TestCase):
    def test_effective_backers_blocks_a_lone_whale(self):
        self.assertAlmostEqual(effective_backers([1, 1, 1]), 3.0)
        self.assertLess(effective_backers([10, 0.1, 0.1]), 1.1)

    def test_threshold_needs_both_sum_and_spread(self):
        cfg = EngineConfig().consensus
        # A single vote large enough to clear Theta still fails on N_eff.
        ok, reasons = passes_consensus(sigma=5.0, n_eff=1.02, n_backers=3,
                                       cfg=cfg)
        self.assertFalse(ok)
        self.assertTrue(any("N_eff" in r for r in reasons))
        ok, _ = passes_consensus(sigma=2.0, n_eff=2.4, n_backers=3, cfg=cfg)
        self.assertTrue(ok)

    def test_beta_shrink_pulls_small_samples_to_the_prior(self):
        # 4 wins from 5 is not an 80% trader.
        self.assertLess(beta_shrink(4, 5, 0.55, 25), 0.62)
        # 400 from 500 is.
        self.assertGreater(beta_shrink(400, 500, 0.55, 25), 0.76)

    def test_vote_decays_with_age(self):
        cfg = EngineConfig().consensus
        fresh = vote_value(1.0, 2.0, 0.0, cfg)
        old = vote_value(1.0, 2.0, cfg.vote_half_life_h, cfg)
        self.assertAlmostEqual(old, fresh / 2, places=6)
        self.assertEqual(vote_value(1.0, 2.0, cfg.max_vote_age_h + 1, cfg), 0.0)

    def test_robust_weight_is_bounded(self):
        cfg = EngineConfig().weights
        prof = {"pnl90": 50e6, "sharpe": 99.0, "pnlDays": 90,
                "categoryShare": {"Sports": 1.0}, "_specialty_min_share": 0.0,
                "categories": {"Sports": {"settledTrades": 900, "wins": 900,
                                          "roi": 5.0, "cohortWinRate": 0.5,
                                          "cohortRoi": 0.0}}}
        self.assertLessEqual(vote_weight(prof, "Sports", cfg), 1.0)

    def test_raw_mode_has_no_answer_for_a_losing_wallet(self):
        cfg = EngineConfig().weights
        cfg.mode = "raw"
        prof = {"pnl90": -1000.0, "sharpe": 2.0, "pnlDays": 90,
                "categoryShare": {"Sports": 1.0}, "_specialty_min_share": 0.0,
                "categories": {"Sports": {"settledTrades": 50, "wins": 30}}}
        self.assertIsNone(vote_weight(prof, "Sports", cfg))

    def test_specialty_gate_silences_a_tourist(self):
        cfg = EngineConfig().weights
        prof = {"pnl90": 1e6, "sharpe": 3.0, "pnlDays": 90,
                "categoryShare": {"Politics": 0.02},
                "_specialty_min_share": 0.35,
                "categories": {"Politics": {"settledTrades": 90, "wins": 60,
                                            "roi": 0.2, "cohortWinRate": 0.5,
                                            "cohortRoi": 0.0}}}
        self.assertIsNone(vote_weight(prof, "Politics", cfg))


class TestDrift(unittest.TestCase):
    def setUp(self):
        self.cfg = EngineConfig().execution

    def test_exactly_at_the_limit_passes(self):
        ok, _ = drift_check(0.53, 0.50, self.cfg)
        self.assertTrue(ok)

    def test_absolute_rule_rejects_a_move(self):
        ok, _ = drift_check(0.56, 0.50, self.cfg)
        self.assertFalse(ok)

    def test_logit_rule_catches_what_absolute_misses(self):
        """2c on a nickel is a 40% move; the absolute rule waves it through."""
        ok, d = drift_check(0.07, 0.05, self.cfg)
        self.assertLess(d["drift"], self.cfg.max_drift_abs)
        self.assertGreater(d["driftLogit"], self.cfg.max_drift_logit)
        self.assertFalse(ok)

    def test_a_move_in_our_favour_is_never_rejected(self):
        ok, _ = drift_check(0.40, 0.50, self.cfg)
        self.assertTrue(ok)


class TestProbability(unittest.TestCase):
    def test_uncalibrated_claims_no_edge(self):
        cfg = EngineConfig().probability
        w, calibrated = implied_win_probability(0.62, 3.0, cfg)
        self.assertEqual(w, 0.62)
        self.assertFalse(calibrated)

    def test_thin_sample_is_treated_as_uncalibrated(self):
        cfg = EngineConfig().probability
        cfg.lam, cfg.lam_sample_size = 0.5, 10
        w, calibrated = implied_win_probability(0.62, 3.0, cfg)
        self.assertFalse(calibrated)
        self.assertEqual(w, 0.62)

    def test_edge_is_capped(self):
        cfg = EngineConfig().probability
        cfg.lam, cfg.lam_sample_size = 5.0, 1000
        w, calibrated = implied_win_probability(0.50, 9.0, cfg, theta=1.35)
        self.assertTrue(calibrated)
        self.assertLessEqual(w - 0.50, cfg.max_edge + 1e-9)


class TestCalibration(unittest.TestCase):
    @staticmethod
    def _synth(n, lam, seed, theta=1.35):
        random.seed(seed)
        out = []
        for i in range(n):
            p = random.uniform(0.15, 0.90)
            sigma = random.uniform(0.8, 3.5)
            w = expit(logit(p) + lam * (sigma - theta))
            out.append({"t": i, "price": p, "sigma": sigma,
                        "won": 1 if random.random() < w else 0})
        return out

    def test_recovers_a_real_lambda(self):
        lam, _ = fit_lambda(self._synth(3000, 0.40, 11), 1.35, 1.0)
        self.assertGreater(lam, 0.25)
        self.assertLess(lam, 0.6)

    def test_refuses_pure_noise(self):
        """The gate must not accept an edge that is not there."""
        for seed in (1, 2, 3, 4):
            rep = calibrate(self._synth(600, 0.0, seed), 1.35)
            self.assertFalse(rep["beatsMarketOutOfSample"],
                             f"accepted noise on seed {seed}")

    def test_accepts_a_strong_edge(self):
        rep = calibrate(self._synth(1500, 0.40, 5), 1.35)
        self.assertTrue(rep["beatsMarketOutOfSample"])
        self.assertGreaterEqual(rep["tStat"], 2.0)


class TestFees(unittest.TestCase):
    def test_uses_the_published_curve(self):
        """fee = rate * p * (1-p), not rate * min(p, 1-p)."""
        self.assertAlmostEqual(fees.fee_per_share(0.5, 0.05), 0.05 * 0.25)

    def test_is_symmetric_about_the_midpoint(self):
        self.assertAlmostEqual(fees.fee_per_share(0.3, 0.05),
                               fees.fee_per_share(0.7, 0.05))

    def test_vanishes_at_the_extremes(self):
        self.assertAlmostEqual(fees.fee_per_share(0.0, 0.05), 0.0)
        self.assertAlmostEqual(fees.fee_per_share(1.0, 0.05), 0.0)

    def test_category_rates(self):
        self.assertEqual(fees.taker_rate("Crypto"), 0.07)
        self.assertEqual(fees.taker_rate("Politics"), 0.04)
        self.assertEqual(fees.taker_rate("Geopolitics"), 0.0)
        self.assertEqual(fees.taker_rate("NoSuchCategory"), 0.05)

    def test_holding_to_resolution_pays_no_exit_fee(self):
        held = fees.round_trip_fee(0.9, 1.0, 0.05, exit_is_taker=False)
        sold = fees.round_trip_fee(0.9, 0.96, 0.05, exit_is_taker=True)
        self.assertLess(held, sold)


class TestBook(unittest.TestCase):
    # Real shape: bids ascending, asks DESCENDING (verified live).
    RAW = {"bids": [{"price": "0.001", "size": "2000000"},
                    {"price": "0.170", "size": "3000"}],
           "asks": [{"price": "0.999", "size": "3000000"},
                    {"price": "0.171", "size": "2000"}],
           "tick_size": "0.001", "min_order_size": "5", "neg_risk": False}

    def test_top_of_book_is_not_index_zero(self):
        b = Book.parse(self.RAW)
        self.assertEqual(b.best_bid, 0.170)
        self.assertEqual(b.best_ask, 0.171)
        # The naive read would have been 0.999 — an 82c error.
        self.assertNotEqual(b.best_ask, float(self.RAW["asks"][0]["price"]))

    def test_spread_and_mid(self):
        b = Book.parse(self.RAW)
        self.assertAlmostEqual(b.spread, 0.001, places=6)
        self.assertAlmostEqual(b.mid, 0.1705, places=6)

    def test_depth_walk_stays_inside_the_limit(self):
        b = Book.parse(self.RAW)
        w = b.walk(100.0, limit_price=0.171, side="buy")
        self.assertTrue(w["complete"])
        self.assertAlmostEqual(w["avgPrice"], 0.171, places=6)

    def test_walk_reports_shortfall_rather_than_overpaying(self):
        b = Book.parse(self.RAW)
        w = b.walk(1000.0, limit_price=0.171, side="buy")   # only $342 there
        self.assertFalse(w["complete"])
        self.assertGreater(w["shortfall"], 0)

    def test_crossed_book_is_detected(self):
        b = Book.parse({"bids": [{"price": "0.5", "size": "10"}],
                        "asks": [{"price": "0.4", "size": "10"}]})
        self.assertTrue(b.is_crossed())

    def test_tick_rounding_never_pays_more(self):
        self.assertEqual(round_to_tick(0.2345, 0.001, "down"), 0.234)
        self.assertEqual(round_to_tick(0.2345, 0.01, "down"), 0.23)
        self.assertEqual(round_to_tick(0.2311, 0.01, "up"), 0.24)


class TestFeed(unittest.TestCase):
    def test_repairs_the_outcome_index_sentinel(self):
        """The global feed emits outcomeIndex 999, which is not an index."""
        t = {"outcomeIndex": 999, "outcome": "Down"}
        self.assertEqual(resolve_outcome_index(t, ["Up", "Down"]), 1)

    def test_keeps_a_valid_index(self):
        self.assertEqual(
            resolve_outcome_index({"outcomeIndex": 0, "outcome": "Up"},
                                  ["Up", "Down"]), 0)

    def test_returns_none_when_unresolvable(self):
        self.assertIsNone(
            resolve_outcome_index({"outcomeIndex": 999, "outcome": "Maybe"},
                                  ["Up", "Down"]))

    def test_decodes_a_real_order_filled_log(self):
        """Layout: side, tokenId, makerAmt, takerAmt, fee, builder, metadata."""
        log = {
            "topics": [
                "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
                "0x" + "11" * 32,
                "0x" + "00" * 12 + "a3338de30e1c60f4d1f4dc0e0f0e0d0c0b0a0908",
                "0x" + "00" * 12 + "e111180000d2663c0091e4f400237545b87b996b",
            ],
            "data": "0x" + "".join([
                f"{0:064x}",           # side = BUY
                f"{12345:064x}",       # tokenId
                f"{2_500_000:064x}",   # makerAmountFilled  = 2.50 USDC
                f"{10_000_000:064x}",  # takerAmountFilled  = 10.00 shares
                f"{0:064x}",           # fee
                f"{0:064x}", f"{0:064x}",
            ]),
            "transactionHash": "0xdead", "blockNumber": "0x1",
        }
        d = decode_order_filled(log)
        self.assertEqual(d["side"], "BUY")
        self.assertAlmostEqual(d["price"], 0.25)
        self.assertAlmostEqual(d["shares"], 10.0)
        self.assertAlmostEqual(d["usdc"], 2.50)
        self.assertEqual(d["wallet"], "0xa3338de30e1c60f4d1f4dc0e0f0e0d0c0b0a0908")


class TestSizing(unittest.TestCase):
    def setUp(self):
        self.cfg = EngineConfig().sizing

    def test_bankroll_includes_open_positions(self):
        pf = Portfolio(cash=10.0, positions=[{"value": 30.0}])
        self.assertEqual(pf.bankroll, 40.0)

    def test_min_viable_bankroll_is_100x_price_at_a_5pct_cap(self):
        self.assertAlmostEqual(min_viable_bankroll(0.56, self.cfg), 56.0)
        self.assertAlmostEqual(min_viable_bankroll(0.90, self.cfg), 90.0)

    def test_cash_reserve_floor_binds(self):
        """With 20% reserved on a $1000 book, $201 of cash leaves $1 usable —
        tighter than the $4 per-trade cap, so the reserve is what stops it."""
        cfg = self.cfg
        pf = Portfolio(cash=201.0, positions=[{"value": 799.0}])
        d = size_position(0.70, 0.50, 0.50, pf, cfg)
        self.assertIn("cash reserve", d.binding)
        self.assertEqual(d.stake, 0)

    def test_uncalibrated_forces_the_flat_minimum(self):
        cfg = self.cfg
        pf = Portfolio(cash=1000.0, positions=[])
        d = size_position(0.80, 0.20, 0.20, pf, cfg, calibrated=False)
        self.assertLessEqual(d.stake, cfg.min_stake_usd + 0.01)

    def test_names_the_binding_rail(self):
        pf = Portfolio(cash=1000.0, positions=[])
        d = size_position(0.90, 0.20, 0.20, pf, self.cfg)
        self.assertTrue(d.binding)
        self.assertGreater(d.stake, 0)

    def test_depth_participation_caps_the_order(self):
        cfg = self.cfg
        cfg.bankroll = 10_000.0
        pf = Portfolio(cash=10_000.0, positions=[])
        d = size_position(0.90, 0.20, 0.20, pf, cfg, depth_notional=20.0)
        self.assertLessEqual(d.stake, cfg.max_depth_participation * 20.0 + 0.01)


class TestExits(unittest.TestCase):
    def setUp(self):
        self.cfg = EngineConfig().exits

    def test_captured_fraction_matches_the_worked_example(self):
        """Buy at 80c, sell at 96c = 80% of the maximum gain."""
        self.assertAlmostEqual(captured_fraction(0.80, 0.96), 0.80, places=9)

    def test_hard_take_profit_fires(self):
        d = take_profit({"entryPrice": 0.80, "openedAt": 0}, 0.965, 30.0,
                        self.cfg, now=86400)
        self.assertEqual(d.action, "sell")
        self.assertIn("hard take-profit", d.reason)

    def test_imminent_resolution_is_worth_holding(self):
        """94c resolving tomorrow annualizes enormously — do not sell it."""
        d = take_profit({"entryPrice": 0.80, "openedAt": 0}, 0.94, 1.0,
                        self.cfg, now=86400)
        self.assertEqual(d.action, "hold")

    def test_distant_resolution_takes_the_profit(self):
        d = take_profit({"entryPrice": 0.80, "openedAt": 0}, 0.94, 120.0,
                        self.cfg, now=86400)
        self.assertEqual(d.action, "sell")
        self.assertIn("redeploy", d.reason)

    def test_stop_loss_is_in_log_odds(self):
        d = take_profit({"entryPrice": 0.50, "openedAt": 0}, 0.28, 10.0,
                        self.cfg, now=86400)
        self.assertEqual(d.action, "sell")
        self.assertIn("stop-loss", d.reason)

    def test_annualized_hold_return_shape(self):
        self.assertGreater(annualized_hold_return(0.96, 1.0),
                           annualized_hold_return(0.96, 100.0))

    def test_reversal_needs_weight_not_just_headcount(self):
        pos = {"backers": [
            {"wallet": "0xa", "name": "A", "value": 1.0, "netUsd": 1000},
            {"wallet": "0xb", "name": "B", "value": 1.0, "netUsd": 1000},
            {"wallet": "0xc", "name": "C", "value": 0.05, "netUsd": 1000}]}
        # Two tiny backers leaving is not the consensus reversing.
        d = consensus_reversal(pos, {"0xc": 0.0, "0xa": 1000, "0xb": 1000},
                               self.cfg)
        self.assertEqual(d.action, "hold")
        # The two heavy ones leaving is.
        d = consensus_reversal(pos, {"0xa": 0.0, "0xb": 100, "0xc": 1000},
                               self.cfg)
        self.assertEqual(d.action, "sell")
        self.assertTrue(d.urgent)

    def test_profit_taking_is_not_a_reversal(self):
        pos = {"backers": [{"wallet": "0xa", "name": "A", "value": 1.0,
                            "netUsd": 1000},
                           {"wallet": "0xb", "name": "B", "value": 1.0,
                            "netUsd": 1000}]}
        d = consensus_reversal(pos, {"0xa": 800, "0xb": 900}, self.cfg)
        self.assertEqual(d.action, "hold")

    def test_exit_ladders_instead_of_crossing_into_a_hole(self):
        d = ExitDecision("sell", "test", urgent=True)
        o = exit_order(d, mark=0.40, best_bid=0.12, cfg=self.cfg)
        self.assertEqual(o["style"], "ladder")
        self.assertGreaterEqual(o["limit"], 0.40 - self.cfg.max_exit_concession - 0.011)

    def test_urgent_exit_crosses_a_tight_book(self):
        d = ExitDecision("sell", "test", urgent=True)
        o = exit_order(d, mark=0.40, best_bid=0.39, cfg=self.cfg)
        self.assertEqual(o["style"], "cross")


class TestConfig(unittest.TestCase):
    def test_rejects_over_betting(self):
        cfg = EngineConfig()
        cfg.sizing.kelly_fraction = 0.9
        with self.assertRaises(ValueError):
            cfg.validate()

    def test_rejects_a_single_wallet_consensus(self):
        cfg = EngineConfig()
        cfg.consensus.min_effective_backers = 1.0
        with self.assertRaises(ValueError):
            cfg.validate()

    def test_defaults_are_valid(self):
        self.assertIsNotNone(EngineConfig().validate())


if __name__ == "__main__":
    unittest.main(verbosity=2)
