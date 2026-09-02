#!/usr/bin/env python3
"""Unit tests for the Kalshi favorite-longshot desk.

Keyless and offline: every input is a fixture shaped like a real Kalshi
market dict, so these run without network access and cannot be broken by an
exchange outage. Three things are pinned, all of them mistakes this study
actually had to correct:

  * the fee, including that a held-to-settlement position pays it ONCE and
    that it is quadratic in price, which is what makes the favorite end
    cheap and the middle expensive;
  * the screen's gates, especially the spread filter - an unfiltered ask of
    99c against a 50c bid produced the single most misleading number in the
    whole study;
  * the bucketing, including that a price of exactly 0 or 1 is excluded
    rather than bucketed, because including settled prices is how a
    calibration study reports a perfect forecast record.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from desk.core import money                                    # noqa: E402
from desk.desks import kalshi_bias as kb                        # noqa: E402
from desk.desks.base import CLOSE, View                         # noqa: E402
from desk.data.bars import Bar                                  # noqa: E402


def market(ticker="KXTEST-26AUG30-A", ask="0.93", bid="0.91",
           volume="5000.00", depth="200.00"):
    """A live GET /markets row, reduced to the fields the screen reads."""
    return {"ticker": ticker, "yes_ask_dollars": ask, "yes_bid_dollars": bid,
            "volume_fp": volume, "yes_ask_size_fp": depth}


# A calibration that DOES clear the gate, used to prove the screen can fire.
# The shipped MEASURED_GAP_PP does not clear it; that is the finding, and it
# is asserted separately below.
ARMED = {"gap_pp": {"0.90-0.95": 2.5, "0.95-0.98": 1.5},
         "gap_t": {"0.90-0.95": 3.0, "0.95-0.98": 3.0},
         "equity": 100.0}


class TestFeeMath(unittest.TestCase):
    def test_fee_is_quadratic_and_peaks_at_the_money(self):
        # 0.07 x P x (1-P) per contract, ceiling to a millionth of a dollar.
        # The ceiling is why these are asserted from below, not exactly: the
        # exchange always rounds the fee AGAINST the trader.
        for price, raw in ((0.50, 0.0175), (0.90, 0.0063), (0.99, 0.000693)):
            fee = money.kalshi_fee(price, 1)
            self.assertGreaterEqual(fee, raw)
            self.assertLess(fee - raw, 1e-6 + 1e-12)
        self.assertLess(money.kalshi_fee(0.90, 1), money.kalshi_fee(0.50, 1))

    def test_settlement_pays_one_fee_not_two(self):
        # Holding to expiry is not an exit trade, so the winner keeps the
        # full 10c minus a single 0.63c entry fee.
        win = kb.net_pnl_per_contract(0.90, True)
        self.assertAlmostEqual(win, 0.10 - 0.0063, places=6)
        lose = kb.net_pnl_per_contract(0.90, False)
        self.assertAlmostEqual(lose, -0.90 - 0.0063, places=6)

    def test_fee_is_a_bigger_share_of_the_PRIZE_at_the_favorite_end(self):
        # The fee falls with price but the prize falls faster: 3.5% of the
        # win at 50c, 6.9% of it at 99c. This is why "favorites are cheap to
        # trade" is only half true.
        self.assertAlmostEqual(money.kalshi_fee(0.50, 1) / 0.50, 0.035, places=4)
        self.assertGreater(money.kalshi_fee(0.99, 1) / 0.01, 0.068)

    def test_maker_is_free_outside_the_headline_economics_series(self):
        self.assertEqual(money.kalshi_fee(0.93, 1, maker=True, series="KXMLBGAME"), 0.0)
        self.assertGreater(money.kalshi_fee(0.93, 1, maker=True, series="KXCPI"), 0.0)

    def test_edge_after_fees_is_the_gap_minus_the_fee(self):
        # A 2.5pp calibration gap at 93c is 2.5c gross, 0.456c of fee.
        e = kb.edge_after_fees(0.93, 2.5)
        self.assertAlmostEqual(e, 0.025 - money.kalshi_fee(0.93, 1), places=8)
        # A 0.5pp gap at 50c does not survive the fee at all.
        self.assertLess(kb.edge_after_fees(0.50, 0.5), 0.0)


class TestBucketing(unittest.TestCase):
    def test_prices_land_in_the_expected_bucket(self):
        self.assertEqual(kb.bucket_label(kb.bucket_of(0.93)), "0.90-0.95")
        self.assertEqual(kb.bucket_label(kb.bucket_of(0.01)), "0.00-0.02")
        # Upper-inclusive edges: 0.90 belongs to the bucket below it.
        self.assertEqual(kb.bucket_label(kb.bucket_of(0.90)), "0.80-0.90")

    def test_settled_prices_are_excluded_not_bucketed(self):
        self.assertIsNone(kb.bucket_of(0.0))
        self.assertIsNone(kb.bucket_of(1.0))
        self.assertIsNone(kb.bucket_of(None))
        self.assertIsNone(kb.bucket_of("not a price"))

    def test_dollar_strings_parse_and_cent_truncation_is_avoided(self):
        # The *_dollars fields carry sub-cent prices the legacy integer
        # fields would truncate to zero.
        self.assertAlmostEqual(kb.parse_dollars("0.0050"), 0.005)
        self.assertEqual(kb.bucket_label(kb.bucket_of("0.0050")), "0.00-0.02")

    def test_calibration_table_measures_the_gap(self):
        rows = ([{"price": 0.90, "won": True}] * 90 +
                [{"price": 0.90, "won": False}] * 10)
        t = kb.calibration_table(rows)
        self.assertEqual(len(t), 1)
        row = t[0]
        self.assertEqual(row["n"], 100)
        self.assertAlmostEqual(row["mean_price"], 0.90)
        self.assertAlmostEqual(row["realized"], 0.90)
        self.assertAlmostEqual(row["gap"], 0.0, places=9)

    def test_standard_error_uses_the_price_as_the_null(self):
        # 12 winners at 90c: se = sqrt(.9 x .1 / 12), NOT zero. Using the
        # realized rate would divide by zero and call it certainty.
        rows = [{"price": 0.90, "won": True}] * 12
        row = kb.calibration_table(rows)[0]
        self.assertAlmostEqual(row["se"], (0.9 * 0.1 / 12) ** 0.5, places=9)
        self.assertLess(row["t"], 2.0)

    def test_buckets_partition_the_unit_interval(self):
        seen = set()
        for i in range(1, 1000):
            b = kb.bucket_of(i / 1000.0)
            self.assertIsNotNone(b)
            seen.add(b)
        self.assertEqual(seen, set(range(len(kb.BUCKETS) - 1)))


class TestScreen(unittest.TestCase):
    def test_shipped_calibration_arms_nothing(self):
        # The headline result, asserted: at the measured gaps no bucket beats
        # its own noise, so the screen buys nothing.
        self.assertEqual(kb.screen_markets([market()]), [])

    def test_fires_when_a_bucket_is_genuinely_significant(self):
        out = kb.screen_markets([market()], ARMED)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["ticker"], "KXTEST-26AUG30-A")
        self.assertAlmostEqual(out[0]["price"], 0.93)
        self.assertGreater(out[0]["edge"], 0.0)

    def test_wide_quote_is_rejected_however_attractive_the_ask(self):
        # 93c ask against a 50c bid is an empty book, not a favorite.
        self.assertEqual(kb.screen_markets([market(bid="0.50")], ARMED), [])

    def test_one_sided_book_is_rejected(self):
        self.assertEqual(kb.screen_markets([market(bid="0.00")], ARMED), [])
        self.assertEqual(kb.screen_markets([market(ask="1.00", bid="0.97")], ARMED), [])

    def test_price_band_is_enforced_at_both_ends(self):
        self.assertEqual(kb.screen_markets([market(ask="0.60", bid="0.58")], ARMED), [])
        self.assertEqual(kb.screen_markets([market(ask="0.995", bid="0.99")], ARMED), [])

    def test_illiquid_markets_are_rejected(self):
        self.assertEqual(kb.screen_markets([market(volume="10")], ARMED), [])
        self.assertEqual(kb.screen_markets([market(depth="0.00")], ARMED), [])

    def test_size_is_capped_by_resting_depth_and_by_position_limit(self):
        # 5% of $100 at 93c wants 5.37 contracts; only 2 are offered.
        out = kb.screen_markets([market(depth="2.00")], ARMED)
        self.assertAlmostEqual(out[0]["size"], 2.0)
        # Fractional to 0.01 - a $40 account still gets a real position.
        out = kb.screen_markets([market()], {**ARMED, "equity": 40.0})
        self.assertAlmostEqual(out[0]["size"], 2.15)

    def test_results_are_ranked_by_expected_dollars(self):
        out = kb.screen_markets(
            [market("KXA-1", ask="0.96", bid="0.95"),
             market("KXB-1", ask="0.93", bid="0.91")], ARMED)
        self.assertEqual([r["ticker"] for r in out], ["KXB-1", "KXA-1"])

    def test_max_positions_truncates(self):
        ms = [market(f"KXA-{i}") for i in range(20)]
        self.assertEqual(len(kb.screen_markets(ms, {**ARMED, "max_positions": 3})), 3)

    def test_malformed_rows_are_skipped_not_raised(self):
        self.assertEqual(kb.screen_markets([{}, {"ticker": "X"}, None or {}], ARMED), [])


class TestDesk(unittest.TestCase):
    """The framework wrapper must agree with the screen, including on
    holding nothing at the shipped calibration."""

    @staticmethod
    def _view(prices, event=CLOSE):
        series = {"KXTEST-26AUG30-A":
                  [Bar(1_700_000_000 + i * 86400, p, p, p, p, 1000.0)
                   for i, p in enumerate(prices)]}
        return View(series, len(prices) - 1, event, series["KXTEST-26AUG30-A"][-1].t)

    def test_holds_nothing_at_the_shipped_calibration(self):
        d = kb.KalshiFavoriteLongshot()
        self.assertEqual(d.decide(self._view([0.91, 0.92, 0.93])).weights, {})

    def test_holds_when_the_bucket_is_significant(self):
        d = kb.KalshiFavoriteLongshot(**{k: v for k, v in ARMED.items()
                                         if k != "equity"})
        dec = d.decide(self._view([0.91, 0.92, 0.93]))
        self.assertEqual(list(dec.weights), ["KXTEST-26AUG30-A"])
        self.assertAlmostEqual(dec.weights["KXTEST-26AUG30-A"], 0.05)

    def test_entry_band_must_have_been_touched(self):
        d = kb.KalshiFavoriteLongshot(**{k: v for k, v in ARMED.items()
                                         if k != "equity"})
        # Never inside [0.85, 0.98]: nothing to hold even though the last
        # price sits in a significant bucket.
        self.assertEqual(d.decide(self._view([0.99, 0.99, 0.99])).weights, {})

    def test_meta_declares_the_venue_truthfully(self):
        m = kb.KalshiFavoriteLongshot.meta
        self.assertEqual(m.venue, "kalshi")
        self.assertEqual(m.asset_class, "prediction")
        # A taker lifting the ask. Modelling this as a maker would assume the
        # answer the study set out to test.
        self.assertEqual(m.execution_style, "crossing")
        self.assertFalse(m.pdt_day_trades)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestEventConcentration(unittest.TestCase):
    """Strikes inside one event are the same bet at different thresholds."""

    @staticmethod
    def _strike(n, event="KXHIGHNY-26AUG30"):
        m = market(f"{event}-B{n}")
        m["event_ticker"] = event
        return m

    def test_only_one_strike_per_event_is_taken(self):
        out = kb.screen_markets([self._strike(i) for i in range(5)], ARMED)
        self.assertEqual(len(out), 1)

    def test_separate_events_are_not_collapsed(self):
        ms = [self._strike(1, "KXHIGHNY-26AUG30"), self._strike(1, "KXHIGHLAX-26AUG30")]
        self.assertEqual(len(kb.screen_markets(ms, ARMED)), 2)

    def test_missing_event_ticker_falls_back_to_the_ticker(self):
        # No event field: each market is its own event, nothing is dropped.
        ms = [market("KXA-1"), market("KXB-1")]
        self.assertEqual(len(kb.screen_markets(ms, ARMED)), 2)

    def test_output_rows_carry_only_the_documented_keys(self):
        out = kb.screen_markets([market()], ARMED)
        self.assertEqual(set(out[0]), {"ticker", "price", "size", "edge"})
