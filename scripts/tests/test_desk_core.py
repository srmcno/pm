#!/usr/bin/env python3
"""Unit tests for the desk framework's foundations.

The tests that matter most here are the lookahead ones. The system this
replaces reported a profitable replay and then lost money live, and the
two mechanisms that let that happen were an optimistic fill model and a
decision path that could see prices it would not have had. Both are pinned
below, because a framework that quietly allows either produces confident
numbers that mean nothing.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from desk.core import money, risk, config                      # noqa: E402
from desk.backtest import metrics                              # noqa: E402
from desk.backtest.engine import Engine                        # noqa: E402
from desk.data.bars import Bar, align, sma                     # noqa: E402
from desk.desks.base import (CLOSE, OPEN, Decision, Desk,      # noqa: E402
                             DeskMeta, View)


def mkbars(closes, opens=None, t0=1_600_000_000, step=86400):
    opens = opens or closes
    return [Bar(t0 + i * step, opens[i], max(opens[i], closes[i]),
                min(opens[i], closes[i]), closes[i], 1000.0)
            for i in range(len(closes))]


# --------------------------------------------------------------- cost model
class TestMoney(unittest.TestCase):
    def test_equity_sell_fees_use_2026_rates(self):
        # 100 shares at $50 = $5,000 of proceeds
        f = money.equity_sell_fees(100, 50.0)
        expect = (5000 * 0.0000206) + (100 * 0.000195) + (100 * 0.000003)
        self.assertAlmostEqual(f, expect, places=9)

    def test_buys_pay_cat_only(self):
        self.assertAlmostEqual(money.equity_buy_fees(100, 50.0), 100 * 0.000003)

    def test_daily_floor_is_three_cents_on_any_active_day(self):
        # A trivially small day of fees still bills $0.03.
        self.assertAlmostEqual(money.daily_fee_floor(0.0001, True), 0.0299)
        self.assertAlmostEqual(money.daily_fee_floor(0.05, True), 0.0)
        self.assertEqual(money.daily_fee_floor(0.0, False), 0.0)

    def test_kalshi_fee_peaks_at_the_money(self):
        mid = money.kalshi_fee(0.50, 1)
        edge = money.kalshi_fee(0.05, 1)
        self.assertGreater(mid, edge)
        self.assertAlmostEqual(mid, 0.0175, places=4)
        self.assertAlmostEqual(money.kalshi_fee(0.90, 1), 0.0063, places=4)

    def test_kalshi_maker_is_free_off_the_economics_series(self):
        self.assertEqual(money.kalshi_fee(0.5, 10, maker=True, series="KXWEATHER"), 0.0)
        self.assertGreater(money.kalshi_fee(0.5, 10, maker=True, series="KXFED"), 0.0)

    def test_auction_is_cheaper_than_crossing_for_equities(self):
        cross = money.execution_cost_bps("SPY", "equity", money.CROSSING)
        auc = money.execution_cost_bps("SPY", "equity", money.AUCTION)
        self.assertLess(auc, cross)

    def test_shorts_never_round_fractional(self):
        self.assertEqual(money.round_shares(3.7, True, "short"), 3.0)
        self.assertAlmostEqual(money.round_shares(3.7, True, "long"), 3.7)
        self.assertEqual(money.round_shares(3.7, False, "long"), 3.0)


# ------------------------------------------------------------ lookahead
class _Spy(Desk):
    """Records exactly what it was shown at each decision."""
    meta = DeskMeta(name="_spy", title="spy", asset_class="equity",
                    venue="alpaca", events=(OPEN, CLOSE), universe=("X",),
                    warmup_bars=2)

    def __init__(self, **kw):
        super().__init__(**kw)
        self.seen = []

    def decide(self, view):
        self.seen.append((view.event, view.index,
                          len(view.bars("X")),
                          view.last_close("X"), view.price_now("X")))
        return Decision({})


class TestLookahead(unittest.TestCase):
    def setUp(self):
        self.closes = [10, 11, 12, 13, 14, 15]
        self.opens = [10, 10.5, 11.5, 12.5, 13.5, 14.5]
        self.series = {"X": mkbars(self.closes, self.opens)}

    def test_open_event_cannot_see_the_current_bar_close(self):
        v = View(self.series, 3, OPEN, self.series["X"][3].t)
        # Only bars 0..2 are complete at the open of bar 3.
        self.assertEqual(len(v.bars("X")), 3)
        self.assertEqual(v.last_close("X"), 12)          # bar 2's close
        self.assertEqual(v.price_now("X"), 12.5)         # bar 3's OPEN
        self.assertNotIn(13, v.closes("X"))              # bar 3's close is hidden

    def test_close_event_sees_the_current_bar(self):
        v = View(self.series, 3, CLOSE, self.series["X"][3].t)
        self.assertEqual(len(v.bars("X")), 4)
        self.assertEqual(v.last_close("X"), 13)
        self.assertEqual(v.price_now("X"), 13)

    def test_engine_never_shows_a_desk_the_future(self):
        spy = _Spy()
        Engine(spy, self.series, start_equity=1000.0).run()
        for event, idx, n_bars, last_close, price in spy.seen:
            if event == OPEN:
                self.assertEqual(n_bars, idx,
                                 "open event exposed the current bar")
                self.assertEqual(price, self.opens[idx])
            else:
                self.assertEqual(n_bars, idx + 1)
                self.assertEqual(last_close, self.closes[idx])


# ---------------------------------------------------------------- engine
class _AlwaysLong(Desk):
    meta = DeskMeta(name="_long", title="long", asset_class="equity",
                    venue="alpaca", events=(CLOSE,), universe=("X",),
                    warmup_bars=1, execution_style="auction")

    def decide(self, view):
        return Decision({"X": 1.0})


class TestEngine(unittest.TestCase):
    def test_buy_and_hold_tracks_the_asset_minus_costs(self):
        closes = [100] * 3 + [110] * 3        # +10% once, then flat
        series = {"X": mkbars(closes)}
        res = Engine(_AlwaysLong(), series, start_equity=1000.0).run()
        # Bought once near 100, held to 110: roughly +10% less costs.
        self.assertGreater(res.end_equity, 1050)
        self.assertLess(res.end_equity, 1100)
        # It should NOT keep trading once the target weight is unchanged.
        self.assertLessEqual(len(res.fills), 3)

    def test_targets_are_differenced_not_re_traded(self):
        series = {"X": mkbars([100] * 10)}
        res = Engine(_AlwaysLong(), series, start_equity=1000.0).run()
        # A flat price and a constant target should mean one entry, then
        # only small top-ups as equity drifts — never a fill every bar.
        self.assertLess(len(res.fills), 5)

    def test_daily_fee_floor_is_charged_once_per_active_day(self):
        series = {"X": mkbars([100] * 6)}
        res = Engine(_AlwaysLong(), series, start_equity=1000.0).run()
        self.assertGreater(res.fee_floor_paid, 0.0)
        # One active day (the entry) should cost about $0.03, not $0.18.
        self.assertLess(res.fee_floor_paid, 0.10)

    def test_cash_is_never_conjured(self):
        series = {"X": mkbars([100, 100, 100, 100])}
        eng = Engine(_AlwaysLong(), series, start_equity=100.0)
        eng.run()
        held = sum(p.shares * 100 for p in eng.positions.values())
        self.assertLessEqual(held, 105.0)      # cannot hold more than equity

    def test_daily_loss_halt_flattens_on_an_intraday_loss(self):
        # The loss must happen WITHIN a session for a daily halt to see it:
        # bar 2 opens at 100 and closes at 80. An overnight gap of the same
        # size is deliberately not caught here — that is what the drawdown
        # halt is for, and conflating the two would flatten the book every
        # time the market gapped against an overnight position.
        # The position has to exist before the drop, so the fall comes after
        # the warmup bars the engine skips.
        closes = [100, 100, 100, 80, 80, 80]
        opens = [100, 100, 100, 100, 80, 80]
        series = {"X": mkbars(closes, opens)}
        res = Engine(_AlwaysLong(), series, start_equity=1000.0,
                     daily_loss_halt=0.04).run()
        self.assertGreaterEqual(res.halted_days, 1)

    def test_overnight_gap_does_not_trip_the_intraday_halt(self):
        closes = [100, 100, 100, 80, 80, 80]   # gap between bars 2 and 3
        res = Engine(_AlwaysLong(), {"X": mkbars(closes)}, start_equity=1000.0,
                     daily_loss_halt=0.04).run()
        self.assertEqual(res.halted_days, 0)


# --------------------------------------------------------------- metrics
class TestMetrics(unittest.TestCase):
    def test_flat_series_is_not_significant(self):
        s = metrics.compute([0.0] * 100, periods_per_year=252)
        self.assertIn(s.verdict, ("unprofitable", "not-significant",
                                  "insufficient-data"))

    def test_a_strong_series_validates(self):
        rets = [0.004, -0.001] * 200          # steady positive drift
        s = metrics.compute(rets, periods_per_year=252)
        self.assertGreater(s.sharpe, 1.0)
        self.assertEqual(s.verdict, "validated")

    def test_deflated_sharpe_penalises_a_wide_search(self):
        rets = [0.002, -0.0005] * 150
        one = metrics.compute(rets, periods_per_year=252, n_trials=1)
        many = metrics.compute(rets, periods_per_year=252, n_trials=500)
        self.assertLessEqual(many.deflated_sharpe, one.deflated_sharpe)

    def test_small_samples_are_refused(self):
        s = metrics.compute([0.01] * 12, periods_per_year=252)
        self.assertEqual(s.verdict, "insufficient-data")

    def test_max_drawdown(self):
        self.assertAlmostEqual(metrics.max_drawdown([100, 120, 60, 90]), -0.5)


# ------------------------------------------------------------------ risk
class TestRisk(unittest.TestCase):
    def setUp(self):
        self.path = "/tmp/_risk_test_state.json"
        for p in (self.path, self.path + ".tmp"):
            if os.path.exists(p):
                os.remove(p)

    def tearDown(self):
        for p in (self.path, self.path + ".tmp"):
            if os.path.exists(p):
                os.remove(p)

    def test_turnover_budget_refuses_beyond_the_allowance(self):
        rm = risk.RiskManager(1000.0, risk.RiskLimits(max_annual_turnover=2.0),
                              state_path=self.path)
        rm.roll_session("2026-01-01", 1000.0)
        rm.mark(1000.0)
        ok, _ = rm.check_trade(300.0)
        self.assertTrue(ok)
        rm.record_trade(300.0)
        rm.record_trade(1500.0)
        ok, why = rm.check_trade(300.0)
        self.assertFalse(ok)
        self.assertIn("turnover budget", why)
        self.assertEqual(rm.budget.refused, 1)

    def test_daily_loss_halt_blocks_trading(self):
        rm = risk.RiskManager(1000.0, risk.RiskLimits(daily_loss_halt=0.04),
                              state_path=self.path)
        rm.roll_session("2026-01-01", 1000.0)
        self.assertEqual(rm.mark(990.0), "")
        self.assertTrue(rm.can_trade())
        why = rm.mark(950.0)
        self.assertIn("daily loss", why)
        self.assertFalse(rm.can_trade())

    def test_drawdown_halt_survives_a_new_session(self):
        rm = risk.RiskManager(1000.0, risk.RiskLimits(max_drawdown_halt=0.20),
                              state_path=self.path)
        rm.roll_session("2026-01-01", 1000.0)
        rm.mark(1000.0)
        rm.mark(700.0)
        self.assertIn("drawdown", rm.halt_reason)
        rm.roll_session("2026-01-02", 700.0)      # new day
        self.assertIn("drawdown", rm.mark(700.0))  # still halted

    def test_position_cap_is_enforced(self):
        rm = risk.RiskManager(1000.0, risk.RiskLimits(max_position_weight=0.25),
                              state_path=self.path)
        rm.roll_session("2026-01-01", 1000.0)
        rm.mark(1000.0)
        ok, why = rm.check_trade(400.0)
        self.assertFalse(ok)
        self.assertIn("cap", why)

    def test_allocation_refuses_desks_below_their_capital_floor(self):
        class D:
            def __init__(self, name, floor):
                self.meta = DeskMeta(name=name, title=name, asset_class="equity",
                                     venue="alpaca", capital_floor=floor)
        rm = risk.RiskManager(100.0, state_path=self.path)
        allocs = {a.name: a for a in rm.allocate([D("big", 250.0), D("small", 25.0)],
                                                 equity=100.0)}
        self.assertFalse(allocs["big"].enabled)
        self.assertIn("needs $250", allocs["big"].reason)
        self.assertTrue(allocs["small"].enabled)

    def test_state_round_trips(self):
        rm = risk.RiskManager(1000.0, state_path=self.path)
        rm.roll_session("2026-01-01", 1000.0)
        rm.mark(1000.0)
        rm.record_trade(250.0)
        rm.save()
        rm2 = risk.RiskManager(1000.0, state_path=self.path)
        self.assertAlmostEqual(rm2.budget.used(), 250.0)


# ---------------------------------------------------------------- config
class TestConfig(unittest.TestCase):
    def test_preset_tracks_account_size(self):
        self.assertEqual(config.preset_for_equity(40).name, "micro")
        self.assertEqual(config.preset_for_equity(500).name, "small")
        self.assertEqual(config.preset_for_equity(5000).name, "standard")
        self.assertEqual(config.preset_for_equity(100000).name, "scaled")

    def test_micro_preset_excludes_equity_desks(self):
        p = config.PRESETS["micro"]
        self.assertNotIn("overnight", p.desks)
        self.assertIn("kalshi-bias", p.desks)

    def test_turnover_allowance_widens_with_size(self):
        self.assertLess(config.PRESETS["micro"].limits.max_annual_turnover,
                        config.PRESETS["standard"].limits.max_annual_turnover)


# ------------------------------------------------------------------ data
class TestData(unittest.TestCase):
    def test_align_intersects_timestamps(self):
        a = mkbars([1, 2, 3])
        b = mkbars([4, 5, 6, 7])
        ts, out, dropped = align({"A": a, "B": b})
        self.assertEqual(len(ts), 3)
        self.assertEqual(len(out["A"]), len(out["B"]))
        self.assertEqual(dropped, [])

    def test_align_drops_short_series_instead_of_truncating_everyone(self):
        long = mkbars(list(range(1, 101)))
        short = mkbars(list(range(1, 11)))
        ts, out, dropped = align({"L": long, "S": short}, min_coverage=0.5)
        self.assertEqual(dropped, ["S"])
        self.assertEqual(len(ts), 100)

    def test_sma(self):
        self.assertEqual(sma([1, 2, 3, 4, 5], 3), [2.0, 3.0, 4.0])
        self.assertEqual(sma([1, 2], 5), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
