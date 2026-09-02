#!/usr/bin/env python3
"""Short-horizon reversal in broad US ETFs — validated, and MARGINAL.

After a sharp multi-day decline a broad index ETF has, historically, earned
above-average returns over the next few sessions. Three constructions of
"sharp decline" were tested so the result is about the effect and not one
formula, all on twelve liquid ETFs, daily bars 2016-2026, every cost
charged, fixed parameters, walk-forward scored only on untouched windows:

    variant               in-sample Sharpe   walk-forward        first half   second half
    rsi2 (RSI(2) < 10)         0.49-0.56     0.53-0.59  not sig.  0.18-0.19    0.89-1.12
    down (3 down closes)       0.77-0.83     0.87-0.89  VALIDATED 0.34-0.41    1.17-1.28
    band (2 sd below MA20)     0.33-0.43     0.30-0.38  not sig.  0.25-0.34    0.38-0.50

Only the consecutive-down-close variant survives, and it survives with a
caveat that decides how this desk is shipped. Split the decade in half and
the effect is NOT significant in 2016-2021 (Sharpe 0.41) and strong in
2021-2026 (Sharpe 1.28). The published literature says index reversal
weakened after 2010; this sample says the opposite. Either the effect has
regime dependence that ten years cannot resolve, or the recent period is
the anomaly. A desk cannot tell which, so it is marked MARGINAL: registered,
replayable, excluded from every preset, and only run by an operator who has
read this and chosen to.

EXECUTION. The down/h5 variant round-trips about 119 times a year, which
puts it in the daily-fee-floor class. Both executions were measured:

    market-on-close, whole shares    walk-forward Sharpe 0.75  $250: 3.7%  $1,000: 9.3%
    market DAY at close, fractional  walk-forward Sharpe 0.75  $250: 8.0%  $1,000: 8.9%

Same risk-adjusted record; crossing wins at small size because fractional
shares keep all three slots filled. The desk crosses. Its capital floor is
$500, where the fee floor is under 1% a year. Against buy-and-hold SPY
(Sharpe 0.79, CAGR 13.4%) it earns less absolute return with a modestly
better Sharpe and a shallower drawdown (-25% vs -34%).
"""
import statistics as st

from .base import CLOSE, Decision, Desk, DeskMeta, View, register


@register
class ShortTermReversal(Desk):
    meta = DeskMeta(
        name="reversion",
        title="Short-term reversal (broad US ETFs)",
        asset_class="equity",
        venue="alpaca",
        interval="1d",
        periods_per_year=252,
        events=(CLOSE,),
        universe=("SPY", "QQQ", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI",
                  "XLP", "XLU", "XLY", "XLB"),
        warmup_bars=80,
        capital_floor=500.0,
        pdt_day_trades=False,
        shortable=False,
        fractional=True,
        execution_style="crossing",   # measured: same Sharpe, keeps small books diversified
        status="marginal",
        status_reason=("validated on the full walk-forward (Sharpe 0.75) but not significant in 2016-21 and strong only in 2021-26 — the reverse of the published pattern; ten years cannot say which half is the anomaly"),
        description="Buys broad ETFs after three consecutive down closes and "
                    "exits on a close above the 5-day average or after five "
                    "sessions. Holds at most max_names, oldest signal first; "
                    "when the book is full a newer signal waits for a slot and "
                    "enters late, with its hold clock still running from the "
                    "signal day. MARGINAL: validated on the full walk-forward "
                    "but only significant in the recent half of the sample.",
    )

    @classmethod
    def defaults(cls):
        return {
            "variant": "down",     # the only variant that survived walk-forward
            "rsi_period": 2,
            "rsi_entry": 10.0,
            "down_days": 3,
            "band_ma": 20,
            "band_k": 2.0,
            "exit_ma": 5,
            "max_hold": 5,          # measured: h5 beat h3 on every view
            "max_names": 3,
            "max_gross": 1.0,
        }

    @classmethod
    def param_grid(cls):
        return {
            "variant": ["rsi2", "down", "band"],
            "max_hold": [3, 5],
        }

    # ------------------------------------------------------------- signal
    @staticmethod
    def _rsi_series(c, n, window):
        """Wilder RSI over the last `window` bars, returned tail-aligned.

        Wilder's smoothing is an EMA with alpha = 1/n, so with n=2 the
        weight on a bar 40 sessions back is 2**-40. Seeding from a bounded
        window rather than the whole history is therefore exact to floating
        point and keeps `decide` O(window) instead of O(len(history)) — the
        difference between a replay that runs in seconds and one that runs
        in minutes.
        """
        c = c[-(window + n + 1):]
        if len(c) < n + 2:
            return []
        gains = [max(0.0, c[i] - c[i - 1]) for i in range(1, len(c))]
        losses = [max(0.0, c[i - 1] - c[i]) for i in range(1, len(c))]
        ag = sum(gains[:n]) / n
        al = sum(losses[:n]) / n
        out = [100.0 if al == 0 else 100 - 100 / (1 + ag / al)]
        for i in range(n, len(gains)):
            ag = (ag * (n - 1) + gains[i]) / n
            al = (al * (n - 1) + losses[i]) / n
            out.append(100.0 if al == 0 else 100 - 100 / (1 + ag / al))
        return out                       # out[-1] corresponds to c[-1]

    def _oversold(self, c, k):
        """(is_entry, strength) at index k of closes `c`. Lower = more oversold.

        Three signals from the same family, all answering "has this name
        just fallen hard relative to its own recent behaviour?". They are
        deliberately different in construction — a smoothed momentum
        oscillator, a pure count of down closes, a distance in standard
        deviations — so that agreement between them is evidence about the
        effect rather than about one formula.
        """
        v = self.params["variant"]
        if v == "rsi2":
            n = int(self.params["rsi_period"])
            r = self._rsi_series(c[: k + 1], n, 48)
            if not r:
                return False, 0.0
            return r[-1] < float(self.params["rsi_entry"]), r[-1]
        if v == "down":
            need = int(self.params["down_days"])
            if k < need:
                return False, 0.0
            run = 0
            j = k
            while j > 0 and c[j] < c[j - 1]:
                run += 1
                j -= 1
            # strength: more consecutive down closes ranks first
            return run >= need, -float(run)
        if v == "band":
            n = int(self.params["band_ma"])
            if k + 1 < n:
                return False, 0.0
            w = c[k - n + 1: k + 1]
            mu = sum(w) / n
            sd = st.pstdev(w)
            if sd <= 0:
                return False, 0.0
            z = (c[k] - mu) / sd
            return z < -float(self.params["band_k"]), z
        return False, 0.0

    def _reverted(self, c, k):
        """Exit test at index k: price has closed back above its short MA."""
        n = int(self.params["exit_ma"])
        if k + 1 < n:
            return False
        return c[k] > sum(c[k - n + 1: k + 1]) / n

    def _open_since(self, c):
        """Index at which the currently-open position was entered, or None.

        `decide` is pure — it cannot remember yesterday — so the position
        state is RECONSTRUCTED from the bars every call. The reconstruction
        is exact and needs only `max_hold` bars of lookback because a
        position cannot outlive that: find the most recent entry inside the
        window, and if any bar after it triggered the exit, we are flat.
        A newer entry supersedes an older one, so scanning backwards and
        stopping at the first hit is the whole rule.
        """
        hold = int(self.params["max_hold"])
        i = len(c) - 1
        for j in range(i, max(-1, i - hold), -1):
            hit, strength = self._oversold(c, j)
            if not hit or self._reverted(c, j):
                continue
            for k in range(j + 1, i + 1):
                if self._reverted(c, k):
                    return None, 0.0     # position already closed out
            return j, strength
        return None, 0.0

    # ------------------------------------------------------------- decide
    def decide(self, view: View) -> Decision:
        held = []
        for sym in view.symbols():
            c = view.closes(sym)
            if len(c) < 60:
                continue
            j, strength = self._open_since(c)
            if j is not None:
                held.append((j, strength, sym))

        if not held:
            return Decision({}, note="nothing oversold")

        # Oldest position first, most oversold first among same-day entries.
        # Ordering by entry age rather than by today's signal strength is
        # what keeps an existing holding from being displaced by a fresher
        # name. Note what this implies when more than max_names are
        # oversold at once: the youngest signals are NOT held, and if a slot
        # frees before they revert they enter late, with the hold clock
        # still counted from their signal day (so a shorter hold). That is
        # the rule the replay measured and the rule the live loop runs; it
        # is stated here so nobody reads the entry rule as "every signal".
        # A desk that re-ranks every session is a daily-turnover desk,
        # and the $0.03/day fee floor is what it would be paying for.
        held.sort(key=lambda r: (r[0], r[1], r[2]))
        k = int(self.params["max_names"])
        picks = held[:k]
        w = float(self.params["max_gross"]) / k
        weights = {sym: w for _, _, sym in picks}
        note = "long %d oversold: " % len(picks) + ", ".join(
            "%s(%+.1f, %dd)" % (s, sg, len(view.closes(s)) - 1 - j)
            for j, sg, s in picks)
        return Decision(weights, note=note)
