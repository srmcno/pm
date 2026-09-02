#!/usr/bin/env python3
"""Offline tests for the Alpaca adapter: the client-side order rules and the
fill-state contract. No network, no credentials."""
import datetime as dt
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from desk.venues import alpaca as A                            # noqa: E402


class TestValidators(unittest.TestCase):
    def ok(self, *args, **kw):
        A.validate_order(*args, **kw)

    def bad(self, *args, **kw):
        with self.assertRaises(ValueError):
            A.validate_order(*args, **kw)

    def test_auction_orders_must_be_whole_shares(self):
        self.ok("SPY", 3, "buy", "cls", "day")
        self.ok("SPY", 3, "sell", "opg", "day")
        self.bad("SPY", 2.5, "buy", "cls", "day")
        self.bad("SPY", 0.4, "sell", "opg", "day")

    def test_fractional_takes_day_only_and_no_auction_types(self):
        self.ok("IWM", 1.25, "buy", "market", "day")
        self.bad("IWM", 1.25, "buy", "market", "gtc")
        self.bad("IWM", 1.25, "buy", "market", "ioc")
        self.bad("IWM", 1.25, "buy", "cls", "day")

    def test_no_fractional_shorts(self):
        self.bad("IWM", 1.5, "sell_short", "market", "day")
        self.ok("IWM", 2, "sell_short", "market", "day", can_short=True)
        self.bad("IWM", 2, "sell_short", "market", "day", can_short=False)

    def test_crypto_rules(self):
        self.ok("BTC/USD", 0.0012, "buy", "market", "gtc")
        self.ok("BTC/USD", 0.0012, "buy", "limit", "ioc")
        self.bad("BTC/USD", 0.0012, "buy", "market", "day")
        self.bad("BTC/USD", 0.0012, "buy", "cls", "day")
        self.bad("BTC/USD", 0.0012, "sell_short", "market", "gtc")

    def test_extended_hours_needs_limit(self):
        self.ok("SPY", 1, "buy", "limit", "day", extended_hours=True)
        self.bad("SPY", 1, "buy", "market", "day", extended_hours=True)


class TestCutoffs(unittest.TestCase):
    def test_moc_and_moo_cutoffs(self):
        et = A._et()
        t = dt.datetime(2026, 9, 1, 15, 49, tzinfo=et)
        self.assertTrue(A.auction_cutoff_ok("cls", t))
        self.assertFalse(A.auction_cutoff_ok("cls", t.replace(minute=50)))
        self.assertTrue(A.auction_cutoff_ok("opg", t.replace(hour=9, minute=27)))
        self.assertFalse(A.auction_cutoff_ok("opg", t.replace(hour=9, minute=28)))
        self.assertTrue(A.auction_cutoff_ok("market", t.replace(hour=15, minute=59)))


class _Fake(A.AlpacaVenue):
    """Transport stub: answers by client id."""
    def __init__(self, answers):
        super().__init__(paper=True, key="k", secret="s")
        self.answers = answers
        self.sent = []

    def _api(self, method, path, params=None, body=None):
        if path == "/v2/orders:by_client_order_id":
            cid = params["client_order_id"]
            if cid not in self.answers:
                raise A.VenueError(404, "order not found")
            a = self.answers[cid]
            if a == "boom":
                raise A.VenueError(500, "server error")
            return a
        if path == "/v2/orders" and method == "POST":
            self.sent.append(body)
            return {"id": "o1", "status": "accepted", **body}
        if path == "/v2/clock":
            return {"timestamp": "2026-09-01T19:30:00Z", "is_open": True}
        if path == "/v2/account":
            return {"equity": "1500", "shorting_enabled": True}
        raise AssertionError(path)


class TestOrderState(unittest.TestCase):
    def test_states_are_distinguished(self):
        v = _Fake({
            "a": {"status": "filled", "filled_qty": "3", "filled_avg_price": "101.5"},
            "b": {"status": "partially_filled", "filled_qty": "1", "filled_avg_price": "100"},
            "c": "boom",
        })
        self.assertEqual(v.order_state("a"), ("filled", 3.0, 101.5))
        self.assertEqual(v.order_state("b"), ("partially_filled", 1.0, 100.0))
        self.assertEqual(v.order_state("zzz"), ("not_found", 0.0, None))
        self.assertEqual(v.order_state("c"), (None, 0.0, None))

    def test_submit_maps_auction_to_tif(self):
        v = _Fake({})
        now = dt.datetime(2026, 9, 1, 15, 40, tzinfo=A._et())
        v.submit("SPY", 2, "buy", order_type="cls", client_order_id="x", now_et=now)
        body = v.sent[-1]
        self.assertEqual(body["type"], "market")
        self.assertEqual(body["time_in_force"], "cls")
        self.assertEqual(body["qty"], "2")
        with self.assertRaises(ValueError):
            v.submit("SPY", 2, "buy", order_type="cls", now_et=now.replace(minute=55))

    def test_crypto_defaults_to_gtc(self):
        v = _Fake({})
        v.submit("BTC/USD", 0.002, "buy", client_order_id="y")
        self.assertEqual(v.sent[-1]["time_in_force"], "gtc")

    def test_cannot_short_under_two_thousand(self):
        v = _Fake({})
        self.assertFalse(v.can_short())


class TestArming(unittest.TestCase):
    def test_requires_both_flags_and_keys(self):
        class Args:
            live = True
            i_accept_total_loss = False
        os.environ.pop("APCA_API_KEY_ID", None)
        with self.assertRaises(A.NotArmed):
            A.assert_armed(Args())
        Args.i_accept_total_loss = True
        with self.assertRaises(A.NotArmed):      # still no keys
            A.assert_armed(Args())


class TestQtyFormat(unittest.TestCase):
    def test_no_exponent_notation_for_dust(self):
        from desk.venues.alpaca import format_qty
        self.assertEqual(format_qty(1.6e-05), "0.000016")
        self.assertEqual(format_qty(5), "5")
        self.assertEqual(format_qty(5.0), "5")
        self.assertEqual(format_qty(0.5), "0.5")
        self.assertEqual(format_qty(0.009975), "0.009975")


if __name__ == "__main__":
    unittest.main(verbosity=1)
