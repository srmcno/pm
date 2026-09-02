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

    def test_micro_preset_only_runs_desks_validated_at_small_size(self):
        p = config.PRESETS["micro"]
        self.assertNotIn("overnight", p.desks)      # needs whole-share auctions, $2,000
        self.assertNotIn("kalshi-bias", p.desks)    # tested and rejected
        self.assertNotIn("reversion", p.desks)      # marginal, opt-in only
        self.assertIn("xsect", p.desks)
        self.assertIn("trend", p.desks)

    def test_overnight_only_enters_at_two_thousand(self):
        for name in ("micro", "small"):
            self.assertNotIn("overnight", config.PRESETS[name].desks)
        self.assertIn("overnight", config.PRESETS["standard"].desks)

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



class TestDeclaredStatus(unittest.TestCase):
    def _desk(self, name, status, floor=10.0):
        class D:
            pass
        d = D()
        d.meta = DeskMeta(name=name, title=name, asset_class="equity", venue="alpaca",
                          capital_floor=floor, status=status, status_reason="why")
        return d

    def test_rejected_is_never_funded(self):
        rm = risk.RiskManager(1000.0, state_path="/tmp/_risk_status.json")
        a = {x.name: x for x in rm.allocate([self._desk("r", "rejected"),
                                             self._desk("v", "validated")], 1000.0)}
        self.assertFalse(a["r"].enabled)
        self.assertIn("rejected", a["r"].reason)
        self.assertTrue(a["v"].enabled)

    def test_marginal_needs_an_explicit_name(self):
        rm = risk.RiskManager(1000.0, state_path="/tmp/_risk_status.json")
        d = self._desk("m", "marginal")
        self.assertFalse(rm.allocate([d], 1000.0)[0].enabled)
        self.assertTrue(rm.allocate([d], 1000.0, explicit_desks=("m",))[0].enabled)

    def test_registered_desks_declare_consistently(self):
        import desk.desks.overnight, desk.desks.trend, desk.desks.xsect  # noqa: F401
        import desk.desks.reversion, desk.desks.kalshi_bias              # noqa: F401
        from desk.desks.base import all_desks
        st = {n: c.meta.status for n, c in all_desks().items()}
        self.assertEqual(st["kalshi-bias"], "rejected")
        self.assertEqual(st["reversion"], "marginal")
        self.assertEqual(st["overnight"], "validated")
        self.assertEqual(st["trend"], "marginal")
        for n, c in all_desks().items():
            if c.meta.status != "validated":
                self.assertTrue(c.meta.status_reason, f"{n} must say why")


class TestRiskGates(unittest.TestCase):
    def _rm(self, **lim):
        return risk.RiskManager(1000.0, risk.RiskLimits(**lim),
                                state_path="/tmp/_risk_gates.json")

    def test_weekly_baseline_rolls_at_the_iso_week_boundary(self):
        rm = self._rm()
        rm.roll_session("2026-08-31", 1000.0)           # Monday
        rm.roll_session("2026-09-03", 1200.0)           # same ISO week
        self.assertEqual(rm.week["start"], "2026-08-31")
        self.assertEqual(rm.week["start_equity"], 1000.0)
        rm.roll_session("2026-09-07", 1200.0)           # next Monday
        self.assertEqual(rm.week["start"], "2026-09-07")
        self.assertEqual(rm.week["start_equity"], 1200.0)

    def test_reducing_orders_pass_the_exposure_caps(self):
        rm = self._rm(max_position_weight=0.1, max_open_positions=1,
                      max_annual_turnover=0.01)
        ok, why = rm.check_trade(500.0, "X", open_positions=1)
        self.assertFalse(ok)
        ok, why = rm.check_trade(500.0, "X", open_positions=1, reducing=True)
        self.assertTrue(ok, why)
        rm.halt_reason = "daily loss -5.0% hit the 4% halt"
        self.assertFalse(rm.check_trade(500.0, "X")[0])
        self.assertTrue(rm.check_trade(500.0, "X", reducing=True)[0])
        self.assertTrue(rm.loss_halted())

    def test_verdict_gate(self):
        class D:
            pass
        d = D()
        d.meta = DeskMeta(name="v", title="v", asset_class="equity", venue="alpaca",
                          capital_floor=10.0)
        rm = self._rm()
        ok = {"verdict": "validated", "stale": False, "date": "2026-09-01"}
        self.assertTrue(rm.allocate([d], 1000.0, verdicts={"v": ok})[0].enabled)
        self.assertTrue(rm.allocate([d], 1000.0)[0].enabled)       # no record given
        a = rm.allocate([d], 1000.0, verdicts={})[0]
        self.assertFalse(a.enabled)
        self.assertIn("no validation record", a.reason)
        a = rm.allocate([d], 1000.0, verdicts={"v": {**ok, "verdict": "unprofitable"}})[0]
        self.assertFalse(a.enabled)
        self.assertIn("unprofitable", a.reason)
        a = rm.allocate([d], 1000.0, verdicts={"v": {**ok, "stale": True, "ageDays": 40,
                                                      "maxAgeDays": 30}})[0]
        self.assertFalse(a.enabled)
        self.assertIn("days old", a.reason)

    def test_evidence_verdicts_reads_the_record(self):
        import json, tempfile, time
        from desk.core import evidence
        fd, path = tempfile.mkstemp(suffix=".json")
        with open(path, "w") as f:
            json.dump({"generatedAt": int(time.time()) - 5 * 86400,
                       "desks": {"a": {"verdict": "validated"}, "b": {"verdict": "weak"}}}, f)
        v = evidence.verdicts(path)
        self.assertEqual(v["a"]["verdict"], "validated")
        self.assertFalse(v["a"]["stale"])
        self.assertEqual(v["b"]["verdict"], "weak")
        v = evidence.verdicts(path, max_age_days=3)
        self.assertTrue(v["a"]["stale"])
        self.assertEqual(evidence.verdicts("/nonexistent/evidence.json"), {})


class TestReviewRoundThree(unittest.TestCase):
    def test_eastern_fallback_applies_the_dst_rule(self):
        import datetime as dt
        from desk.core.clock import USEastern
        tz = USEastern()
        jan = dt.datetime(2026, 1, 15, 17, 0, tzinfo=dt.timezone.utc).astimezone(tz)
        jul = dt.datetime(2026, 7, 15, 17, 0, tzinfo=dt.timezone.utc).astimezone(tz)
        self.assertEqual((jan.hour, jan.tzname()), (12, "EST"))
        self.assertEqual((jul.hour, jul.tzname()), (13, "EDT"))
        before = dt.datetime(2026, 3, 8, 6, 59, tzinfo=dt.timezone.utc).astimezone(tz)
        after = dt.datetime(2026, 3, 8, 7, 0, tzinfo=dt.timezone.utc).astimezone(tz)
        self.assertEqual((before.hour, before.minute), (1, 59))
        self.assertEqual(after.hour, 3)
        nov = dt.datetime(2026, 11, 1, 6, 30, tzinfo=dt.timezone.utc).astimezone(tz)
        self.assertEqual((nov.hour, nov.tzname()), (1, "EST"))

    def test_limits_overrides_are_filtered_and_coerced(self):
        import json, tempfile
        fd, path = tempfile.mkstemp(suffix=".json")
        with open(path, "w") as f:
            json.dump({"preset": "small", "limits": {"daily_loss_halt": "0.05",
                                                     "max_open_positions": "3",
                                                     "bogus": 1, "weekly_loss_halt": "x"}}, f)
        cfg = config.load(path)
        self.assertEqual(cfg.limits.daily_loss_halt, 0.05)
        self.assertEqual(cfg.limits.max_open_positions, 3)
        self.assertEqual(cfg.limits.weekly_loss_halt,
                         config.PRESETS["small"].limits.weekly_loss_halt)

    def test_save_load_does_not_promote_preset_desks_to_explicit(self):
        import json, tempfile
        fd, path = tempfile.mkstemp(suffix=".json")
        with open(path, "w") as f:
            json.dump({"preset": "small", "equity": 500}, f)
        cfg = config.load(path)
        self.assertEqual(cfg.explicit_desks, ())
        config.save(cfg, path)
        again = config.load(path)
        self.assertEqual(again.explicit_desks, ())
        self.assertEqual(again.desks, config.PRESETS["small"].desks)
        self.assertNotIn("desks", json.load(open(path)))
        again.desks = again.explicit_desks = ("xsect",)
        config.save(again, path)
        self.assertEqual(config.load(path).explicit_desks, ("xsect",))

    def test_allocation_respects_the_gross_cap(self):
        class D:
            pass
        ds = []
        for n in ("a", "b"):
            d = D()
            d.meta = DeskMeta(name=n, title=n, asset_class="equity", venue="alpaca",
                              capital_floor=10.0)
            ds.append(d)
        rm = risk.RiskManager(1000.0, risk.RiskLimits(max_gross_exposure=0.9,
                                                      max_desk_weight=0.6),
                              state_path="/tmp/_risk_gross.json")
        a = rm.allocate(ds, 1000.0)
        self.assertEqual([x.weight for x in a], [0.45, 0.45])

    def test_position_cap_judges_the_resulting_position(self):
        rm = risk.RiskManager(1000.0, risk.RiskLimits(max_position_weight=0.30,
                                                      max_open_positions=2),
                              state_path="/tmp/_risk_post.json")
        self.assertTrue(rm.check_trade(150.0, "X", current_notional=100.0)[0])
        ok, why = rm.check_trade(150.0, "X", current_notional=250.0)
        self.assertFalse(ok)
        self.assertIn("40%", why)
        # the open-positions cap binds only when a NEW symbol would be added
        self.assertTrue(rm.check_trade(50.0, "X", open_positions=2, new_symbol=False)[0])
        self.assertFalse(rm.check_trade(50.0, "Z", open_positions=2, new_symbol=True)[0])

    def test_non_finite_track_record_serializes_as_null(self):
        import json
        st = metrics.compute([-0.01, -0.02, 0.005, -0.01] * 20, periods_per_year=252)
        self.assertIsNone(st.min_track_record_periods)
        self.assertNotIn("Infinity", json.dumps(st.to_dict()))
        self.assertEqual(st.verdict, "unprofitable")

    def test_engine_guard_paths_keep_start_equity(self):
        from desk.desks.base import Desk, DeskMeta as DM, Decision as Dc
        class D(Desk):
            meta = DM(name="_g", title="g", asset_class="equity", venue="alpaca",
                      universe=("A",), warmup_bars=5)
            def decide(self, view):
                return Dc({})
        r = Engine(D(), {}, start_equity=500.0).run()
        self.assertEqual(r.end_equity, 500.0)

    def test_walk_forward_reports_windows_scored(self):
        from desk.backtest.walkforward import walk_forward
        from desk.desks.base import Desk, DeskMeta as DM, Decision as Dc
        class D(Desk):
            meta = DM(name="_w", title="w", asset_class="equity", venue="alpaca",
                      universe=("A",), warmup_bars=5)
            def decide(self, view):
                return Dc({"A": 0.5})
        px, bars_ = 100.0, []
        for i in range(600):
            px *= 1 + (0.002 if i % 3 else -0.001)
            bars_.append(Bar(1_600_000_000 + i * 86400, px, px, px, px, 1.0))
        res = walk_forward(D, {"A": bars_}, n_folds=5, grid={})
        self.assertEqual(res.param_stability["foldsRequested"], 5)
        self.assertEqual(res.param_stability["foldsScored"], 4)
        self.assertTrue(any("training prefix" in n for n in res.notes))
        with self.assertRaises(ValueError):
            walk_forward(D, {"A": bars_}, n_folds=5, grid={}, select_on="verdict")


class TestFirstPeriodCounts(unittest.TestCase):
    def test_total_return_and_drawdown_include_the_first_period(self):
        rets = [-0.5] + [0.0] * 40
        st = metrics.compute(rets, periods_per_year=252)
        self.assertAlmostEqual(st.total_return_pct, -50.0, places=3)
        self.assertAlmostEqual(st.max_drawdown_pct, -50.0, places=3)
        # a replay-style curve (one point per bar, after the bar's return)
        curve = [50.0] + [50.0] * 40
        st2 = metrics.compute(rets, equity_curve=curve, periods_per_year=252)
        self.assertAlmostEqual(st2.total_return_pct, -50.0, places=3)
        self.assertAlmostEqual(st2.max_drawdown_pct, -50.0, places=3)


class TestFinalFeeFloor(unittest.TestCase):
    def test_last_sessions_fee_floor_is_in_the_record(self):
        from desk.desks.base import Desk, DeskMeta as DM, Decision as Dc, CLOSE as C
        class D(Desk):
            meta = DM(name="_ff", title="ff", asset_class="equity", venue="alpaca",
                      universe=("A",), warmup_bars=3, events=(C,), fractional=True)
            def decide(self, view):
                # buy on the very last bar only
                return Dc({"A": 0.5} if view.index == 9 else {})
        bars_ = [Bar(1_600_000_000 + i * 86400, 100.0, 100.0, 100.0, 100.0, 1.0)
                 for i in range(10)]
        eng = Engine(D(), {"A": bars_}, start_equity=1000.0)
        r = eng.run()
        self.assertGreater(r.fee_floor_paid, 0.0)
        self.assertEqual(r.end_equity, r.equity_curve[-1][1])
        self.assertAlmostEqual(r.end_equity, eng.cash + 500.0, places=4)
        self.assertLess(r.end_equity, 1000.0 - r.fee_floor_paid + 1e-9)
        prod = 1.0
        for x in r.returns:
            prod *= 1 + x
        self.assertAlmostEqual(prod, r.end_equity / r.equity_curve[0][1], places=9)


class TestWatchExitCode(unittest.TestCase):
    def test_a_shift_that_cannot_run_fails(self):
        import argparse
        from desk import cli
        saved_runner, saved_sleep = cli.runnermod.Runner, cli.time.sleep
        class Broken:
            def __init__(self, **kw):
                pass
            def run_cycle(self):
                raise RuntimeError("venue down")
        cli.runnermod.Runner = Broken
        cli.time.sleep = lambda *_: None
        try:
            args = argparse.Namespace(equity=1000.0, preset="observe", live=False,
                                      i_accept_total_loss=False, venue_paper=True,
                                      reset_book=False, minutes=1.0, seconds=0.0)
            self.assertEqual(cli.cmd_watch(args), 1)
        finally:
            cli.runnermod.Runner, cli.time.sleep = saved_runner, saved_sleep


class TestFirstBarCost(unittest.TestCase):
    def test_entering_on_the_first_bar_costs_something_in_the_returns(self):
        from desk.desks.base import Desk, DeskMeta as DM, Decision as Dc, CLOSE as C
        class D(Desk):
            meta = DM(name="_fb", title="fb", asset_class="crypto", venue="alpaca",
                      periods_per_year=365, universe=("B/USD",), warmup_bars=2,
                      events=(C,), fractional=True)
            def decide(self, view):
                return Dc({"B/USD": 0.5})
        bars_ = [Bar(1_600_000_000 + i * 86400, 100.0, 100.0, 100.0, 100.0, 1.0)
                 for i in range(12)]
        r = Engine(D(), {"B/USD": bars_}, start_equity=1000.0).run()
        self.assertLess(r.end_equity, 1000.0)
        self.assertEqual(len(r.returns), len(r.equity_curve))
        st = metrics.compute(r.returns, equity_curve=[e for _, e in r.equity_curve],
                             periods_per_year=365)
        self.assertLess(st.total_return_pct, 0.0)
        self.assertLess(st.max_drawdown_pct, 0.0)
        prod = 1.0
        for x in r.returns:
            prod *= 1 + x
        self.assertAlmostEqual(prod, r.end_equity / 1000.0, places=9)


class TestFloorOnDeskShare(unittest.TestCase):
    def _desks(self):
        class D:
            pass
        out = []
        for name, floor in (("over", 2000.0), ("trend", 100.0)):
            d = D()
            d.meta = DeskMeta(name=name, title=name, asset_class="equity", venue="alpaca",
                              capital_floor=floor)
            out.append(d)
        return out

    def test_floor_is_judged_on_the_desks_share_not_the_account(self):
        rm = risk.RiskManager(2000.0, risk.RiskLimits(max_desk_weight=0.4),
                              state_path="/tmp/_risk_share.json")
        a = {x.name: x for x in rm.allocate(self._desks(), 2000.0)}
        self.assertFalse(a["over"].enabled)
        self.assertIn("share", a["over"].reason)
        self.assertIn("$5,000", a["over"].reason)
        self.assertTrue(a["trend"].enabled)
        a = {x.name: x for x in rm.allocate(self._desks(), 5000.0)}
        self.assertEqual((a["over"].weight, a["trend"].weight), (0.4, 0.4))

    def test_floor_is_taken_first_when_the_cap_allows_it(self):
        rm = risk.RiskManager(2500.0, risk.RiskLimits(max_desk_weight=1.0),
                              state_path="/tmp/_risk_share2.json")
        a = {x.name: x for x in rm.allocate(self._desks(), 2500.0)}
        self.assertEqual(a["over"].weight, 0.8)          # exactly its $2,000 floor
        self.assertEqual(a["trend"].weight, 0.2)         # what is left
        a = {x.name: x for x in rm.allocate(self._desks(), 2000.0)}
        self.assertEqual(a["over"].weight, 1.0)
        self.assertFalse(a["trend"].enabled)
        self.assertIn("no capital left", a["trend"].reason)

    def test_standard_preset_starts_where_the_overnight_desk_can_be_funded(self):
        self.assertEqual(config.preset_for_equity(3000.0).name, "small")
        self.assertEqual(config.preset_for_equity(4000.0).name, "standard")
        lim = config.PRESETS["standard"].limits
        self.assertGreaterEqual(lim.max_desk_weight * 4000.0, 2000.0)


class TestFoldsScoreOnlyUntouchedBars(unittest.TestCase):
    def test_each_fold_scores_exactly_its_window(self):
        from desk.backtest.walkforward import walk_forward
        from desk.desks.base import Desk, DeskMeta as DM, Decision as Dc
        class D(Desk):
            meta = DM(name="_wf2", title="w", asset_class="equity", venue="alpaca",
                      universe=("A",), warmup_bars=5)
            def decide(self, view):
                return Dc({"A": 0.5})
        px, bars_ = 100.0, []
        for i in range(600):
            px *= 1 + (0.002 if i % 3 else -0.001)
            bars_.append(Bar(1_600_000_000 + i * 86400, px, px, px, px, 1.0))
        res = walk_forward(D, {"A": bars_}, n_folds=5, grid={})
        for f in res.folds:
            self.assertEqual(f.test_bars, f.test_end - f.test_start)


if __name__ == "__main__":
    unittest.main(verbosity=1)
