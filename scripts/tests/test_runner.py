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
# Ten daily bars whose LAST one is the session the default clock sits in
# (2026-09-01, a Tuesday), stamped at the 09:30 ET open like Yahoo's.
SESSION = dt.datetime(2026, 9, 1, 9, 30, tzinfo=ET)
T0 = int(SESSION.timestamp()) - 9 * 86400
NEXT = int((SESSION + dt.timedelta(days=1)).timestamp())      # Wednesday's bar


def mkbars(closes, t0=T0, step=86400, opens=None):
    out = []
    for i, c in enumerate(closes):
        o = opens[i] if opens else c
        out.append(Bar(t0 + i * step, o, max(o, c), min(o, c), c, 1000.0))
    return out


def at(day, hour, minute):
    return dt.datetime(2026, 9, day, hour, minute, tzinfo=ET)


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

    @classmethod
    def defaults(cls):
        return {"w": 0.3}

    def decide(self, view):
        return Decision({"B/USD": float(self.params["w"])})


class VenueSaidNo(Exception):
    """Stands in for the adapter's VenueError: carries the HTTP status."""
    def __init__(self, status, msg="no"):
        super().__init__(msg)
        self.status = status


class _HoldDesk(Desk):
    """Crossing desk that always wants `w` of equity in X — shares the
    symbol with _EqDesk but keeps its own lots."""
    meta = DeskMeta(name="_hold", title="hold", asset_class="equity", venue="alpaca",
                    events=(CLOSE,), universe=("X",), warmup_bars=2,
                    capital_floor=10.0, fractional=True, execution_style="crossing")

    @classmethod
    def defaults(cls):
        return {"w": 0.2}

    def decide(self, view):
        w = float(self.params["w"])
        return Decision({"X": w} if w > 0 else {})


class FakeVenue:
    """Scripted order states. `script[cid]` is a list consumed one per query;
    `default` answers any unscripted id; `reject` makes submit raise."""
    def __init__(self):
        self.script = {}
        self.submitted = []
        self.equity = 1000.0
        self.now = dt.datetime(2026, 9, 1, 15, 40, tzinfo=ET)
        self.held = None                # what /v2/positions returns; None = unsupported
        self.default = None
        self.reject = None              # an exception to raise on submit

    def submit(self, symbol, qty, side, order_type="market", time_in_force="day",
               client_order_id=None, **kw):
        if self.reject is not None:
            raise self.reject
        self.submitted.append((symbol, qty, side, order_type, time_in_force, client_order_id))
        return {"id": "o", "status": "accepted"}

    def order_state(self, cid):
        seq = self.script.get(cid)
        if not seq:
            if cid not in self.script and self.default is not None:
                return self.default
            return ("not_found", 0.0, None) if cid not in self.script else ("accepted", 0.0, None)
        return seq.pop(0) if len(seq) > 1 else seq[0]

    def account(self):
        return {"equity": str(self.equity)}

    def positions(self):
        return None if self.held is None else list(self.held)

    def cancel_by_client_id(self, cid):
        self.canceled = getattr(self, "canceled", []) + [cid]
        return True

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
        register(_HoldDesk)
        self.data = {"X": mkbars([100] * 10), "B/USD": mkbars([50] * 10)}

    def tearDown(self):
        _REGISTRY.clear()
        _REGISTRY.update(self.saved_registry)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def settle(self, r, when):
        """Advance the clock and run a cycle so pending paper auction orders
        fill at the session's print."""
        r._clock = lambda: when
        return r.run_cycle()

    def runner(self, desks, venue=None, equity=1000.0, clock=None):
        cfg = cfgmod.Config(preset="observe", equity=equity, desks=tuple(desks),
                            limits=risk.RiskLimits(max_annual_turnover=1000, min_trade_notional=1.0,
                                                   max_desk_weight=1.0, max_position_weight=1.0))
        st = statemod.load(bankroll=equity)
        rm = risk.RiskManager(equity, cfg.limits, state_path=os.path.join(self.tmp, "risk.json"))
        broker = R.LiveBroker(venue, settle_seconds=0.0, poll=0.0) if venue else None
        return R.Runner(cfg=cfg, st=st, broker=broker, rm=rm,
                        series_loader=lambda s, i, src: self.data.get(s, []),
                        clock=clock or (lambda: dt.datetime(2026, 9, 1, 15, 40, tzinfo=ET)),
                        verdicts={d: {"verdict": "validated", "stale": False,
                                      "date": "test"} for d in desks})


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
        self.assertEqual(e["status"], "accepted")     # no print yet
        self.assertFalse(r.st.positions[0]["liveOpen"])
        self.settle(r, at(1, 16, 5))                  # the close prints
        self.assertEqual(r.st.positions[0]["shares"], 5.0)
        self.assertTrue(r.st.positions[0]["liveOpen"])
        self.assertAlmostEqual(r.st.positions[0]["entry"], 100.0, delta=0.1)

    def test_pre_open_flattens_with_moo_and_does_not_flatten_others(self):
        r = self.runner(["_eq", "_cr"])
        r.run_cycle()                                  # buy X (cls) and B/USD
        self.settle(r, at(1, 16, 5))
        self.assertEqual(len(r.st.positions), 2)
        tel = self.settle(r, at(2, 9, 10))
        self.assertEqual(tel["phase"], "pre_open")
        sells = [e for e in tel["executed"] if e["side"] == "sell"]
        self.assertEqual(len(sells), 1)
        self.assertEqual(sells[0]["type"], "opg")
        self.assertEqual(sells[0]["status"], "accepted")
        self.data["X"].append(Bar(NEXT, 103.0, 104.0, 101.0, 101.0, 1000.0))
        self.settle(r, at(2, 9, 35))                   # the open prints
        self.assertEqual([p["symbol"] for p in r.st.positions], ["B/USD"])
        self.assertAlmostEqual(r.st.closed[0]["exit"], 103.0, delta=0.1)   # the OPEN, not last close

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
        # The rejected intent is gone. The desk still wants the position, so
        # a fresh intent (new id, unconfirmed) may follow through the normal
        # path — but nothing is booked and the dead id is not reused.
        self.assertEqual([p for p in r.st.positions if p["liveOpen"]], [])
        self.assertNotIn(cid, [p["liveCid"] for p in r.st.positions])

    def test_lost_submission_is_dropped_never_resubmitted_from_reconcile(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        first = r.st.positions[0]["liveCid"]
        # venue has never heard of it -> one more look, still pending, no order
        tel = r.run_cycle()
        self.assertTrue(tel["pending"])
        self.assertEqual(len(v.submitted), 1)
        # second not_found -> the intent is dead; the desk restates its target
        # through the normal path (risk check, halts, window) with a new id
        r.run_cycle()
        self.assertEqual(len(v.submitted), 2)
        second = v.submitted[-1][5]
        self.assertFalse(second.endswith("-a1"))       # a fresh intent, not a retry
        self.assertEqual([p["liveCid"] for p in r.st.positions], [second])
        self.assertEqual(r.st.positions[0].get("notFound", 0), 0)
        self.assertTrue(first)

    def test_venue_4xx_is_a_refusal_not_a_pending_order(self):
        v = FakeVenue()
        v.reject = VenueSaidNo(403, "insufficient buying power")
        r = self.runner(["_eq"], venue=v)
        tel = r.run_cycle()
        self.assertFalse(tel["pending"])
        self.assertEqual(r.st.positions, [])
        self.assertTrue(any("venue 403" in (x.get("reason") or "") for x in tel["refused"]))
        v.reject = VenueSaidNo(503, "gateway")        # ambiguous: stays pending
        r = self.runner(["_eq"], venue=v)
        tel = r.run_cycle()
        self.assertEqual(len(r.st.positions), 1)
        self.assertFalse(r.st.positions[0]["liveOpen"])

    def test_terminal_status_with_a_partial_fill_is_booked(self):
        v = FakeVenue()
        v.default = ("canceled", 2.0, 100.0)            # 2 of 5 filled, then canceled
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        self.assertEqual(len(r.st.positions), 1)
        self.assertTrue(r.st.positions[0]["liveOpen"])
        self.assertEqual(r.st.positions[0]["shares"], 2.0)
        self.assertAlmostEqual(r.rm.telemetry()["turnover"]["usedUsd"], 200.0, delta=0.01)

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


class TestVerdictGate(Base):
    """The latest walk-forward statistic decides funding; a failed or stale
    record switches a desk off at the next cycle."""

    def test_desk_whose_statistic_failed_is_not_funded(self):
        r = self.runner(["_eq"])
        r._verdicts = {"_eq": {"verdict": "not-significant", "stale": False,
                               "date": "2026-09-01"}}
        tel = r.run_cycle()
        self.assertEqual(tel["executed"], [])
        self.assertFalse(tel["allocations"]["_eq"]["enabled"])
        self.assertIn("statistic", tel["allocations"]["_eq"]["reason"])

    def test_missing_or_stale_record_is_not_funded(self):
        r = self.runner(["_eq"])
        r._verdicts = {}
        tel = r.run_cycle()
        self.assertFalse(tel["allocations"]["_eq"]["enabled"])
        self.assertIn("no validation record", tel["allocations"]["_eq"]["reason"])
        r = self.runner(["_eq"])
        r._verdicts = {"_eq": {"verdict": "validated", "stale": True,
                               "ageDays": 45, "maxAgeDays": 30}}
        tel = r.run_cycle()
        self.assertFalse(tel["allocations"]["_eq"]["enabled"])
        self.assertIn("days old", tel["allocations"]["_eq"]["reason"])


class TestLossHalt(Base):
    """A loss halt gets flat; the STOP file freezes; neither re-enters."""

    def _open_then_drop(self, venue=None):
        r = self.runner(["_eq"], venue=venue)
        r.run_cycle()
        self.settle(r, at(1, 16, 5))
        self.assertEqual(r.st.positions[0]["shares"], 5.0)
        self.data["X"] = mkbars([100] * 9 + [80])       # -20% on a 50% position
        return r

    def test_daily_loss_halt_flattens_instead_of_freezing(self):
        r = self._open_then_drop()
        tel = r.run_cycle()
        self.assertTrue(any("daily loss" in x["reason"] for x in tel["refused"]))
        sells = [e for e in tel["executed"] if e["side"] == "sell"]
        self.assertEqual(len(sells), 1)
        self.assertEqual(sells[0]["type"], "market")
        self.assertEqual(r.st.positions, [])
        self.assertEqual(len(r.st.closed), 1)

    def test_halt_does_not_reopen_after_flattening(self):
        r = self._open_then_drop()
        r.run_cycle()
        tel = r.run_cycle()
        self.assertEqual(tel["executed"], [])
        self.assertEqual(r.st.positions, [])

    def test_stop_file_freezes_the_book(self):
        r = self._open_then_drop()
        open(risk.STOP_FILE, "w").write("x")
        tel = r.run_cycle()
        self.assertEqual(tel["executed"], [])
        self.assertEqual(len(r.st.positions), 1)

    def test_live_flatten_is_a_reducing_market_sell(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("filled", v.submitted[-1][1], 100.0)]
        r.run_cycle()                                   # confirmed open
        v.equity = 900.0                                # the venue says -10% today
        tel = r.run_cycle()
        self.assertTrue(any("daily loss" in x["reason"] for x in tel["refused"]))
        sym, qty, side, otype, tif, _cid = v.submitted[-1]
        self.assertEqual((sym, side, otype, tif), ("X", "sell", "market", "day"))
        self.assertEqual(float(qty), 5.0)
        self.assertTrue(r.st.positions[0].get("closeCid"))


class TestMultiLotClose(Base):
    def test_one_close_order_is_distributed_across_lots(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r._desks = r.enabled_desks()
        r._symbol_meta = r.symbol_meta(r._desks)

        def lot(sh):
            return {"symbol": "X", "desk": "_eq", "side": "long", "shares": sh,
                    "targetShares": sh, "entry": 100.0, "openedAt": 1, "cost": sh * 100.0,
                    "openFee": 0.0, "liveCid": f"c{sh}", "liveOpen": True, "liveQty": sh,
                    "mirrorAttempts": 0, "orderType": "cls", "tif": "day",
                    "closeCid": "close1"}
        r.st.positions = [lot(3.0), lot(2.0)]
        r.st.cash = 500.0
        v.script["close1"] = [("filled", 4.0, 110.0)]
        pending = r.reconcile()
        self.assertFalse(pending)
        self.assertEqual(sum(c["shares"] for c in r.st.closed), 4.0)
        self.assertEqual([p["shares"] for p in r.st.positions], [1.0])
        self.assertNotIn("closeCid", r.st.positions[0])
        self.assertAlmostEqual(r.st.cash, 940.0, delta=0.05)
        self.assertAlmostEqual(r.rm.telemetry()["turnover"]["usedUsd"], 440.0, delta=0.01)


class TestTurnoverAccounting(Base):
    def test_fill_confirmed_by_reconcile_spends_the_budget(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()                                   # submitted, pending
        self.assertEqual(r.rm.telemetry()["turnover"]["usedUsd"], 0.0)
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("filled", v.submitted[-1][1], 100.0)]
        r.run_cycle()
        self.assertAlmostEqual(r.rm.telemetry()["turnover"]["usedUsd"], 500.0, delta=0.01)

    def test_paper_fill_spends_the_budget_once(self):
        r = self.runner(["_eq"])
        r.run_cycle()
        self.assertEqual(r.rm.telemetry()["turnover"]["usedUsd"], 0.0)   # nothing filled yet
        self.settle(r, at(1, 16, 5))
        self.assertAlmostEqual(r.rm.telemetry()["turnover"]["usedUsd"], 500.0, delta=1.0)
        self.settle(r, at(1, 16, 10))
        self.assertAlmostEqual(r.rm.telemetry()["turnover"]["usedUsd"], 500.0, delta=1.0)


class TestOncePerBar(Base):
    def test_crypto_desk_ignores_the_forming_candle_and_decides_once_per_bar(self):
        now = dt.datetime(2026, 9, 1, 15, 40, tzinfo=ET)
        t0 = int(now.timestamp()) - 3600 - 9 * 86400    # bar 9 started an hour ago
        self.data["B/USD"] = mkbars([50] * 10, t0=t0)
        r = self.runner(["_cr"], clock=lambda: now)
        r.run_cycle()
        self.assertEqual(r.st.decisions["_cr"]["barTs"], t0 + 8 * 86400)  # last COMPLETED
        self.data["B/USD"] = mkbars([50] * 9 + [80], t0=t0)   # the forming candle moves
        tel = r.run_cycle()
        self.assertTrue(any("unchanged" in n for n in tel["deskNotes"]))
        self.assertEqual(r.st.decisions["_cr"]["barTs"], t0 + 8 * 86400)

    def test_equity_desk_restates_rather_than_redecides_within_a_window(self):
        r = self.runner(["_eq"])
        r.run_cycle()
        tel = r.run_cycle()
        self.assertTrue(any("unchanged" in n for n in tel["deskNotes"]))
        self.assertEqual(tel["executed"], [])           # already at target: no churn


class TestBookVersusVenue(Base):
    def _confirmed(self, venue, shares=5.0):
        r = self.runner(["_eq"], venue=venue)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        venue.script[cid] = [("filled", shares, 100.0)]
        venue.held = [{"symbol": "X", "qty": str(shares)}]
        r.run_cycle()
        self.assertTrue(r.st.positions[0]["liveOpen"])
        return r

    def test_book_shrinks_to_what_the_venue_holds(self):
        v = FakeVenue()
        r = self._confirmed(v)
        v.held = [{"symbol": "X", "qty": "4"}]          # e.g. a fee taken in kind
        tel = r.run_cycle()
        self.assertEqual(tel["bookMismatch"], "")
        confirmed = [p for p in r.st.positions if p["liveOpen"]]
        self.assertEqual([p["shares"] for p in confirmed], [4.0])

    def test_lot_the_venue_no_longer_holds_is_dropped(self):
        v = FakeVenue()
        r = self._confirmed(v)
        v.held = []                                     # sold at the broker by hand
        tel = r.run_cycle()
        self.assertEqual(tel["bookMismatch"], "")
        self.assertEqual([p for p in r.st.positions if p["liveOpen"]], [])

    def test_untracked_venue_position_refuses_trading(self):
        v = FakeVenue()
        v.held = [{"symbol": "X", "qty": "3"}]
        r = self.runner(["_eq"], venue=v)
        tel = r.run_cycle()
        self.assertIn("adopt", tel["bookMismatch"])
        self.assertEqual(v.submitted, [])
        self.assertTrue(any("adopt" in x["reason"] for x in tel["refused"]))

    def test_crypto_symbol_matches_the_venues_spelling(self):
        v = FakeVenue()
        r = self.runner(["_cr"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        qty = v.submitted[-1][1]
        v.script[cid] = [("filled", qty, 50.0)]
        v.held = [{"symbol": "BUSD", "qty": str(qty * 0.9975)}]   # fee taken in kind
        r.run_cycle()
        self.assertAlmostEqual(r.st.positions[0]["shares"], qty * 0.9975, places=6)


class TestModeGuard(Base):
    def test_mode_change_with_positions_is_refused_unless_reset(self):
        import argparse
        from desk import cli
        r = self.runner(["_eq"])
        r.run_cycle()
        self.settle(r, at(1, 16, 5))
        st = r.st
        st.mode = "paper"
        cfg = cfgmod.Config(equity=1000.0)
        args = argparse.Namespace(live=True, i_accept_total_loss=True, venue_paper=True,
                                  reset_book=False)
        with self.assertRaises(SystemExit) as cm:
            cli._arm(args, cfg, st)
        self.assertIn("paper", str(cm.exception))
        self.assertEqual(len(st.positions), 1)          # untouched
        args.reset_book = True
        try:
            cli._arm(args, cfg, st)
        except SystemExit as e:                          # no adapter keys here
            self.assertNotIn("refusing to run", str(e))
        self.assertEqual(st.positions, [])
        self.assertEqual(st.cash, 1000.0)


class TestDefundedDesk(Base):
    def test_desk_that_loses_funding_liquidates_its_positions(self):
        r = self.runner(["_eq"])
        r.run_cycle()
        self.settle(r, at(1, 16, 5))
        self.assertEqual(r.st.positions[0]["shares"], 5.0)
        r._verdicts = {"_eq": {"verdict": "not-significant", "stale": False, "date": "x"}}
        tel = self.settle(r, at(1, 16, 10))
        self.assertTrue(any("liquidating" in n for n in tel["deskNotes"]))
        self.assertEqual(tel["executed"][0]["side"], "sell")
        self.assertEqual(tel["executed"][0]["type"], "cls")     # after the close: next session
        self.data["X"].append(Bar(NEXT, 100.0, 100.0, 100.0, 100.0, 1000.0))
        self.settle(r, at(2, 16, 5))
        self.assertEqual(r.st.positions, [])


class TestReviewRoundThree(Base):
    def test_loss_halt_cancels_a_pending_entry_before_flattening(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()                                   # buy submitted, unconfirmed
        cid = r.st.positions[0]["liveCid"]
        v.equity = 900.0                                # -10% on the day
        tel = r.run_cycle()
        self.assertEqual(getattr(v, "canceled", []), [cid])
        self.assertTrue(any("daily loss" in x["reason"] for x in tel["refused"]))
        self.assertEqual(len(v.submitted), 1)           # nothing new sent

    def test_live_crypto_buy_books_the_gross_fill_until_the_fee_posts(self):
        v = FakeVenue()
        r = self.runner(["_cr"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        qty = v.submitted[-1][1]
        v.script[cid] = [("filled", qty, 50.0)]
        v.held = [{"symbol": "BUSD", "qty": str(qty)}]      # gross, fee not posted yet
        tel = r.run_cycle()
        p = r.st.positions[0]
        self.assertEqual(p["shares"], qty)
        self.assertEqual(tel["bookMismatch"], "")
        self.assertAlmostEqual(r.st.cash, 1000.0 - qty * 50.0, places=6)
        v.held = [{"symbol": "BUSD", "qty": str(qty * 0.9975)}]   # end of day: fee posted
        tel = r.run_cycle()
        self.assertEqual(tel["bookMismatch"], "")
        self.assertAlmostEqual(r.st.positions[0]["shares"], qty * 0.9975, places=9)

    def test_open_position_cap_counts_symbols_not_lots(self):
        r = self.runner(["_cr"])
        r.cfg.limits.max_open_positions = 1
        r.rm.limits.max_open_positions = 1
        r.run_cycle()                                   # one lot of B/USD at 30%
        r.cfg.desk_params = {"_cr": {"w": 0.6}}         # a new completed bar, a bigger target
        self.data["B/USD"] = mkbars([50] * 11)
        tel = self.settle(r, at(3, 15, 40))
        buys = [e for e in tel["executed"] if e["side"] == "buy"]
        self.assertEqual(len(buys), 1)                  # same symbol: not a new position
        self.assertFalse(any("open positions" in (x.get("reason") or "") for x in tel["refused"]))
        self.assertEqual(len(r.st.positions), 2)        # two lots, one symbol


class TestPaperAuction(Base):
    def test_moo_fills_at_the_open_print_not_the_previous_close(self):
        self.data["X"] = mkbars([100] * 10)
        r = self.runner(["_eq"])
        r.run_cycle()                                   # cls buy at 15:40
        self.settle(r, at(1, 16, 5))                    # fills at Tuesday's close: 100
        self.assertAlmostEqual(r.st.positions[0]["entry"], 100.0, delta=0.05)
        self.settle(r, at(2, 9, 10))                    # opg sell, pending
        self.assertTrue(r.st.positions[0].get("closeCid"))
        self.assertEqual(r.st.positions[0]["shares"], 5.0)   # still held: no print yet
        self.data["X"].append(Bar(NEXT, 104.0, 105.0, 99.0, 99.0, 1000.0))
        self.settle(r, at(2, 9, 35))
        self.assertEqual(r.st.positions, [])
        c = r.st.closed[0]
        self.assertAlmostEqual(c["exit"], 104.0, delta=0.05)  # the open, not 99 or 100
        self.assertGreater(c["pnl"], 19.0)

    def test_order_placed_after_the_print_waits_for_the_next_session(self):
        r = self.runner(["_eq"], clock=lambda: at(1, 16, 30))   # after Tuesday's close
        r._desks = r.enabled_desks()
        r.run_cycle()                                   # phase closed: desk holds; nothing sent
        self.assertEqual(r.st.positions, [])
        # force an order after hours through a defunded liquidation path is
        # covered elsewhere; here place one directly with the broker
        r._symbol_meta = r.symbol_meta(r._desks)
        broker = R.PaperBroker(r._symbol_meta, r._load, r.now_et, r.st)
        o = R.Order("_eq", "X", "buy", 1.0, 100.0, "cls", "day", client_order_id="cid-late")
        self.assertEqual(broker.execute(o)["status"], "accepted")
        self.assertEqual(broker.order_state("cid-late")[0], "accepted")   # Tuesday's print is past
        self.data["X"].append(Bar(NEXT, 101.0, 101.0, 101.0, 101.0, 1000.0))
        r._clock = lambda: at(2, 16, 1)
        status, filled, px = broker.order_state("cid-late")
        self.assertEqual((status, filled), ("filled", 1.0))
        self.assertAlmostEqual(px, 101.0, delta=0.05)

    def test_auction_order_expires_when_no_bar_ever_arrives(self):
        self.data["X"] = mkbars([100] * 10, t0=T0 - 86400)   # last bar is Monday
        r = self.runner(["_eq"])
        r.run_cycle()                                   # Tuesday cls buy, pending
        self.settle(r, at(2, 16, 5))                    # a full day later, still no Tuesday bar
        self.assertEqual(r.st.positions, [])            # expired, dropped
        self.assertEqual(r.rm.telemetry()["turnover"]["usedUsd"], 0.0)

    def test_pending_paper_order_survives_a_restart(self):
        r = self.runner(["_eq"])
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        # a new process: fresh broker, same state on disk
        r2 = self.runner(["_eq"])
        r2.st = statemod.load()
        self.assertEqual(r2.st.positions[0]["liveCid"], cid)
        self.settle(r2, at(1, 16, 5))
        self.assertTrue(r2.st.positions[0]["liveOpen"])
        self.assertEqual(r2.st.positions[0]["shares"], 5.0)


class TestDesksShareASymbol(Base):
    def test_one_desk_going_flat_does_not_sell_anothers_lot(self):
        # two desks share equity 50/50: _eq wants 25% (2 whole shares, cls),
        # _hold wants 10% (1 share, market now)
        r = self.runner(["_eq", "_hold"])
        r.run_cycle()
        self.settle(r, at(1, 16, 5))
        lots = {p["desk"]: p["shares"] for p in r.st.positions}
        self.assertEqual(lots, {"_eq": 2.0, "_hold": 1.0})
        tel = self.settle(r, at(2, 9, 10))              # _eq flat at the open; _hold holds
        sells = [e for e in tel["executed"] if e["side"] == "sell"]
        self.assertEqual([(e["shares"], e["type"]) for e in sells], [(2.0, "opg")])
        self.data["X"].append(Bar(NEXT, 100.0, 100.0, 100.0, 100.0, 1000.0))
        self.settle(r, at(2, 9, 35))
        self.assertEqual([(p["desk"], p["shares"]) for p in r.st.positions], [("_hold", 1.0)])
        self.assertEqual(r.st.closed[0]["desk"], "_eq")

    def test_opposite_sides_in_one_cycle_defer_the_buy(self):
        r = self.runner(["_eq", "_hold"])
        r.run_cycle()
        self.settle(r, at(1, 16, 5))                    # _eq 2 lots... _eq 2, _hold 1
        self.settle(r, at(2, 9, 10))                    # _eq sells at the open (opg)
        self.data["X"].append(Bar(NEXT, 100.0, 100.0, 100.0, 100.0, 1000.0))
        self.settle(r, at(2, 9, 35))
        self.assertEqual([(p["desk"], p["shares"]) for p in r.st.positions], [("_hold", 1.0)])
        r.cfg.desk_params = {"_hold": {"w": 0.0}}       # _hold wants out at the close...
        tel = self.settle(r, at(2, 15, 40))             # ...while _eq wants back in
        sides = [(e["side"], e.get("status", "filled")) for e in tel["executed"]]
        self.assertEqual(sides, [("sell", "filled")])
        self.assertTrue(any("deferred" in n for n in tel["deskNotes"]))
        self.assertEqual(r.st.positions, [])
        tel = self.settle(r, at(2, 15, 45))             # next cycle: the buy goes
        self.assertEqual([(e["side"], e["status"]) for e in tel["executed"]],
                         [("buy", "accepted")])


class TestRoundSix(Base):
    def test_resting_orders_reserve_turnover_within_a_cycle(self):
        r = self.runner(["_eq", "_hold"])
        r.rm.limits.max_annual_turnover = 0.25            # $250 on $1,000
        r.rm.budget.allowance_x = 0.25
        tel = r.run_cycle()                               # _eq: $200 cls resting; _hold: $100
        kinds = [(e["side"], e.get("status", "filled")) for e in tel["executed"]]
        self.assertEqual(kinds, [("buy", "accepted")])   # the auction order rests...
        self.assertTrue(any("turnover" in (x.get("reason") or "") for x in tel["refused"]))

    def test_paper_charges_the_daily_fee_floor_at_the_next_session(self):
        from desk.core import money
        r = self.runner(["_eq"])
        r.run_cycle()
        self.settle(r, at(1, 16, 5))                      # filled: a tiny CAT fee today
        cash_after_fill = r.st.cash
        raw = r.st.fee_day.get("raw", 0.0)
        self.assertTrue(r.st.fee_day.get("traded"))
        self.settle(r, at(2, 9, 10))                      # new session: floor charged
        extra = money.daily_fee_floor(raw, True)
        self.assertGreater(extra, 0.0)
        self.assertAlmostEqual(cash_after_fill - r.st.cash, extra, places=6)
        self.assertEqual(r.st.fee_day, {})


class TestLotOutsideTheUniverse(Base):
    def test_venue_check_keeps_a_lot_whose_desk_was_removed(self):
        v = FakeVenue()
        r = self.runner(["_eq"], venue=v)
        r.run_cycle()
        cid = r.st.positions[0]["liveCid"]
        v.script[cid] = [("filled", v.submitted[-1][1], 100.0)]
        v.held = [{"symbol": "X", "qty": "5"}]
        r.run_cycle()
        self.assertTrue(r.st.positions[0]["liveOpen"])
        r.cfg.desks = ("_cr",)                          # X's desk is gone from the config
        r._verdicts["_cr"] = {"verdict": "validated", "stale": False, "date": "t"}
        tel = r.run_cycle()
        self.assertEqual([p["shares"] for p in r.st.positions if p["symbol"] == "X"], [5.0])
        self.assertIn("no configured desk", tel["bookMismatch"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
