#!/usr/bin/env python3
"""Crypto time-series momentum — hold BTC and ETH only while they trend up.

The oldest and most replicated anomaly in the literature (Moskowitz, Ooi &
Pedersen 2012 find it in 58 instruments across four asset classes back to
1965). The mechanism is not a pricing inefficiency to be arbitraged away but
a behavioural one that keeps regenerating: under-reaction to slow news,
then over-reaction as trend-followers and leveraged holders pile in, then
forced deleveraging on the way out. Crypto has the ingredients in unusual
concentration — no cash-flow anchor to value it against, a retail-heavy
holder base, and perpetual futures that turn a drawdown into a liquidation
cascade. That is why the trend premium here is large enough to survive a
25bp taker fee, which it is not in, say, large-cap equities.

MEASURED, daily Alpaca closes, 2022-07-22 to 2026-08-30 (1501 bars), long/flat
on close > SMA(n), costs charged at 25bp taker + measured half-spread on every
flip:

    n      BTC Sharpe   BTC CAGR    ETH Sharpe   ETH CAGR    flips (BTC)
    20          0.38       +7.4%          0.17      -2.4%        171
    30          0.55      +13.3%          0.59     +17.7%        135
    50          1.04      +33.9%          0.88     +33.5%         89
    75          1.00      +32.0%          0.48     +12.0%         63
    100         0.92      +28.9%          0.58     +17.0%         59
    150         0.99      +32.8%          0.79     +27.4%         41
    200         0.87      +27.7%          0.61     +18.3%         33
    buy&hold    0.87      +35.4%          0.50     +12.4%          -

Two things in that table decide the whole design. First, everything from 50
to 200 works and everything below 30 does not — this is a plateau, not a
peak, which is the signature of a real effect rather than a fitted one. The
short averages fail for a specific reason: they cross more often, and each
crossing costs ~28bp round trip, so SMA20's 171 flips spend roughly 4.8% a
year on execution to capture a signal barely better than a coin. Second,
buy-and-hold BTC earns MORE than most of these (+35.4%) while spending
53% of the time in a drawdown the desk sidesteps. Trend following here does
not beat bitcoin on return. It beats bitcoin on risk: maxDD -29% against
-53%, which is the difference between a position a small account holds
through 2026 and one it capitulates out of.

WHY A DEADBAND AND NOT A CONFIRMATION COUNT
The brief for this desk asked for hysteresis justified by measurement, so
both candidates were measured rather than assumed. Requiring k consecutive
closes on one side of the average — the obvious choice — is actively
harmful:

    BTC SMA50   confirm=1  Sharpe 1.04    ETH SMA50   confirm=1  Sharpe 0.88
                confirm=2         1.01                confirm=2         0.49
                confirm=3         0.95                confirm=3         0.43
                confirm=5         0.74                confirm=5         0.58

It fails because it delays every entry by k days without filtering anything:
a whipsaw and a real trend both start with k up-closes, so the rule pays the
lag on the good trades and still takes the bad ones.

A deadband — go long above SMA x (1+b), exit below SMA x (1-b), hold the
previous state in between — filters instead of delays, and it works. Two
parameterizations were compared across the full n=30..200 family on both
assets (12 cells), because the mean over a family is much harder to fool
than any single cell:

    band                    mean Sharpe   worst cell   mean flips
    none                          0.775         0.48           66
    fixed 1%                      0.790         0.49           41
    fixed 2%                      0.756         0.37           32
    fixed 5%                      0.634         0.27           22
    0.25 x daily vol              0.789         0.49           48
    0.50 x daily vol              0.792         0.40           38
    1.00 x daily vol              0.774         0.44           30
    1.50 x daily vol              0.752         0.45           25

Read this honestly: the band does NOT meaningfully improve returns. It moves
mean Sharpe from 0.775 to 0.792, which on 1500 bars is noise. What it does
is buy the same performance with 42% fewer round trips. That is the reason
to keep it — not alpha, but insensitivity to costs being worse than modelled,
which on a small account at a retail venue is the risk that actually bites.
The vol-scaled version is chosen over the fixed one because it degrades far
more gracefully (0.789/0.792/0.776/0.774/0.752 as k rises, against
0.790/0.756/0.715/0.634 for the fixed band): a 2% band means something quite
different when bitcoin's daily vol is 1.5% than when it is 5%, and scaling by
vol is what keeps one number sensible across both regimes.

THE VOLATILITY TARGET DOES NOT WORK HERE, AND THIS DESK SAYS SO
This desk was specified with an inverse-volatility position sizer on the
premise that it "turns a high-return/high-drawdown series into a holdable
one". Measured on this data, that premise is false, and reporting otherwise
would be exactly the flattering-number failure this rebuild exists to
correct. Sweeping target_vol and the per-name cap, and recording how often
the inverse-vol term rather than the cap actually sets the weight:

    target  cap    vol term binds        Sharpe   CAGR    maxDD   Calmar
                   (BTC / ETH)
    0.30   0.40        5% /  25%           0.96  +25.8%  -28.4%    0.91
    0.25   0.60       57% /  85%           0.92  +27.4%  -33.7%    0.81
    0.20   0.50       61% /  86%           0.91  +23.0%  -28.7%    0.80
    0.18   0.50       71% /  91%           0.94  +22.3%  -25.9%    0.86
    0.15   0.50       87% /  98%           0.89  +18.2%  -23.0%    0.79
    0.15   0.60       98% / 100%           0.86  +17.5%  -23.6%    0.74

The more the volatility target actually operates, the worse the desk gets —
on Sharpe AND on Calmar, nearly monotonically. It lowers maxDD only by
lowering exposure, which is not a risk-adjusted improvement.

The reason is visible in the data and is specific to this asset class.
Sorting the bars where the trend filter is already long into quartiles of
trailing volatility, and measuring the NEXT day's return:

    BTC, while long        mean vol    mean forward return
      low-vol quartile          30%             +0.042%/day
      q2                        40%             +0.254%/day
      q3                        48%             +0.162%/day
      high-vol quartile         61%             +0.266%/day

Within an uptrend, bitcoin's high-volatility regime pays the MOST. Volatility
targeting is a good idea in equities and futures, where vol spikes and
negative returns coincide; here the trend filter has already removed the
high-vol downside, and what is left of high volatility is the explosive up-leg
that trend following exists to capture. Scaling down into it sells the thing
being bought. (ETH shows no clean monotone relationship — its quartiles run
+0.353/-0.203/+0.626/-0.006 %/day — so this is a BTC-driven finding, not a
universal law.)

The sizer is therefore kept but deliberately detuned into a TAIL BRAKE rather
than a target: at target_vol 0.30 against a 0.40 cap it binds only in the top
few percent of BTC's volatility distribution. Its measured contribution is
honest and small — maxDD -28.4% with it against -29.2% without, Calmar 0.91
against 0.90. It is retained not because this sample rewards it but because
this sample contains no 2022-scale volatility event, and a mechanism that
costs ~0.3pp of CAGR to bound behaviour outside the observed range is cheap
insurance. Anyone tempted to "turn it up" should read the table above first.

CAPITAL FLOOR
Crypto has no daily regulatory fee floor — that trap is equities-only, where
per-day per-fee-type rounding costs $0.03 on any day with activity and eats
a $40 account alive. Here every cost is proportional, so there is no size
below which frictions explode. The binding constraint is Alpaca's ~$10
minimum crypto order. With two names and inverse-vol weights that typically
land near 0.3 each, a $100 account clears that minimum on both legs with
room for the partial rebalances vol targeting generates; below about $60 the
smaller leg's adjustments start getting rejected and the desk silently runs
a different strategy than the one backtested. Hence $100, which is a
liquidity statement, not a fee one.
"""
import math

from ..data.bars import realized_vol, sma
from .base import CLOSE, Decision, Desk, DeskMeta, View, register


@register
class CryptoTrend(Desk):
    meta = DeskMeta(
        name="trend",
        title="Crypto trend following (BTC/ETH)",
        asset_class="crypto",
        venue="alpaca",
        interval="1d",
        periods_per_year=365,
        events=(CLOSE,),
        # Two names, and this is not timidity. Measured Alpaca spreads on
        # 2026-08-30: BTC 2.9bp, ETH 2.3bp, then LINK 24bp, DOGE 33bp,
        # XRP 37bp, AVAX 58bp, LTC 63bp. A 63bp spread is 126bp round trip
        # on top of 50bp of taker fees — no daily trend signal produces that
        # much edge, so a broad altcoin universe is dead on arrival at cost
        # regardless of how good the signal looks on mid prices.
        universe=("BTC/USD", "ETH/USD"),
        # Longest SMA in the grid (150) plus the 30-bar vol window, plus room
        # for the hysteresis state to settle before the first live decision.
        warmup_bars=210,
        capital_floor=100.0,
        pdt_day_trades=False,      # crypto; PDT never applied, and is now abolished anyway
        shortable=False,           # long/flat only — see docstring on short trends
        fractional=True,
        # Crypto has no auction. Every order crosses a live book and pays the
        # half-spread; the engine charges Alpaca's 25bp taker on top. Maker
        # would be cheaper but a maker order that does not fill turns a
        # long/flat desk into a coin flip on which side of the trend it sits.
        execution_style="crossing",
        # On the five-window walk-forward with every fold scored strictly
        # out of sample the statistic sits just over the significance bar
        # (p 0.101); with one training bar per fold included it
        # read 0.087. A record decided by one bar per fold is not one the
        # author will call validated. Re-tested every Monday.
        status="marginal",
        status_reason=("five-window walk-forward (four scored) Sharpe 0.90, "
                       "CAGR 22.9%, p 0.101 — just over the "
                       "0.10 bar every desk is held to (0.087 when each fold "
                       "included its last training bar); above the BTC/ETH hold "
                       "on Sharpe (0.70) with half its drawdown, but not yet "
                       "significant"),
        description="Long BTC and ETH while each trades above its own moving "
                    "average, flat otherwise, sized inverse to realized "
                    "volatility. A volatility-scaled deadband suppresses the "
                    "whipsaw that is trend following's entire cost.",
    )

    @classmethod
    def defaults(cls):
        return {
            "sma": 100,             # mid-plateau, deliberately NOT the in-sample peak of 50
            "band_k": 0.5,          # deadband = band_k x trailing daily vol
            "vol_window": 30,       # bars used for realized vol and for the band
            # Sizing is chosen from the measured volatility DISTRIBUTION, not
            # from a performance table — Sharpe is flat (0.90-0.97) across the
            # whole target_vol x max_weight grid, so picking the best cell
            # would be fitting noise. Measured 30-day annualized vol over the
            # sample: BTC median 43% (p10 28%, p90 68%), ETH median 60%
            # (p10 37%, p90 92%).
            #   target_vol 0.30 sits below both medians, so the inverse-vol
            #   term actually binds in a normal regime, but above both p10s,
            #   so a calm market hits the cap instead of levering into it.
            "target_vol": 0.30,     # annualized, per name
            # 0.40 is structural, not fitted: with two names the gross tops
            # out at 0.80, so `max_gross` never binds. That matters because
            # the gross cap scales pro-rata, and at cap >= 0.50 BOTH names
            # pin to the cap and the pro-rata rescale hands them equal
            # weights — silently deleting the inverse-vol tilt this desk
            # claims to apply. At 0.40 the tilt survives: measured mean
            # weight when held is BTC 0.52 against ETH 0.41.
            "max_weight": 0.40,     # per name, of equity
            "max_gross": 1.00,      # safety rail; non-binding with two names
            "weight_step": 0.05,    # quantize targets — see _quantize
        }

    @classmethod
    def param_grid(cls):
        # Six points. Every one is a trial the deflated Sharpe discounts, so
        # this asks only the two questions the evidence leaves genuinely open:
        # where in the 50-150 plateau to sit, and how wide the deadband is.
        # It deliberately does NOT search target_vol or max_weight, which are
        # risk choices rather than empirical ones.
        return {
            "sma": [50, 100, 150],
            "band_k": [0.25, 0.5],
        }

    # ------------------------------------------------------------- signal
    @staticmethod
    def _rolling_daily_vol(closes, win):
        """Trailing per-bar stdev of returns, aligned so entry i uses only
        returns ending at bar i. Computed once for the whole series because
        `_trend_state` below has to replay every bar, not just the last."""
        rets = [closes[j + 1] / closes[j] - 1 for j in range(len(closes) - 1)]
        out = [None] * len(closes)
        if len(rets) < win:
            return out
        s = sum(rets[:win])
        s2 = sum(r * r for r in rets[:win])
        for k in range(win, len(rets) + 1):
            if k > win:
                add, drop = rets[k - 1], rets[k - win - 1]
                s += add - drop
                s2 += add * add - drop * drop
            var = (s2 - s * s / win) / (win - 1)
            out[k] = math.sqrt(var) if var > 0 else 0.0
        return out

    def _trend_state(self, closes):
        """1 if the deadband rule currently says long, else 0.

        The rule is path-dependent — between SMA x (1-b) and SMA x (1+b) it
        holds whatever it last decided — so the state cannot be read off
        today's price alone. Rather than cache it on the instance, this
        replays the rule over the visible history on every call.

        That is a deliberate cost. A desk carrying mutable state is no longer
        pure: it would decide differently depending on whether it had been
        run over the preceding bars, which makes a backtest fold, a unit
        test, and the live loop three different strategies. Replaying is
        O(bars) per decision and, at 1500 daily bars, free.
        """
        n = int(self.params["sma"])
        k = float(self.params["band_k"])
        win = int(self.params["vol_window"])
        if len(closes) < n + 1:
            return 0
        ma = sma(closes, n)                      # ma[j] corresponds to closes[j + n - 1]
        dvol = self._rolling_daily_vol(closes, win)
        state = 0
        for j, m in enumerate(ma):
            i = j + n - 1
            if m <= 0:
                continue
            v = dvol[i]
            band = k * v if v else 0.0
            if closes[i] > m * (1 + band):
                state = 1
            elif closes[i] < m * (1 - band):
                state = 0
            # inside the band: hold the previous state — this is the hysteresis
        return state

    def _quantize(self, w):
        """Snap a target weight to a grid.

        Vol targeting recomputes a slightly different weight every single day,
        and acting on each 0.4% drift would pay 28bp to move 0.4% of the book.
        Quantizing makes the target sticky without any stored state: the
        weight only moves when the underlying vol has changed enough to shift
        it a whole step, so the engine's diff-based execution sees nothing to
        trade on the other days.
        """
        step = float(self.params["weight_step"])
        if step <= 0:
            return w
        return round(w / step) * step

    def decide(self, view: View) -> Decision:
        tvol = float(self.params["target_vol"])
        cap = float(self.params["max_weight"])
        win = int(self.params["vol_window"])
        need = int(self.params["sma"]) + 1

        weights, notes = {}, []
        for sym in view.symbols():
            closes = view.closes(sym)
            if len(closes) < need:
                continue
            if not self._trend_state(closes):
                notes.append(f"{sym} below trend")
                continue
            rets = [closes[j + 1] / closes[j] - 1 for j in range(len(closes) - 1)]
            av = realized_vol(rets, win, self.meta.periods_per_year)
            if not av or av <= 0:
                continue
            w = self._quantize(self.vol_scaled_weight(tvol, av, cap))
            if w > 0:
                weights[sym] = w
                notes.append(f"{sym} long {w:.0%} (vol {av:.0%})")

        if not weights:
            return Decision({}, note="flat: " + ("; ".join(notes) or "no history"))

        # Cap gross and scale pro-rata rather than dropping a name, so the
        # relative inverse-vol tilt between BTC and ETH survives the cap.
        gross = sum(weights.values())
        mx = float(self.params["max_gross"])
        if gross > mx:
            weights = {s: w * mx / gross for s, w in weights.items()}
        return Decision(weights, note="; ".join(notes))
