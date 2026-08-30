#!/usr/bin/env python3
"""Overnight drift — hold US equity ETFs only while the market is closed.

The anomaly, measured on ten years of daily bars from this repo's own data
loader (2016-2026):

    symbol   overnight ann.   Sharpe      intraday ann.   Sharpe
    SPY               +9.5%     0.82               +4.7%    0.35
    QQQ              +13.5%     0.98               +7.2%    0.40
    IWM              +15.9%     1.10               -4.5%   -0.25
    GLD              +13.7%     1.12               -0.7%   -0.07
    IBIT             +48.6%     1.30              -17.3%   -0.54
    TLT               -6.5%    -0.60               +2.4%    0.23

Essentially all of the equity risk premium accrues between the close and
the next open, and the intraday session gives much of it back. TLT going
the other way is the useful control: this is a risk premium attached to
equity-like assets, not an artifact of the measurement.

Why it is tradable by a small US account, where most edges are not:
  * Commissions are zero at Alpaca and fractional shares work, so a $40
    account can hold a real position in a $700 ETF.
  * A position opened at the close and closed at the next open is NOT a
    day trade, so the pattern-day-trader rule does not bind. This is the
    rare strategy a sub-$25k account can run at full frequency.
  * Two crossings per day is the entire cost. On penny-wide ETFs that is
    ~2-4bps against a ~6bps average overnight move on IWM — thin, real,
    and the reason this desk only holds names whose measured edge clears
    its own costs rather than the whole universe.

What it is NOT: free money. It is compensation for holding gap risk
overnight, and it pays that compensation with occasional violent gaps.
The vol-scaled sizing and the per-name edge screen exist for that.

MEASURED RESULT, seven-ETF universe, 2016-2026, costs charged in full:

    walk-forward out-of-sample, fixed parameters   Sharpe 0.83, CAGR 8.6%
    same window, buy-and-hold SPY                  Sharpe 0.92, CAGR 20.0%
    max drawdown, desk vs SPY                      -19%  vs  -35.6%

Read that honestly: the desk does NOT beat buy-and-hold on absolute
return, and it is not meant to. It earns a similar risk-adjusted return
while exposed to the market roughly half the time and drawing down about
half as deeply. Four different fixed parameter settings all validated
out-of-sample, which is the robustness evidence that matters — when the
per-fold grid search was allowed to pick, the deflated Sharpe fell to 0.84
and the folds disagreed with each other, so this desk ships with FIXED
parameters and no optimization.

CAPITAL FLOOR, measured on the same ten years:

    start    end     CAGR   Sharpe   fees as % of capital per year
    $40      $0.00      -        -   14.4%   <- account destroyed by fees
    $100     $138    3.4%     0.38    6.9%
    $250     $513    7.9%     0.80    2.7%
    $500   $1,139    9.1%     0.91    1.4%
    $1,000 $2,382    9.6%     0.96    0.8%

The desk trades every session, and US regulatory fees are aggregated per
day and rounded up to the cent, so any active day costs at least $0.03
regardless of size. At $40 that is the entire edge and then some. This is
why `capital_floor` is $250 and not a token value: below it the desk does
not underperform, it dies.
"""
import statistics as st

from .base import CLOSE, OPEN, Decision, Desk, DeskMeta, View, register


@register
class OvernightDrift(Desk):
    meta = DeskMeta(
        name="overnight",
        title="Overnight drift (US ETFs)",
        asset_class="equity",
        venue="alpaca",
        interval="1d",
        periods_per_year=252,
        events=(OPEN, CLOSE),
        universe=("SPY", "QQQ", "IWM", "XLK", "GLD", "IBIT", "SMH", "EFA"),
        warmup_bars=130,
        # Measured, not guessed: see the table above. $250 is where the
        # per-day fee floor stops dominating; $500 is where it is noise.
        capital_floor=250.0,
        pdt_day_trades=False,      # held overnight — never a day trade
        shortable=False,
        fractional=True,
        # Both legs are auction orders — MOC into the close, MOO out of the
        # open — so they fill at the official print with no spread to cross.
        # This is what makes ~500 round trips a year survivable; the same
        # strategy crossing the book on marketable orders does not clear.
        execution_style="auction",
        description="Long a vol-scaled basket at the close, flat at the open. "
                    "Holds only names whose trailing overnight edge clears "
                    "the round-trip cost of getting in and out.",
    )

    @classmethod
    def defaults(cls):
        return {
            "lookback": 120,        # sessions used to measure a name's edge
            "min_edge_bps": 3.0,    # required trailing mean overnight return
            "target_vol": 0.15,     # annualized, per name, before capping
            "max_names": 4,
            "max_weight": 0.34,     # per name, of equity
            "max_gross": 1.0,
        }

    @classmethod
    def param_grid(cls):
        # Deliberately coarse: every point is a trial the deflated Sharpe
        # has to discount, so this asks four honest questions, not 216.
        return {
            "lookback": [60, 120, 250],
            "min_edge_bps": [0.0, 3.0, 6.0],
        }

    # ------------------------------------------------------------- signal
    @staticmethod
    def _overnight_returns(bars):
        """close[j] -> open[j+1] returns for every completed pair."""
        out = []
        for j in range(len(bars) - 1):
            c, o = bars[j].c, bars[j + 1].o
            if c > 0 and o > 0:
                out.append(o / c - 1)
        return out

    def decide(self, view: View) -> Decision:
        # At the open we are done: the overnight leg is over, take the risk off.
        if view.event == OPEN:
            return Decision({}, note="flat during the session")

        look = int(self.params["lookback"])
        min_edge = float(self.params["min_edge_bps"]) / 1e4
        tvol = float(self.params["target_vol"])
        cap = float(self.params["max_weight"])

        scored = []
        for sym in view.symbols():
            bars = view.bars(sym)
            if len(bars) < look + 2:
                continue
            on = self._overnight_returns(bars[-(look + 1):])
            if len(on) < look // 2:
                continue
            mean = st.mean(on)
            if mean < min_edge:
                continue
            sd = st.pstdev(on)
            if sd <= 0:
                continue
            ann_vol = sd * (252 ** 0.5)
            # Weight that targets `target_vol` on this name's overnight vol,
            # then capped. Higher-vol names get less, which keeps a single
            # gap in a leveraged name from dominating the book.
            w = min(cap, self.vol_scaled_weight(tvol, ann_vol, cap))
            if w > 0:
                scored.append((mean / sd, sym, w, mean))

        if not scored:
            return Decision({}, note="no name clears its cost hurdle")

        scored.sort(reverse=True)
        picks = scored[: int(self.params["max_names"])]
        weights = {sym: w for _, sym, w, _ in picks}

        gross = sum(weights.values())
        mx = float(self.params["max_gross"])
        if gross > mx:
            weights = {s: w * mx / gross for s, w in weights.items()}

        note = "hold overnight: " + ", ".join(
            f"{s} {w:.0%} (edge {e*1e4:.1f}bp)" for _, s, w, e in picks)
        return Decision(weights, note=note)
