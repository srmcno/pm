#!/usr/bin/env python3
"""Offline tests for the live loop: reconciliation, windows, order types.

These are the tests that stand between a crashed process and a doubled
position. Every scenario uses a fake venue whose order states are scripted,
so the runner's behaviour under partial fills, lost submissions and killed
processes is pinned without a network.
"""
import datetime as dt
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from desk import runner as R                                     # noqa: E402
from desk.core import config as cfgmod, risk, state as statemod  # noqa: E402
from desk.data.bars import Bar                                   # noqa: E402
from desk.desks.base import (CLOSE, OPEN, Decision, Desk,        # noqa: E402
                             DeskMeta, register, _REGISTRY)

ET = R._et_tz()


def mkbars(closes, t0=1_700_000_000, step=86400):
    return [Bar(t0 + i * step, c, c, c, c, 1000.0) for i, c in enumerate(closes)]


class _EqDesk(Desk):
    """Always wants 50% of equity in X, executed in the auction."""
    meta = DeskMeta(name="_eq", title="eq", asset_class="equity", venue="alpaca",
                    events=(OPEN, CLOSE), universe=("X",), warmup_bars=2,
                    capital_floor=10.0, fractional=False, execution_style="auction")

    def decide(self, view):
        return Decision({} if view.event == OPEN else {"X": 0.5})


class _CryptoDesk(Desk):
    meta = DeskMeta(name="_cr", title="cr", asset_class="crypto", venue="alpaca",
                    periods_per_year=365, events=(CLOSE,), universe=("B/USD",),
                    warmup_bars=2, capital_floor=10.0, fractional=True)

    def decide(self, view):
        return Decision({"B/USD": 0.3})


class FakeVenue:
    """Scripted order states. `script[cid]` is a list consumed one per query."""
    def __init__(self):
        self.script = {}
        self.submitted = []
        self.equity = 1000.0
        self.now = dt.datetime(2026, 9, 1, 15, 40, tzinfo=ET)

    def submit(self, symbol, qty, side, order_type="market", time_in_force="day",
               client_order_id=None, **kw):
        self.submitted.append((symbol, qty, side, order_type, time_in_force, client_order_id))
        return {"id": "o", "status": "accepted"}

    def order_state(self, cid):
        seq = self.script.get(cid)
        if not seq:
            return ("not_found", 0.0, None) if cid not in self.script else ("accepted", 0.0, None)
        return seq.pop(0) if len(seq) > 1 else seq[0]

    def account(self):
        return {"equity": str(self.equity)}

    def now_et(self):
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        statemod.STATE_DIR = self.tmp
        risk.STOP_FILE = os.path.join(self.tmp, "STOP")
        self.saved_registry = dict(_REGISTRY)
        _REGISTRY.clear()
        register(_EqDesk)
        register(_CryptoDesk)
        self.data = {"X": mkbars([100] * 10), "B/USD": mkbars([50] * 10)}

    def tearDown(self):
        _REGISTRY.clear()
        _REGISTRY.update(self.saved_registry)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def runner(self, desks, venue=None, equity=1000.0, clock=None):
        cfg = cfgmod.Config(preset="observe", equity=equity, desks=tuple(desks),
                            limits=risk.RiskLimits(max_annual_turnover=1000, min_trade_notional=1.0,
                                                   max_desk_weight=1.0, max_position_weight=1.0))
        st = statemod.load(bankroll=equity)
        rm = risk.RiskManager(equity, cfg.limits, state_path=os.path.join(self.tmp, "risk.json"))
        broker = R.LiveBroker(venue, settle_seconds=0.0, poll=0.0) if venue else None
        return R.Runner(cfg=cfg, st=st, broker=broker, rm=rm,
                        series_loader=lambda s, i, src: self.data.get(s, []),
                        clock=clock or (lambda: dt.datetime(2026, 9, 1, 15, 40, tzinfo=ET)))


class TestWindows(Base):
    def test_equity_desk_holds_outside_its_window(self):
        r = self.runner(["_eq"], clock=lambda: dt.datetime(2026, 9, 1, 12, 0, tzinfo=ET))
        tel = r.run_cycle()
        self.assertEqual(tel["phase"], "open")
        self.assertEqual(tel["executed"], [])
        self.assertTrue(any("holding" in n for n in tel["deskNotes"]))

    def test_pre_close_sends_whole_share_moc(self):
        r = self.runner(["_eq"])
        tel = r.run_cycle()
        self.assertEqual(tel["phase"], "pre_close")
        self.assertEqual(len(tel["executed"]), 1)
        e = tel["executed"][0]
        self.assertEqual(e["type"], "cls")
        self.assertEqual(e["shares"], 5.0)            # $500 / $100, whole
        self.assertEqual(r.st.positions[0]["shares"], 5.0)

    def test_pre_open_flattens_with_moo_and_does_not_flatten_others(self):
        r = self.runner(["_eq", "_cr"])
        r.run_cycle()                                  # buy X (cls) and B/USD
        self.assertEqual(len(r.st.positions), 2)
        r._clock = lambda: dt.datetime(2026, 9, 2, 9, 10, tzinfo=ET)
        tel = r.run_cycle()
        self.assertEqual(tel["phase"], "pre_open")
        sells = [e for e in tel["executed"] if e["side"] == "sell"]
        self.assertEqual(len(sells), 1)
        self.assertEqual(sells[0]["type"], "opg")
        self.assertEqual([p["symbol"] for p in r.st.positions], ["B/USD"])

    def test_crypto_trades_any_time_with_gtc_market(self):
        r = self.runner(["_cr"], clock=lambda: dt.datetime(2026, 9, 6, 3, 0, tzinfo=ET))
        tel = r.run_cycle()
        self.assertEqual(tel["phase"], "closed")
        self.assertEqual(tel["executed"][0]["type"], "market")
        self.assertAlmostEqual(r.st.positions[0]["shares"], 6.0, places=6)


class TestReconcile(Base):
    def test_submission_is_not_completion(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        v.script = {}                                  # every order stays 'accepted'
        r.run_cycle()
        self.assertEqual(len(v.submitted), 1)
        p = r.st.positions[0]
        self.assertFalse(p["liveOpen"])
        self.assertEqual(p["shares"], 0.0)              # nothing booked
        self.assertTrue(p["liveCid"])

    def test_pending_blocks_trading_until_confirmed_then_books_at_fill_price(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("accepted", 0.0, None)]
        tel = r.run_cycle()
        self.assertTrue(tel["pending"])
        self.assertTrue(any("pending" in x["reason"] for x in tel["refused"]))
        self.assertEqual(len(v.submitted), 1)           # no second order
        v.script[cid] = [("filled", v.submitted[-1][1], 100.4)]
        r.run_cycle()
        p = r.st.positions[0]
        self.assertTrue(p["liveOpen"])
        self.assertEqual(p["shares"], v.submitted[0][1])
        self.assertAlmostEqual(p["entry"], 100.4)       # the VENUE's price

    def test_rejected_open_drops_the_position(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("rejected", 0.0, None)]
        r.run_cycle()
        self.assertEqual(r.st.positions, [])

    def test_lost_submission_retries_under_a_new_attempt_id(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        first = r.st.positions[0]["liveCid"]
        # venue has never heard of it -> not_found -> resubmit as attempt 1
        r.run_cycle()
        self.assertEqual(len(v.submitted), 2)
        second = r.st.positions[0]["liveCid"]
        self.assertNotEqual(first, second)
        self.assertTrue(second.endswith("-a1"))

    def test_partial_fill_is_tracked_as_exposure_but_stays_pending(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("partially_filled", 2.0, 100.1)]
        tel = r.run_cycle()
        self.assertTrue(tel["pending"])
        self.assertEqual(r.st.positions[0]["liveQty"], 2.0)
        self.assertFalse(r.st.positions[0]["liveOpen"])

    def test_close_is_booked_only_when_confirmed(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("filled", v.submitted[-1][1], 100.0)]
        r.run_cycle()                                  # confirmed open
        r._clock = lambda: dt.datetime(2026, 9, 2, 9, 10, tzinfo=ET)
        r.run_cycle()                                  # MOO sell submitted
        p = r.st.positions[0]
        self.assertTrue(p.get("closeCid"))
        self.assertEqual(p["shares"], 5.0)              # still held
        v.script[p["closeCid"]] = [("filled", p["shares"], 101.0)]
        r.run_cycle()
        self.assertEqual(r.st.positions, [])
        self.assertEqual(len(r.st.closed), 1)
        self.assertAlmostEqual(r.st.closed[0]["exit"], 101.0)

    def test_venue_equity_is_the_truth_when_live(self):
        v = FakeVenue()
        v.equity = 777.0
        r = self.runner(["_eq"], venue=v)
        tel = r.run_cycle()
        self.assertEqual(tel["equity"], 777.0)


class TestRisk(Base):
    def test_stop_file_halts_everything(self):
        open(risk.STOP_FILE, "w").write("x")
        r = self.runner(["_eq"])
        tel = r.run_cycle()
        self.assertEqual(tel["executed"], [])
        self.assertIn("STOP", tel["refused"][0]["reason"])

    def test_capital_floor_refuses_a_desk(self):
        _EqDesk.meta.capital_floor = 5000.0
        try:
            r = self.runner(["_eq"], equity=1000.0)
            tel = r.run_cycle()
            self.assertFalse(tel["allocations"]["_eq"]["enabled"])
            self.assertEqual(tel["executed"], [])
        finally:
            _EqDesk.meta.capital_floor = 10.0


class TestArming(unittest.TestCase):
    """The real-money endpoint needs every switch, including the committed
    config flag; the paper endpoint needs only the flags."""

    def _args(self, **kw):
        import argparse
        d = dict(live=True, i_accept_total_loss=True, venue_paper=True)
        d.update(kw)
        return argparse.Namespace(**d)

    def _cfg(self, live):
        from desk.core import config as cfgmod
        return cfgmod.Config(live=live)

    def test_flags_are_required(self):
        from desk import cli
        for bad in (dict(live=False), dict(i_accept_total_loss=False)):
            with self.assertRaises(SystemExit):
                cli._arm_or_die(self._args(**bad), self._cfg(True))

    def test_paper_endpoint_does_not_need_config_flag(self):
        from desk import cli
        cli._arm_or_die(self._args(venue_paper=True), self._cfg(False))

    def test_real_money_needs_config_flag(self):
        from desk import cli
        with self.assertRaises(SystemExit) as cm:
            cli._arm_or_die(self._args(venue_paper=False), self._cfg(False))
        self.assertIn("config.json", str(cm.exception))
        cli._arm_or_die(self._args(venue_paper=False), self._cfg(True))


if __name__ == "__main__":
    unittest.main(verbosity=1)
