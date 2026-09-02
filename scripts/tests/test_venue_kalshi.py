#!/usr/bin/env python3
"""Offline tests for the Kalshi adapter: tick-grid snapping, fixed point,
cutoff routing, and the fee delegation. No network, no credentials."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from desk.venues import kalshi as K                            # noqa: E402


TAPERED = {"price_ranges": [
    {"start": "0.00", "end": "0.10", "step": "0.001"},
    {"start": "0.10", "end": "0.90", "step": "0.01"},
    {"start": "0.90", "end": "1.00", "step": "0.001"},
]}
LINEAR = {"price_ranges": [{"start": "0.00", "end": "1.00", "step": "0.01"}]}


class TestSnap(unittest.TestCase):
    def test_linear_cent_grid(self):
        self.assertAlmostEqual(K.snap_price(LINEAR, 0.4567, "down"), 0.45)
        self.assertAlmostEqual(K.snap_price(LINEAR, 0.4567, "up"), 0.46)
        self.assertAlmostEqual(K.snap_price(LINEAR, 0.4567, "nearest"), 0.46)
        self.assertAlmostEqual(K.snap_price(LINEAR, 0.45, "up"), 0.45)   # on-grid stays

    def test_tapered_uses_the_band_the_price_is_in(self):
        self.assertAlmostEqual(K.snap_price(TAPERED, 0.0567, "down"), 0.056)
        self.assertAlmostEqual(K.snap_price(TAPERED, 0.4567, "down"), 0.45)
        self.assertAlmostEqual(K.snap_price(TAPERED, 0.9567, "down"), 0.956)
        self.assertAlmostEqual(K.snap_price(TAPERED, 0.9567, "up"), 0.957)

    def test_no_grid_means_refuse_not_guess(self):
        self.assertIsNone(K.snap_price({}, 0.5))


class TestFixedPoint(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(K.to_fp(58.16), "58.16")
        self.assertEqual(K.to_fp(1), "1.00")
        self.assertEqual(K.from_fp("264.03"), 264.03)
        self.assertEqual(K.from_fp(None), 0.0)

    def test_dollars_parser_rejects_out_of_range(self):
        self.assertEqual(K.dollars("0.4500"), 0.45)
        self.assertIsNone(K.dollars("1.5"))
        self.assertIsNone(K.dollars(None))


class TestRouting(unittest.TestCase):
    def _venue(self, log):
        def transport(method, url, headers, body):
            log.append(url)
            if url.endswith("/historical/cutoff"):
                return 200, json.dumps({"market_settled_ts": "2026-07-04T00:00:00Z"})
            if "/historical/markets" in url:
                return 200, json.dumps({"markets": [{"ticker": "OLD"}]})
            if "/markets?" in url:
                return 200, json.dumps({"markets": [{"ticker": "NEW"}]})
            if "/portfolio/orders/o9" in url:
                return 404, "not found"
            return 200, "{}"
        return K.KalshiVenue(transport=transport)

    def test_old_settlements_go_to_the_historical_partition(self):
        log = []
        v = self._venue(log)
        old = v.settled_markets(settled_before_iso="2026-05-01T00:00:00Z")
        new = v.settled_markets(settled_before_iso="2026-08-01T00:00:00Z")
        self.assertEqual(old["markets"][0]["ticker"], "OLD")
        self.assertEqual(new["markets"][0]["ticker"], "NEW")
        self.assertTrue(any("/historical/cutoff" in u for u in log))

    def test_candlestick_interval_is_validated(self):
        v = self._venue([])
        with self.assertRaises(ValueError):
            v.candlesticks("KX", "KX-1", 0, 1, period_interval=5)

    def test_order_state_not_found_is_distinct(self):
        v = self._venue([])
        v._key = object()                              # bypass key loading
        v._signed_headers = lambda m, p: {}
        self.assertEqual(v.order_state("o9"), ("not_found", 0.0, None))


class TestFees(unittest.TestCase):
    def test_maker_free_on_plain_quadratic(self):
        self.assertEqual(K.fee(0.5, 10, maker=True, series_obj={"fee_type": "quadratic"}), 0.0)

    def test_maker_charged_quarter_on_economics_series(self):
        f = K.fee(0.5, 10, maker=True, series_obj={"fee_type": "quadratic_with_maker_fees",
                                                    "fee_multiplier": 1})
        self.assertGreater(f, 0.0)
        self.assertLess(f, K.fee(0.5, 10, maker=False, series_obj={"fee_type": "quadratic",
                                                                     "fee_multiplier": 1}))

    def test_multiplier_scales_taker_fee(self):
        full = K.fee(0.5, 10, series_obj={"fee_type": "quadratic", "fee_multiplier": 1})
        half = K.fee(0.5, 10, series_obj={"fee_type": "quadratic", "fee_multiplier": 0.5})
        self.assertAlmostEqual(half, full / 2, places=5)
        self.assertEqual(K.fee(0.5, 10, series_obj={"fee_type": "quadratic", "fee_multiplier": 0}), 0.0)


class TestReviewFixes(unittest.TestCase):
    def test_to_fp_never_exceeds_the_requested_size(self):
        self.assertEqual(K.to_fp(0.238), "0.23")
        self.assertEqual(K.to_fp(1.999), "1.99")
        self.assertEqual(K.to_fp(2.0), "2.00")

    def test_null_fee_multiplier_means_the_standard_rate(self):
        self.assertEqual(K.series_fee_params({"fee_multiplier": None})[1], 1.0)
        self.assertEqual(K.series_fee_params({"fee_multiplier": ""})[1], 1.0)
        self.assertEqual(K.series_fee_params({})[1], 1.0)
        self.assertEqual(K.series_fee_params({"fee_multiplier": 0})[1], 0.0)
        self.assertEqual(K.series_fee_params({"fee_multiplier": "0.25"})[1], 0.25)


if __name__ == "__main__":
    unittest.main(verbosity=1)
