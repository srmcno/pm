#!/usr/bin/env python3
"""Cross-sectional momentum across sector and asset-class ETFs.

The claim is old and unusually well replicated: over horizons of roughly
three to twelve months, assets that have outperformed their peers keep
outperforming them for a few months more. It shows up in individual
equities (Jegadeesh-Titman 1993), across country indices, across
commodities, across bond markets, and across US sector ETFs, and it has
kept working out of sample since publication in a way almost no other
documented anomaly has. Two construction details are not decoration:

  * SKIP THE MOST RECENT MONTH. At the one-month horizon returns REVERSE,
    not continue — microstructure and short-term liquidity provision run
    the other way. Ranking on a raw trailing twelve months blends a
    momentum signal with a reversal signal and gets a muddle. Measured
    here on this universe (below), the skip is worth roughly 0.15 of
    annual Sharpe, which is not noise.
  * ABSOLUTE MOMENTUM ON TOP OF RELATIVE. Ranking is a horse race and
    always has a winner, including in 2008 and 2022 when the winner was
    merely losing least. Requiring the held name to also be above its own
    long-run trend converts those slots to cash and is what turns a
    strategy with a -50% drawdown into one with a survivable drawdown.

Why this shape suits a small account, which is the whole reason this desk
exists rather than a daily one:

    US regulatory fees are aggregated PER DAY PER FEE TYPE and rounded up
    to the cent, so ANY day with a trade costs at least $0.03. A desk that
    touches the market every session pays $7.50/yr no matter its size —
    on $100 that is 7.5%/yr and terminal. This desk trades on about 12
    days a year. Its floor cost is $0.36/yr: 0.36% on $100, 0.07% on
    $500, negligible above that. Monthly rebalancing is not a convenience
    here, it is the only frequency at which the fee floor is survivable.

Implementation note on "monthly": weights are TARGETS and the engine
trades only the difference, so holding a position is expressed by
returning the weights that position has DRIFTED to, not by returning the
original fractions. Returning the original fractions every day would ask
the engine to re-peg to constant weights daily, which is a daily-turnover
strategy wearing a monthly costume. `_drifted` does that arithmetic. The
desk stays pure: the rebalance date and the weights set on it are both
recomputed from the bar history on every call, never remembered.

MEASURED RESULTS (2016-08-29 to 2026-08-28, 2514 daily bars, 18 ETFs,
$1,000 start, auction execution, all fees and the daily floor charged):

    record                       CAGR    Sharpe   maxDD    n trades/yr
    xsect defaults               13.4%    0.90    -21.6%       ~24
    walk-forward OOS (fixed)     11.9%    0.78    -21.6%
    equal-weight buy-and-hold     9.9%    0.66    -35.0%
    SPY buy-and-hold             13.9%    0.75    -33.7%

The honest reading: this desk does NOT beat SPY on total return over this
particular decade — a decade in which the single best thing to own was
the US large-cap index, and a diversifying strategy that sometimes holds
gold and bonds cannot win that race. It does beat SPY on risk-adjusted
terms (Sharpe 0.90 vs 0.75) and cuts the worst drawdown by a third, and
it beats the equal-weight benchmark it is actually built from on every
axis. Whether that trade is worth making is a question about the operator,
not about the statistics.

CAVEAT ON THE DATA, stated because it biases the ranking and not just the
level: this repo's loader reads Yahoo's UNADJUSTED closes, so dividends
are missing from every series. Trailing "total return" here is really
price return, which systematically under-ranks the high-yield sectors
(XLU, XLP, XLRE, TLT — 2.5-4%/yr each) against the low-yield ones (XLK,
SMH, QQQ — under 1%). The direction of that bias is toward growth
sectors, which happen to be what won this sample; a dividend-adjusted
rerun would rank differently and could plausibly do somewhat worse. The
benchmarks are computed on the same unadjusted data, so the COMPARISON is
apples to apples, but the absolute CAGRs above understate every line by
roughly 1.5-2%/yr.

EXECUTION, measured and chosen for a reason. Two ways to place the monthly
rebalance were replayed over the same ten years:

    market-on-close, whole shares      walk-forward Sharpe 0.55, p 0.13, not significant
    market DAY order at the close,     walk-forward Sharpe 0.63, p 0.087, validated
    fractional shares, crossing        CAGR 9.5% at $100, 9.8% at $5,000

The auction is the cheaper fill but forbids fractional shares, and at
small size whole shares of $100-$700 ETFs leave the book holding one or
two names — the ranking has nothing to choose between. Crossing the
spread costs about 4bps a fill, and with roughly ten rebalances a year
that is under half a percent annually: cheaper than losing the
diversification. So this desk crosses, fractionally, and its capital
floor is $100 rather than $2,000.

WHY IT IS DECLARED MARGINAL rather than validated. The p 0.087 above is a
four-fold walk-forward. The standing validation run uses five folds, and
there the same desk with the same fixed parameters reads:

    walk-forward, 5 folds, $100       Sharpe 0.50, CAGR 8.5%, p 0.155
    walk-forward, 5 folds, $2,000     Sharpe 0.52, CAGR 8.8%, p 0.144
    equal-weight buy-and-hold          Sharpe 0.75, CAGR 11.1%
    of the same 17 ETFs

A record that validates at one fold count and fails at the next is a
record whose significance is being decided by the fold boundaries, not
by the strategy. And on the run that matters — the one the dashboard
publishes — the rotation earns a WORSE risk-adjusted return than simply
holding its own universe equal-weighted, with the same drawdown. The
literature says this effect is real; ten years of seventeen ETFs on
unadjusted prices cannot confirm it. So the desk ships, is replayed
every Monday, and is funded only when the operator names it explicitly.
If a later five-fold run clears the statistic's significance bar (p at
or under 0.10) AND beats the equal-weight hold of its own universe on
Sharpe, the status changes; it does not change on a good year.
"""
import datetime as dt
import statistics as st

from .base import CLOSE, Decision, Desk, DeskMeta, View, register


@register
class CrossSectionalMomentum(Desk):
    meta = DeskMeta(
        name="xsect",
        title="Cross-sectional momentum (sector/asset ETFs)",
        asset_class="equity",
        venue="alpaca",
        interval="1d",
        periods_per_year=252,
        events=(CLOSE,),
        # Deliberately spans risk factors, not just US sectors. The nine
        # SPDR sectors plus real estate cover the equity cross-section;
        # SMH/QQQ/IWM add size and industry tilts; GLD/TLT/EFA/EEM are the
        # legs that let the trend filter rotate somewhere other than cash
        # when US equities roll over, which is the whole point of running a
        # cross-section instead of a single-asset trend follower.
        universe=("XLK", "XLF", "XLE", "XLV", "XLI", "XLP", "XLU", "XLB",
                  "XLY", "XLRE", "SMH", "GLD", "TLT", "EFA", "EEM", "IWM",
                  "QQQ"),
        # Needs the full ranking window (lookback + skip), the trend window,
        # and a month of slack so the first rebalance is not made from a
        # half-formed history.
        warmup_bars=300,
        # The binding constraint is the $0.03/day regulatory floor against
        # ~12 trading days a year, which is $0.36/yr. At $100 that is 0.36%
        # — tolerable, unlike a daily desk. Below $100 the per-name position
        # falls under Alpaca's $1 fractional minimum and slots start
        # silently dropping, so that is the floor.
        capital_floor=100.0,
        pdt_day_trades=False,      # holds for a month; never a day trade
        shortable=False,
        fractional=True,
        # Month-start rebalances go in as fractional market DAY orders that
        # cross the spread (~4bps a side on XLRE/EEM, under 0.5%/yr at ten
        # rebalances). The auction would be cheaper but forbids fractional
        # shares, which at small size costs the diversification the desk is
        # built on. Measured both ways in the docstring.
        execution_style="crossing",
        # The five-fold walk-forward the dashboard publishes is not
        # significant (p 0.144) and sits below the equal-weight buy-and-hold
        # of the same names on Sharpe. See the docstring for the numbers.
        status="marginal",
        status_reason=("five-fold walk-forward Sharpe 0.50 at $100 (0.52 at "
                       "$2,000), p 0.14-0.16, below the equal-weight buy-and-hold "
                       "of its own universe (0.75); a four-fold run validates at "
                       "p 0.087, so the record is decided by fold boundaries "
                       "rather than by the desk"),
        description="Ranks a sector/asset-class ETF universe on trailing "
                    "return skipping the last month, holds the top K "
                    "equal-weighted, and swaps any name below its own "
                    "long-run trend for cash. Rebalances monthly. MARGINAL: "
                    "not significant on the five-fold walk-forward and below "
                    "its own equal-weight benchmark.",
    )

    @classmethod
    def defaults(cls):
        return {
            "lookback": 126,     # ~6 months of the ranking window
            "skip": 21,          # ~1 month, excluded: short-horizon reversal
            "top_k": 4,          # of 17 — concentrated enough to matter
            "trend": 200,        # ~10 months; the absolute-momentum gate
            "weighting": "equal",   # "equal" | "invvol"
            "vol_window": 63,    # only read when weighting == "invvol"
        }

    @classmethod
    def param_grid(cls):
        # Four points, not four hundred. Every point is a trial the deflated
        # Sharpe has to discount, and the two questions worth asking here are
        # "6 or 12 month formation?" and "3 or 5 names?" — both of which the
        # literature already answers, so this is a robustness check rather
        # than a search.
        return {
            "lookback": [126, 252],
            "top_k": [3, 5],
        }

    # ---------------------------------------------------------- calendar
    @staticmethod
    def _month(ts):
        d = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
        return (d.year, d.month)

    @classmethod
    def _last_rebalance_index(cls, bars):
        """Index of the first bar of the current calendar month.

        Rebalancing on the FIRST session of a new month rather than the last
        session of the old one is a lookahead decision, not a stylistic one:
        "the last trading day of the month" cannot be identified until the
        next bar exists. Being one session late costs a little and is honest;
        being on time requires knowing the future.
        """
        for j in range(len(bars) - 1, 0, -1):
            if cls._month(bars[j].t) != cls._month(bars[j - 1].t):
                return j
        return None

    # ------------------------------------------------------------ signal
    def _rank_at(self, view, j):
        """Target weights decided at bar index `j`, using bars[:j+1] only."""
        look = int(self.params["lookback"])
        skip = int(self.params["skip"])
        trend = int(self.params["trend"])
        k = int(self.params["top_k"])
        need = max(look + skip, trend) + 1

        scored = []
        for sym in view.symbols():
            c = view.closes(sym)[: j + 1]
            if len(c) < need:
                continue
            end = len(c) - 1 - skip           # last bar INSIDE the window
            beg = end - look
            if beg < 0 or c[beg] <= 0:
                continue
            mom = c[end] / c[beg] - 1
            # Absolute momentum: is the name above its own long-run trend
            # RIGHT NOW (no skip here — for the gate we want the freshest
            # read, since its job is to get us out fast).
            ma = sum(c[-trend:]) / trend
            in_trend = c[-1] > ma
            scored.append((mom, sym, in_trend, c))

        if not scored:
            return {}, {}, "no symbol has enough history"

        scored.sort(key=lambda r: -r[0])
        picks = scored[:k]

        # Names that win the horse race but are below their own trend forfeit
        # the slot to CASH rather than passing it down the ranking. Filling
        # the slot with the next name would defeat the filter: in a broad
        # bear market the next name is also falling.
        held = [p for p in picks if p[2]]
        if not held:
            return {}, {}, "top %d all below trend -> flat" % k

        if self.params.get("weighting") == "invvol":
            vw = int(self.params["vol_window"])
            raw = {}
            for mom, sym, _, c in held:
                w = c[-(vw + 1):]
                rets = [w[i + 1] / w[i] - 1 for i in range(len(w) - 1) if w[i] > 0]
                sd = st.pstdev(rets) if len(rets) > 2 else 0.0
                raw[sym] = (1.0 / sd) if sd > 0 else 0.0
            tot = sum(raw.values())
            # Gross stays 1/K per SLOT so that forfeited slots really are
            # cash; inverse-vol only redistributes WITHIN the held names.
            budget = len(held) / float(k)
            weights = ({s: budget * v / tot for s, v in raw.items()}
                       if tot > 0 else {s: budget / len(held) for s in raw})
        else:
            weights = {sym: 1.0 / k for _, sym, _, _ in held}

        prices = {sym: c[j] for _, sym, _, c in held}
        note = "top%d: " % k + ", ".join(
            "%s %+.1f%%%s" % (s, m * 100, "" if t else " [below trend -> cash]")
            for m, s, t, _ in picks)
        return weights, prices, note

    # ------------------------------------------------------------- drift
    @staticmethod
    def _drifted(w0, p0, pnow):
        """The weights a book set to `w0` at prices `p0` now carries.

        This is what makes "hold until next month" cost nothing. The engine
        sizes shares as equity x weight / price every bar, so asking for
        constant weights daily is asking it to sell winners and buy losers
        every session — 250 trading days of the $0.03 fee floor for a
        strategy that is supposed to touch the market twelve times a year.
        Returning the drifted weights instead reproduces the shares already
        held, and the engine's difference is zero.
        """
        gross = sum(w0.values())
        growth = 1.0 - gross                      # the cash sleeve, unchanged
        parts = {}
        for s, w in w0.items():
            a, b = pnow.get(s), p0.get(s)
            if not a or not b or b <= 0:
                return dict(w0)                   # missing mark: don't guess
            parts[s] = w * a / b
            growth += parts[s]
        if growth <= 0:
            return dict(w0)
        return {s: v / growth for s, v in parts.items()}

    # ------------------------------------------------------------ decide
    def decide(self, view: View) -> Decision:
        syms = view.symbols()
        if not syms:
            return Decision({}, note="empty universe")
        bars = view.bars(syms[0])
        j = self._last_rebalance_index(bars)
        if j is None:
            return Decision({}, note="no month boundary in history yet")

        w0, p0, note = self._rank_at(view, j)
        if not w0:
            return Decision({}, note=note)

        # Rebalance day: trade to w0. Every other day: restate the same book
        # at today's prices so the engine has nothing to do.
        if j == len(bars) - 1:
            return Decision(w0, note="REBALANCE " + note)
        pnow = {s: view.last_close(s) for s in w0}
        return Decision(self._drifted(w0, p0, pnow), note="hold " + note)
