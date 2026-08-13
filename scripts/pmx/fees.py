#!/usr/bin/env python3
"""Fee accounting, isolated so one venue change touches one file.

Polymarket's published formula (help.polymarket.com, "Trading fees"):

    fee = C * feeRate * p * (1 - p)

for C shares at price p, so per share

    fee_per_share = feeRate * p * (1 - p)

symmetric about 50c -- a 30c trade and a 70c trade pay the same dollar fee --
zero at the extremes, and maximal in the middle. Note the curve is p*(1-p),
NOT min(p, 1-p): at 50c those differ by a factor of two, and getting it wrong
overstates the cost of every coin-flip market by 100%.

Two consequences this strategy has to design around.

  Only takers pay. Makers are never charged, and there is a maker rebate
  programme on top. Crossing the spread on a Sports market at 50c costs
  1.25c per share -- 2.5% of notional, round-tripped closer to 3% -- while
  the same fill obtained by resting a limit order costs nothing. That is
  larger than most of the edge this engine is trying to harvest, so
  `execute.py` posts passively first and only escalates to crossing when the
  clock beats the saving.

  Rates are per category. Crypto is 0.07 and Geopolitics is 0.00, a spread
  wide enough that the same signal can be worth taking in one category and
  not in another.

Rates below are transcribed from the published schedule; `feeRate` is a
plain multiplier, not basis points. The CLOB /markets endpoint also returns
integer `maker_base_fee` / `taker_base_fee` fields (currently 1000 on most
markets) whose denomination is not documented anywhere primary, so they are
NOT used for arithmetic -- only surfaced for logging. If you can confirm
their units, set `execution.fallback_fee_bps` explicitly rather than
guessing here.
"""

# Taker fee rate by market category, from the published schedule.
# Makers pay zero in every category.
TAKER_RATES = {
    "Crypto": 0.07,
    "Sports": 0.05,
    "Economics": 0.05,
    "Culture": 0.05,
    "Weather": 0.05,
    "Esports": 0.05,
    "Other": 0.05,
    "Finance": 0.04,
    "Politics": 0.04,
    "Mentions": 0.04,
    "Tech & AI": 0.04,
    "Geopolitics": 0.0,
}
DEFAULT_TAKER_RATE = 0.05          # the modal published rate
MAKER_RATE = 0.0


def taker_rate(category, cfg=None):
    """Fee multiplier for a category, with an explicit config override."""
    if cfg is not None and getattr(cfg, "fallback_fee_bps", 0):
        return cfg.fallback_fee_bps / 10_000.0
    return TAKER_RATES.get(category, DEFAULT_TAKER_RATE)


def fee_per_share(price, rate):
    """Per-share fee at a price. Zero for a maker fill."""
    p = min(max(price, 0.0), 1.0)
    return rate * p * (1.0 - p)


def fee_usd(shares, price, rate):
    return shares * fee_per_share(price, rate)


def round_trip_fee(entry_price, exit_price, rate, entry_is_taker=True,
                   exit_is_taker=True):
    """What a full in-and-out costs per share.

    Sizing charges both legs up front. Booking only the entry fee makes every
    position look better than it is by the width of the exit fee, and on a
    50c market that is the larger half of a 2.5c round trip.

    Resolution is not a taker event -- a winning position redeems at $1 with
    no fee -- so pass exit_is_taker=False when the plan is to hold to
    settlement rather than sell early.
    """
    fee = 0.0
    if entry_is_taker:
        fee += fee_per_share(entry_price, rate)
    if exit_is_taker:
        fee += fee_per_share(exit_price, rate)
    return fee


def breakeven_edge(price, rate):
    """The edge in probability units a taker must have just to break even.

    Useful as a filter before anything else runs: if the consensus cannot
    claim more than this, the trade is a donation regardless of how many
    sharps agree.
    """
    return fee_per_share(price, rate)
