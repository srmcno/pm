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

    def test_uncalibrated_still_stakes_when_a_fee_makes_kelly_negative(self):
        """The bootstrap path must not be pre-empted by the no-edge return.

        Uncalibrated means w == price, so any fee drives f* below zero. If
        that short-circuits first, nothing ever trades, no signal ever
        settles, lambda is never fitted, and the engine cannot leave its
        initial state — a deadlock, not caution.
        """
        cfg = self.cfg
        pf = Portfolio(cash=1000.0, positions=[])
        d = size_position(0.50, 0.50, 0.50, pf, cfg, entry_fee=0.0125,
                          calibrated=False)
        self.assertGreater(d.stake, 0)
        self.assertIn("bootstrap", d.binding)

    def test_calibrated_no_edge_is_still_refused(self):
        cfg = self.cfg
        pf = Portfolio(cash=1000.0, positions=[])
        d = size_position(0.50, 0.50, 0.50, pf, cfg, entry_fee=0.0125,
                          calibrated=True)
        self.assertEqual(d.stake, 0)
        self.assertIn("no edge", d.binding)

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

    def test_patient_exit_rests_strictly_above_the_bid(self):
        """A patient sell is sent post_only; resting AT the bid is marketable
        and the venue rejects it, so the position silently never leaves."""
        d = ExitDecision("sell", "test", urgent=False)
        o = exit_order(d, mark=0.40, best_bid=0.39, cfg=self.cfg, tick=0.01)
        self.assertEqual(o["style"], "join")
        self.assertGreater(o["limit"], 0.39)


class TestEngineIngest(unittest.TestCase):
    """The average-entry price the drift guard subtracts."""

    def _engine(self):
        from pmx.engine import ConsensusEngine
        prof = {"profiles": {"0xa": {"name": "A", "excluded": False,
                                     "medianTradeUsd": 100.0}}}
        return ConsensusEngine(EngineConfig(), prof, resolver=object())

    def test_average_entry_is_dollars_over_shares(self):
        """10 shares at 20c and 10 at 80c average 50c, not 68c.

        Dollar-weighting each price biases toward the expensive fills, which
        overstates the backers' entry, understates drift, and lets a chased
        price through the guard.
        """
        from pmx.feed import Fill
        eng = self._engine()
        eng.ingest([
            Fill(wallet="0xa", timestamp=1, token_id="t", side="BUY",
                 price=0.20, shares=10, usdc=2.0, source="rest",
                 condition_id="c", outcome_index=0, title="x"),
            Fill(wallet="0xa", timestamp=2, token_id="t", side="BUY",
                 price=0.80, shares=10, usdc=8.0, source="rest",
                 condition_id="c", outcome_index=0, title="x"),
        ])
        s = eng.window["0xa"][("c", 0)]
        self.assertAlmostEqual(s["bought"] / s["shares"], 0.50, places=6)


class TestSettleDeduplication(unittest.TestCase):
    """One settled outcome must yield exactly one calibration observation."""

    def _journal(self, lines):
        import tempfile
        fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
        for r in lines:
            fh.write(__import__("json").dumps(r) + "\n")
        fh.close()
        return fh.name

    def test_legacy_three_element_settled_keys_still_match(self):
        """settled.json once held (conditionId, outcomeIndex, signalTime).

        Probing that file with the new two-element key would match nothing,
        so every market settled by the older code would be recorded a second
        time on upgrade — reintroducing the duplication the key change was
        made to prevent.
        """
        legacy = [["0xabc", 1, 1786600000], ["0xdef", 0, 1786600100]]
        seen = {tuple(k)[:2] for k in legacy}
        self.assertIn(("0xabc", 1), seen)
        self.assertIn(("0xdef", 0), seen)
        # And the new two-element form still round-trips unchanged.
        self.assertEqual({tuple(k)[:2] for k in [["0xabc", 1]]}, {("0xabc", 1)})

    def test_repeated_journal_lines_collapse_to_the_earliest(self):
        """A signal re-journalled by each 2-hour shift is still ONE
        observation, priced at the moment the engine first decided.

        Keying on the journal timestamp instead would weight a long-lived
        signal in proportion to how many shifts it survived, biasing the
        lambda that controls Kelly sizing.
        """
        import json as J
        path = self._journal([
            {"t": 300, "action": "SIGNAL", "conditionId": "0xabc",
             "outcomeIndex": 1, "sigma": 1.1, "currentPrice": 0.61},
            {"t": 100, "action": "SIGNAL", "conditionId": "0xabc",
             "outcomeIndex": 1, "sigma": 0.9, "currentPrice": 0.55},
            {"t": 200, "action": "SIGNAL", "conditionId": "0xabc",
             "outcomeIndex": 1, "sigma": 1.0, "currentPrice": 0.58},
            {"t": 150, "action": "SIGNAL", "conditionId": "0xdef",
             "outcomeIndex": 0, "sigma": 1.4, "currentPrice": 0.30},
        ])
        first = {}
        with open(path) as f:
            for line in f:
                r = J.loads(line)
                if r.get("action") != "SIGNAL" or r.get("conditionId") is None:
                    continue
                k = (r["conditionId"], r["outcomeIndex"])
                if k not in first or r["t"] < first[k]["t"]:
                    first[k] = r
        os.unlink(path)
        self.assertEqual(len(first), 2)
        self.assertEqual(first[("0xabc", 1)]["t"], 100)
        self.assertEqual(first[("0xabc", 1)]["currentPrice"], 0.55)


class TestSeedFeedOverlap(unittest.TestCase):
    """Seeded fills must dedupe against the live poll that re-reads them."""

    def _fill(self, **kw):
        from pmx.feed import Fill
        base = dict(wallet="0xA", timestamp=100, token_id="tok1", side="BUY",
                    price=0.4, shares=10.0, usdc=4.0, source="rest",
                    tx="0xTX", condition_id="0xc", outcome_index=0, title="t")
        base.update(kw)
        return Fill(**base)

    def test_seed_and_poll_of_the_same_fill_share_a_key(self):
        """The seed used to leave token_id empty, so the same fill arriving
        from the poll looked different and was counted into the wallet's
        stance twice."""
        self.assertEqual(self._fill(source="rest").key,
                         self._fill(source="chain").key)

    def test_blank_token_id_breaks_the_match(self):
        self.assertNotEqual(self._fill(token_id="").key, self._fill().key)

    def test_dualfeed_remember_suppresses_a_repeat(self):
        from pmx.feed import DualFeed
        f = DualFeed(set(), rpc_url=None)
        self.assertTrue(f.remember(self._fill()))
        self.assertFalse(f.remember(self._fill()))
        self.assertEqual(f.stats["duplicates"], 1)

    def test_prime_accepts_an_explicit_timestamp(self):
        """Priming must be able to rewind to before the seed started."""
        from pmx.feed import DataApiFeed
        d = DataApiFeed({"0xa", "0xb"})
        d.prime(at=12345)
        self.assertEqual(set(d.last_ts.values()), {12344})

    def test_prime_leaves_the_boundary_second_readable(self):
        """`_one` stops at `ts <= since`, so priming to int(at) would make a
        fill stamped in that same second unreachable forever — missing from
        the seed and from every later poll."""
        from pmx.feed import DataApiFeed
        d = DataApiFeed({"0xa"})
        seed_started = 1786620000.7
        d.prime(at=seed_started)
        boundary_fill_ts = int(seed_started)          # 1786620000
        self.assertGreater(boundary_fill_ts, d.last_ts["0xa"],
                           "boundary second must still be re-read")


class TestEnrichedDetail(unittest.TestCase):
    def test_enrich_carries_the_slugs_the_site_links_from(self):
        """The dashboard's Open link is built from slug/eventSlug; without
        them in the enriched detail every published signal points nowhere."""
        from pmx.engine import Candidate, ConsensusEngine

        class FakeResolver:
            def get(self, cid):
                return {"question": "Q?", "outcomes": ["Yes", "No"],
                        "outcomePrices": [0.4, 0.6],
                        "clobTokenIds": ["t0", "t1"], "closed": False,
                        "slug": "a-market", "eventSlug": "an-event",
                        "endDate": "2099-01-01T00:00:00Z"}

        eng = ConsensusEngine(EngineConfig(), {"profiles": {}},
                              resolver=FakeResolver())
        c = Candidate(condition_id="0xc", outcome_index=0, category="Sports",
                      title="Q?", sigma=1.0, n_eff=2.0,
                      backers=[{"value": 1.0, "avgPrice": 0.40}])
        kept = eng.enrich([c], max_days=None)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].detail["slug"], "a-market")
        self.assertEqual(kept[0].detail["eventSlug"], "an-event")


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
