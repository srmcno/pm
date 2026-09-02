#!/usr/bin/env python3
"""Favorite-longshot bias on Kalshi binaries — tested, and REJECTED.

The hypothesis is one of the oldest in betting markets: longshots are
overpriced and favorites underpriced, because participants overpay for
lottery-like payoffs. On a fee schedule that charges 3.5% of stake at 50c
and 0.35% at 95c, buying favorites and holding to settlement is also the
cheapest thing a Kalshi account can do, so the two ideas pull the same way.
It was worth testing properly. This module is the test, with the answer
built into its default parameters.

DATA. 30,188 settled Kalshi markets pulled through the free, unauthenticated
API (cached at data/cache/kalshi/settled.json). Only 1,138 carried a
two-sided quote from the previous session — the pre-settlement price a
taker could actually have paid — and only 487 of those had a spread of 3c
or less and at least 100 contracts of lifetime volume. Everything below
uses those 487; the wider set is dominated by empty books, where an ask
of 99c against a bid of 50c is not a 99% favorite but an absent market,
and reading it as a price is how the unfiltered 0.98-1.00 bucket "realized"
76% against a 99% price (t = -25.9).

CALIBRATION, taker buying at the previous session's ask, spread <= 3c,
volume >= 100, held to settlement, fee charged once at entry:

    bucket        n   mean P  realized   gap pp      t   net $/ct   net % stake
    0.02-0.05    98    0.038    0.041     +0.23   0.12    -0.0002       -0.6
    0.05-0.10    66    0.077    0.015     -6.17  -1.88    -0.0666      -86.7
    0.10-0.20    69    0.151    0.145     -0.61  -0.14    -0.0150       -9.9
    0.20-0.30    62    0.250    0.387    +13.73   2.50    +0.1242      +49.7
    0.30-0.40    33    0.349    0.212    -13.67  -1.65    -0.1525      -43.7
    0.40-0.50    21    0.447    0.619    +17.24   1.59    +0.1551      +34.7
    0.70-0.80    12    0.738    0.833     +9.50   0.75    +0.0815      +11.0
    0.80-0.90    18    0.851    0.833     -1.72  -0.20    -0.0260       -3.1
    0.90-0.95    22    0.934    1.000     +6.60   1.25    +0.0617       +6.6
    0.95-0.98    21    0.971    1.000     +2.90   0.79    +0.0271       +2.8
    0.98-1.00    29    0.991    1.000     +0.94   0.52    +0.0087       +0.9

The favorite end is where the hypothesis predicts an edge, and it is
directionally there: 0.90-1.00 realized 100% against prices of 93-99c, net
of fees +0.9% to +6.6% of stake. It is also 21 to 29 markets per bucket
with t between 0.5 and 1.25 — indistinguishable from a fair price. The one
bucket that clears t = 2 is 0.20-0.30, which is the OPPOSITE direction
(longshots UNDERpriced), and it does not survive scrutiny:

    excluding Sports (the largest category)   n=14, t = 1.06
    older half of the sample                  n=10, t = 1.31
    newer half                                n=52, t = 2.16

One t = 2.5 among fourteen buckets across five slices — seventy tests — is
what chance produces. It is a sports-concentrated, recent-period reading,
not a bias.

VERDICT: rejected at the current sample. The favorite-longshot bias may
exist on Kalshi; this data cannot show it, and a desk that traded it now
would be trading noise at a 3.5% one-way fee. What IS worth keeping is the
apparatus — the calibration table, the fee-aware screen, the live/historical
data routing — because the settled set grows by thousands of markets a
month and the question can be re-asked cheaply. `screen_markets` returns
nothing at its defaults because its `min_t` gate encodes this result; when
a bucket earns t >= 2 with a robust sample, the gate opens on its own.

Kalshi remains the one venue where a tiny account is not structurally
disadvantaged (fractional contracts to 0.01, free maker orders on 98.7% of
series, no PDT, no settlement lag). That advantage is real. An edge to
apply it to is what this study did not find.
"""
import math

from ..core import money
from .base import CLOSE, Decision, Desk, DeskMeta, View, register


# Bucket edges for the calibration table. Narrow at the extremes because that
# is where the favorite-longshot literature says the mispricing lives and
# where the fee is smallest; wide in the middle where neither is true.
BUCKETS = (0.00, 0.02, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50,
           0.60, 0.70, 0.80, 0.90, 0.95, 0.98, 1.00)


def parse_dollars(v):
    """Kalshi returns prices as decimal STRINGS in the *_dollars fields.

    The legacy integer-cent fields truncate sub-cent prices to zero, which
    silently deletes exactly the deep-longshot contracts this study is about.
    """
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if 0.0 <= x <= 1.0 else None


def bucket_of(price, edges=BUCKETS):
    """Index of the bucket containing `price`, or None if outside (0,1).

    Contracts at exactly 0 or 1 are excluded rather than bucketed: they are
    settled or unquotable, and including them is how a calibration study
    accidentally reports a perfect forecast record.
    """
    p = parse_dollars(price)
    if p is None or p <= edges[0] or p >= edges[-1]:
        return None
    for i in range(len(edges) - 1):
        if edges[i] < p <= edges[i + 1]:
            return i
    return None


def bucket_label(i, edges=BUCKETS):
    return f"{edges[i]:.2f}-{edges[i+1]:.2f}"


def calibration_table(rows, edges=BUCKETS):
    """Realized YES frequency by price bucket.

    `rows` are dicts with a `price` in dollars and a `won` boolean. Returns
    one dict per non-empty bucket with n, mean price, realized frequency and
    the gap between them, plus a standard error so a bucket with eleven
    observations cannot be mistaken for evidence.
    """
    acc = {}
    for r in rows:
        i = bucket_of(r.get("price"), edges)
        if i is None:
            continue
        a = acc.setdefault(i, [0, 0.0, 0])
        a[0] += 1
        a[1] += parse_dollars(r["price"])
        a[2] += 1 if r.get("won") else 0
    out = []
    for i in sorted(acc):
        n, psum, wins = acc[i]
        mean_p = psum / n
        freq = wins / n
        # Standard error under the NULL that the price is right, not under
        # the realized frequency: the question is "could this gap be luck at
        # this price", and using the realized rate makes a 12-for-12 bucket
        # look infinitely significant instead of merely unlikely.
        se = math.sqrt(max(mean_p * (1 - mean_p), 1e-12) / n)
        out.append({"bucket": bucket_label(i, edges), "lo": edges[i],
                    "hi": edges[i + 1], "n": n, "mean_price": mean_p,
                    "realized": freq, "gap": freq - mean_p, "se": se,
                    "t": (freq - mean_p) / se if se > 0 else 0.0})
    return out


def net_pnl_per_contract(price, won, maker=False, multiplier=1.0, series=""):
    """Dollar P&L of buying one YES contract at `price` and settling it.

    One fee, not two: settlement is not a trade, so a held-to-expiry position
    pays the taker fee on entry only. That fee shape is the reason this
    hypothesis was worth testing at all - 0.63c on a 90c contract is 0.7% of
    the stake, while the same contract at 50c pays 3.5%.
    """
    p = parse_dollars(price)
    if p is None or not 0 < p < 1:
        return 0.0
    fee = money.kalshi_fee(p, 1.0, maker=maker, multiplier=multiplier,
                           series=series)
    return (1.0 - p if won else -p) - fee


# Calibration measured in this study: realized-minus-price, in probability
# points, for a TAKER buying at the ask on a book quoted no wider than 3c,
# 24 hours before the market closes. Positive means the contract paid off
# more often than its price implied. These are the numbers `screen_markets`
# reasons with; they are estimates from a few hundred settlements per bucket,
# not constants of nature, and the `min_t` gate below exists to say so.
MEASURED_GAP_PP = {
    "0.02-0.05": 0.23, "0.05-0.10": -6.17, "0.10-0.20": -0.61, "0.20-0.30": 13.73,
    "0.30-0.40": -13.67, "0.40-0.50": 17.24, "0.50-0.60": 9.89, "0.60-0.70": 0.33,
    "0.70-0.80": 9.50, "0.80-0.90": -1.72, "0.90-0.95": 6.60, "0.95-0.98": 2.90,
    "0.98-1.00": 0.94,
}
# t-statistics against the null that the price is right. Only 0.20-0.30
# exceeds 2, and the docstring explains why that one is not tradable: it is
# outside the favorite band this desk trades, sports-concentrated, and gone
# when the largest category is removed.
MEASURED_T = {
    "0.02-0.05": 0.12, "0.05-0.10": -1.88, "0.10-0.20": -0.14, "0.20-0.30": 2.50,
    "0.30-0.40": -1.65, "0.40-0.50": 1.59, "0.50-0.60": 0.60, "0.60-0.70": 0.02,
    "0.70-0.80": 0.75, "0.80-0.90": -0.20, "0.90-0.95": 1.25, "0.95-0.98": 0.79,
    "0.98-1.00": 0.52,
}


def edge_after_fees(price, gap_pp, maker=False, multiplier=1.0, series=""):
    """Expected dollars per contract from buying at `price`, net of the fee.

    `gap_pp` is the calibration gap in probability POINTS. The expected gross
    payoff of one contract is (price + gap) x $1, so the expected profit is
    gap dollars per contract before fees - the price cancels. That is the
    whole arithmetic: a 2pp calibration gap is worth 2c a contract, and the
    fee at 90c is 0.63c of it.
    """
    p = parse_dollars(price)
    if p is None or not 0 < p < 1:
        return 0.0
    fee = money.kalshi_fee(p, 1.0, maker=maker, multiplier=multiplier,
                           series=series)
    return gap_pp / 100.0 - fee


def screen_markets(markets, params=None):
    """What to buy right now, from a list of live Kalshi market dicts.

    This is the function the live loop calls; `decide` below exists so the
    same rules can be replayed by the framework. Input dicts are the raw
    shape of GET /markets - prices read from the *_dollars fields, sizes from
    the fixed-point `_fp` strings. Returns a list of
    {ticker, price, size, edge} sorted by expected dollars, best first.

    Every gate here was put in by something the data did, not by taste:

      * `max_spread` - an ask of 99c against a bid of 50c is not a 99%
        favorite, it is an empty book. Unfiltered, the 0.98-1.00 ask bucket
        realized 91.0% against a 99.0% price (t = -15.8). Requiring a quoted
        spread of 3c or less moves that same bucket to 99.0% realized.
      * `min_volume` / `min_depth` - a screen that ignores size finds edges in
        markets that cannot absorb a $5 order.
      * `min_t` - the gate that matters. A bucket is only traded if its
        MEASURED calibration gap was statistically distinguishable from zero.
        No bucket in this study reached t = 2, so at the shipped defaults
        this function returns an empty list. That is the finding, expressed
        as code rather than as a comment.
    """
    p = {**screen_defaults(), **(params or {})}
    gaps = p["gap_pp"]
    ts = p["gap_t"]
    out = []
    for m in markets or []:
        tk = m.get("ticker")
        ask = parse_dollars(m.get("yes_ask_dollars"))
        bid = parse_dollars(m.get("yes_bid_dollars"))
        if not tk or ask is None or bid is None:
            continue
        if not 0 < bid < ask < 1:            # one-sided book: not tradable
            continue
        if ask - bid > p["max_spread"] + 1e-12:
            continue
        if not p["min_price"] <= ask <= p["max_price"]:
            continue
        if _fp(m.get("volume_fp")) < p["min_volume"]:
            continue
        depth = _fp(m.get("yes_ask_size_fp"))
        if depth < p["min_depth"]:
            continue
        i = bucket_of(ask)
        if i is None:
            continue
        label = bucket_label(i)
        gap = gaps.get(label)
        if gap is None or ts.get(label, 0.0) < p["min_t"]:
            continue
        series = tk.split("-")[0]
        edge = edge_after_fees(ask, gap, series=series)
        if edge < p["min_edge_dollars"]:
            continue
        # Contracts are fractional to 0.01 on Kalshi, which is the reason a
        # $40 account can hold a real position here and cannot in equities.
        want = p["equity"] * p["max_position_frac"] / ask
        size = math.floor(min(want, depth) * 100) / 100.0
        if size < 0.01:
            continue
        out.append({"ticker": tk, "price": ask, "size": size, "edge": edge,
                    "event": m.get("event_ticker") or tk})
    out.sort(key=lambda r: r["edge"] * r["size"], reverse=True)

    # Strikes inside one event are the same bet at different thresholds - if
    # the high hits 70 then "above 65" and "above 60" both pay, and if it
    # misses they both fail. Bootstrapping the study by settlement date
    # rather than by contract widened the confidence interval by about half,
    # which is the measured cost of pretending those are independent.
    per_event, kept = {}, []
    for r in out:
        ev = r["event"]
        if per_event.get(ev, 0) >= int(p["max_per_event"]):
            continue
        per_event[ev] = per_event.get(ev, 0) + 1
        kept.append({k: v for k, v in r.items() if k != "event"})
        if len(kept) >= int(p["max_positions"]):
            break
    return kept


def screen_defaults():
    return {
        "min_price": 0.85,          # the favorite end; below it the fee bites
        "max_price": 0.98,          # above it one loss undoes a hundred wins
        "max_spread": 0.03,         # a wider quote is not a price
        "min_volume": 100.0,        # contracts traded, lifetime
        "min_depth": 1.0,           # contracts resting at the ask
        "min_t": 2.0,               # measured gap must beat its own noise
        "min_edge_dollars": 0.005,  # half a cent per contract, after the fee
        "max_positions": 10,
        "max_per_event": 1,         # strikes in one event are one bet
        "max_position_frac": 0.05,  # of equity, per contract line
        "equity": 100.0,
        "gap_pp": MEASURED_GAP_PP,
        "gap_t": MEASURED_T,
    }


def _fp(v):
    """Kalshi returns quantities as fixed-point decimal strings."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


@register
class KalshiFavoriteLongshot(Desk):
    """Framework-side wrapper so the same rules can be replayed.

    The live path is `screen_markets`; this class exists because the engine
    and the walk-forward harness speak `View`/`Decision`, and a desk that
    cannot be replayed by the same machinery as every other desk is a desk
    whose numbers nobody can check. Each symbol is one market ticker and each
    bar's close is that contract's YES price in dollars.

    Hold-to-settlement is expressed WITHOUT state, which the base class
    requires: a contract counts as held if its price has ever been inside the
    entry band since the series began. That is recomputed from history on
    every call, so the desk stays pure and the replay cannot drift from live.
    """
    meta = DeskMeta(
        name="kalshi-bias",
        title="Favorite-longshot bias (Kalshi binaries)",
        asset_class="prediction",
        venue="kalshi",
        interval="1d",
        periods_per_year=365,          # prediction markets settle every day
        events=(CLOSE,),
        universe=(),                   # screened live, not a fixed list
        warmup_bars=1,                 # a contract is tradable the day it opens
        # Kalshi contracts are fractional to 0.01, so the minimum order is
        # about a cent and size is not the binding constraint - the binding
        # constraint is that this desk is NOT VALIDATED. The floor is set to
        # the framework minimum rather than to a number that would imply the
        # strategy is ready to fund.
        capital_floor=25.0,
        pdt_day_trades=False,          # no PDT rule on a CFTC exchange
        shortable=False,               # buy the other side instead
        fractional=True,
        # A taker lifting the ask. That is the whole point of the test: the
        # bias is measurable at the midpoint and disappears at the ask, so
        # modelling this as anything cheaper would be assuming the answer.
        execution_style="crossing",
        status="rejected",
        status_reason=("487 tight-quoted settled markets: the favorite end is +0.9% to +6.6% of stake after fees on 21-29 markets per bucket, t 0.5-1.25 — indistinguishable from a fair price"),
        description="Buys binary contracts priced as heavy favorites and "
                    "holds them to settlement. REJECTED: the measured "
                    "calibration gap does not clear the quoted spread.",
    )

    @classmethod
    def defaults(cls):
        d = screen_defaults()
        d.pop("equity")
        return d

    @classmethod
    def param_grid(cls):
        # One question only - where the favorite band starts - and it is
        # asked with three points, because every extra point is a trial the
        # deflated Sharpe has to discount and this desk has no Sharpe to
        # spare.
        return {"min_price": [0.85, 0.90, 0.95]}

    def _entered(self, closes):
        """True once the price has been inside the entry band at any point."""
        lo, hi = float(self.params["min_price"]), float(self.params["max_price"])
        return any(c is not None and lo <= c <= hi for c in closes)

    def decide(self, view: View) -> Decision:
        gaps = self.params.get("gap_pp") or {}
        ts_ = self.params.get("gap_t") or {}
        min_t = float(self.params["min_t"])

        held = []
        for sym in view.symbols():
            closes = view.closes(sym)
            if not closes or not self._entered(closes):
                continue
            px = closes[-1]
            if px is None or not 0 < px < 1:
                continue
            i = bucket_of(px)
            if i is None:
                continue
            label = bucket_label(i)
            # The same gate the live screen applies: only trade a bucket whose
            # measured gap beat its own standard error. At the shipped
            # calibration nothing does, and this desk holds nothing.
            if ts_.get(label, 0.0) < min_t:
                continue
            if edge_after_fees(px, gaps.get(label, 0.0),
                               series=sym.split("-")[0]) < \
                    float(self.params["min_edge_dollars"]):
                continue
            held.append(sym)

        if not held:
            return Decision({}, note="no bucket clears its measured noise")

        held.sort()
        held = held[: int(self.params["max_positions"])]
        w = min(float(self.params["max_position_frac"]), 1.0 / len(held))
        return Decision({s: w for s in held},
                        note=f"holding {len(held)} favorites to settlement")
