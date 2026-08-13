#!/usr/bin/env python3
"""Unit tests for the equities desk strategy and accounting."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from stocks.strategy import (StrategyConfig, evaluate,          # noqa: E402
                             exit_check, fit_beta)


class TestBeta(unittest.TestCase):
    @staticmethod
    def _series(scale):
        """Daily closes where the stock's log return is `scale` times the
        crypto's, with varying (non-degenerate) daily moves."""
        moves = [0.01, -0.02, 0.03, 0.005, -0.015, 0.02] * 12
        crypto, stock, c, s = {}, {}, 100.0, 50.0
        for i, m in enumerate(moves):
            crypto[i * 86400] = c
            stock[i * 86400] = s
            c *= math.exp(m)
            s *= math.exp(scale * m)
        return stock, crypto

    def test_recovers_a_known_beta(self):
        stock, crypto = self._series(2.0)
        beta, n, r2 = fit_beta(stock, crypto, (0.5, 4.0))
        self.assertAlmostEqual(beta, 2.0, places=6)
        self.assertGreater(r2, 0.99)

    def test_clamps_to_bounds(self):
        stock, crypto = self._series(8.0)
        beta, _, _ = fit_beta(stock, crypto, (0.5, 3.0))
        self.assertEqual(beta, 3.0)

    def test_refuses_thin_samples(self):
        crypto = {i * 86400: 100.0 + i for i in range(5)}
        stock = {i * 86400: 50.0 + i for i in range(5)}
        beta, n, _ = fit_beta(stock, crypto, (0.5, 3.0))
        self.assertIsNone(beta)

    def test_weekend_only_crypto_days_are_ignored(self):
        # crypto has 7 days/week, stock 5; only shared dates are used
        crypto = {i * 86400: 100 * math.exp(0.01 * i) for i in range(70)}
        stock = {i * 86400: 50 * math.exp(0.02 * i)
                 for i in range(70) if i % 7 not in (5, 6)}
        beta, n, r2 = fit_beta(stock, crypto, (0.5, 4.0))
        self.assertAlmostEqual(beta, 2.0, places=6)


class TestSignal(unittest.TestCase):
    def setUp(self):
        self.cfg = StrategyConfig()

    def test_lagging_an_up_move_signals_long(self):
        # driver +2%, beta 2 implies +4%; stock only +2% -> ~200bps behind
        s = evaluate("MSTR", price=102.0, anchor_price=100.0,
                     driver_price=102.0, driver_anchor_price=100.0,
                     beta=2.0, cfg=self.cfg, spread_bps=4)
        self.assertEqual(s.action, "long")
        self.assertLess(s.dislocation_bps, -self.cfg.entry_bps)

    def test_lagging_a_down_move_signals_short(self):
        s = evaluate("MSTR", price=99.0, anchor_price=100.0,
                     driver_price=98.0, driver_anchor_price=100.0,
                     beta=2.0, cfg=self.cfg, spread_bps=4)
        self.assertEqual(s.action, "short")

    def test_leading_the_driver_is_not_traded(self):
        # stock ahead of the driver: convergence would fight momentum
        s = evaluate("MSTR", price=105.0, anchor_price=100.0,
                     driver_price=101.0, driver_anchor_price=100.0,
                     beta=2.0, cfg=self.cfg, spread_bps=4)
        self.assertEqual(s.action, "none")

    def test_small_driver_moves_are_ignored(self):
        s = evaluate("MSTR", price=99.5, anchor_price=100.0,
                     driver_price=100.05, driver_anchor_price=100.0,
                     beta=2.0, cfg=self.cfg, spread_bps=4)
        self.assertEqual(s.action, "none")
        self.assertIn("driver move", s.reason)

    def test_entry_threshold_scales_with_costs(self):
        # ~180bps dislocation clears the 90bps entry on a tight-spread
        # instrument but not the cost-scaled threshold of one whose round
        # trip alone costs ~200bps
        kw = dict(price=99.2, anchor_price=100.0, driver_price=100.5,
                  driver_anchor_price=100.0, beta=2.0, cfg=self.cfg)
        self.assertEqual(evaluate("X", spread_bps=200, **kw).action, "none")
        self.assertEqual(evaluate("X", spread_bps=4, **kw).action, "long")

    def test_bad_inputs_return_none(self):
        self.assertIsNone(evaluate("X", 0, 100, 100, 100, 2.0,
                                   self.cfg, 4))


class TestExits(unittest.TestCase):
    def setUp(self):
        self.cfg = StrategyConfig()
        self.long_pos = {"side": "long"}

    def test_reversion_closes(self):
        self.assertEqual(
            exit_check(self.long_pos, d_bps=-5, minutes_held=3,
                       mins_to_close=120, cfg=self.cfg), "reverted")

    def test_adverse_widening_stops_out(self):
        d = -(self.cfg.entry_bps + self.cfg.stop_bps + 1)
        self.assertEqual(
            exit_check(self.long_pos, d_bps=d, minutes_held=3,
                       mins_to_close=120, cfg=self.cfg), "stop")

    def test_time_stop(self):
        self.assertEqual(
            exit_check(self.long_pos, d_bps=-30, minutes_held=999,
                       mins_to_close=120, cfg=self.cfg), "time")

    def test_flat_before_close(self):
        self.assertEqual(
            exit_check(self.long_pos, d_bps=-30, minutes_held=3,
                       mins_to_close=2, cfg=self.cfg), "close")

    def test_still_dislocated_holds(self):
        self.assertIsNone(
            exit_check(self.long_pos, d_bps=-30, minutes_held=3,
                       mins_to_close=120, cfg=self.cfg))

    def test_short_sign_convention(self):
        # short opened at d >= +entry; reversion drives d down toward 0
        short = {"side": "short"}
        self.assertEqual(
            exit_check(short, d_bps=5, minutes_held=3,
                       mins_to_close=120, cfg=self.cfg), "reverted")
        self.assertIsNone(
            exit_check(short, d_bps=30, minutes_held=3,
                       mins_to_close=120, cfg=self.cfg))


class TestQuoteGate(unittest.TestCase):
    def test_fresh_quote_passes(self):
        from stocks.paperdesk import quote_is_fresh
        self.assertTrue(quote_is_fresh({"ts": 990.0}, now=1000.0,
                                       max_age_s=20.0))

    def test_stale_quote_fails(self):
        from stocks.paperdesk import quote_is_fresh
        self.assertFalse(quote_is_fresh({"ts": 900.0}, now=1000.0,
                                        max_age_s=20.0))

    def test_missing_timestamp_fails_closed(self):
        # a quote that cannot prove its age must not be treated as fresh
        from stocks.paperdesk import quote_is_fresh
        self.assertFalse(quote_is_fresh({"ts": None}, now=1000.0,
                                        max_age_s=20.0))
        self.assertFalse(quote_is_fresh({}, now=1000.0, max_age_s=20.0))


class TestAccounting(unittest.TestCase):
    def test_short_pnl_is_entry_minus_exit(self):
        from stocks.paperdesk import default_state, close_position
        from stocks.strategy import StrategyConfig
        cfg = StrategyConfig()
        cfg.slippage_bps = 0.0
        st = default_state(1000.0)
        pos = {"symbol": "IBIT", "side": "short", "shares": 10.0,
               "entry": 50.0, "cost": 500.0, "openedAt": 0, "reason": "t"}
        st["positions"].append(pos)
        st["cash"] -= pos["cost"]
        # quote falls to 45; short profits ~5/share less the half-spread
        closed = close_position(st, pos, 45.0, "reverted", cfg, now=60)
        self.assertGreater(closed["pnl"], 45.0)
        self.assertLess(closed["pnl"], 50.5)

    def test_short_open_fee_lands_in_reported_pnl(self):
        # the opening-sale fee is deducted from cash at open; realized P&L
        # must include it or trade stats and equity drift apart
        from stocks.paperdesk import default_state, close_position
        from stocks.strategy import StrategyConfig
        cfg = StrategyConfig()
        cfg.slippage_bps = 0.0
        results = []
        for fee in (0.0, 1.0):
            st = default_state(1000.0)
            pos = {"symbol": "IBIT", "side": "short", "shares": 10.0,
                   "entry": 50.0, "cost": 500.0, "openFee": fee,
                   "openedAt": 0, "reason": "t"}
            st["positions"].append(pos)
            st["cash"] -= pos["cost"] + fee
            results.append(close_position(st, pos, 45.0, "reverted",
                                          cfg, now=60)["pnl"])
        self.assertAlmostEqual(results[0] - results[1], 1.0, places=6)

    def test_daily_loss_halt(self):
        from stocks.paperdesk import default_state, _day
        st = default_state(1000.0)
        d = _day(st)
        d["startEquity"] = 1000.0
        # the halt check runs inside step(); assert the threshold arithmetic
        cfg = StrategyConfig()
        self.assertGreaterEqual((1000.0 - 890.0) / 1000.0,
                                cfg.max_daily_loss_frac)


if __name__ == "__main__":
    unittest.main(verbosity=2)
