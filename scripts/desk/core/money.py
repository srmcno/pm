#!/usr/bin/env python3
"""Cost models. Every number a desk reports passes through here.

The predecessor system's failure was not a coding bug: its replays reported
profits that live paper trading then gave back. Two causes, both cost-model
failures — fills assumed at prices no one would have given us, and fees
counted on some legs but not others. So costs live in one module, are applied
identically in replay and live, and are deliberately pessimistic where the
truth is unknowable.

The rule everywhere below: when a cost is uncertain, round it AGAINST the
strategy. A desk that clears a pessimistic cost model is worth arming; one
that only clears an optimistic one is a way to lose money slowly.
"""
import math
from dataclasses import dataclass

# --------------------------------------------------------------- US equities
# Commissions are genuinely zero on a direct retail Alpaca account. What
# remains is regulatory. Rates verified against the Alpaca fee schedule
# revised 2026-07-20 and cross-checked to SEC and FINRA notices.
SEC_FEE_PER_DOLLAR = 0.0000206      # SEC §31, SELLS only ($20.60/$1M), eff. 2026-04-04
FINRA_TAF_PER_SHARE = 0.000195      # FINRA TAF, SELLS only, eff. 2026-01-01
FINRA_TAF_CAP = 9.79                # per trade
CAT_PER_SHARE = 0.000003            # Consolidated Audit Trail, BUYS AND SELLS

# The trap that dominates a small account. Each fee type is aggregated per
# account PER DAY and then rounded UP to the whole cent. So any day with any
# activity costs at least $0.01 x 3 fee types = $0.03, no matter how small
# the trade. That floor is invisible in a percentage-based cost model and is
# the single biggest drag on a $40 account:
#
#     account    one trading day    250 trading days    as % of capital
#     $40              $0.03              $7.50               18.8%
#     $500             $0.03              $7.50                1.5%
#     $2,000           $0.03              $7.50                0.4%
#
# A daily-turnover desk therefore needs roughly $500 before the floor stops
# eating the edge — which is a sizing conclusion, not a coding one, and is
# why `daily_fee_floor` is charged explicitly in the replay.
FEE_ROUNDING_FLOOR = 0.01
FEE_TYPES_PER_DAY = 3               # SEC + TAF + CAT


def equity_sell_fees(shares: float, price: float) -> float:
    """Regulatory fees on an equity SALE, before daily aggregation."""
    if shares <= 0 or price <= 0:
        return 0.0
    proceeds = shares * price
    sec = proceeds * SEC_FEE_PER_DOLLAR
    taf = min(shares * FINRA_TAF_PER_SHARE, FINRA_TAF_CAP)
    cat = shares * CAT_PER_SHARE
    return sec + taf + cat


def equity_buy_fees(shares: float, price: float) -> float:
    """CAT is charged on buys too — small, but it is the third fee type and
    so it is what makes the daily floor $0.03 rather than $0.02."""
    if shares <= 0 or price <= 0:
        return 0.0
    return shares * CAT_PER_SHARE


def daily_fee_floor(raw_fees_today: float, traded_today: bool) -> float:
    """Extra charge from rounding each fee type up to the cent, once a day.

    Returns the amount to ADD to the day's accrued raw fees. On a day with
    no trades it is zero; on any day with trades the total is at least
    $0.03. This is applied once per session by the replay engine, not per
    fill, which is how the broker actually bills it.
    """
    if not traded_today:
        return 0.0
    floor = FEE_ROUNDING_FLOOR * FEE_TYPES_PER_DAY
    return max(0.0, floor - raw_fees_today)


# ------------------------------------------------------------------- crypto
# Verified against live fee schedules 2026-08-30. BASE tier — what a small
# account actually pays, not the headline institutional number.
CRYPTO_TAKER = {
    "alpaca": 0.0025,      # 0.25% (tier 1, 0-$100k 30d volume)
    "coinbase": 0.0060,    # 0.60% Advanced Trade base taker
    "kraken": 0.0040,      # 0.40% base taker
}
CRYPTO_MAKER = {
    "alpaca": 0.0015,      # 0.15%
    "coinbase": 0.0040,
    "kraken": 0.0025,
}

# Measured live on Alpaca 2026-08-30. Only BTC and ETH are cheap enough to
# trade actively; everything else costs more in spread than most signals
# produce in edge, which is why the crypto desks below hold a two-name
# universe rather than a broad one.
CRYPTO_SPREAD_BPS = {
    "BTC": 2.9, "ETH": 2.3, "LINK": 24.0, "DOGE": 33.0,
    "XRP": 37.0, "AVAX": 58.0, "LTC": 63.0, "PEPE": 55.0,
}


def crypto_fee(venue: str, notional: float, maker: bool = False) -> float:
    """Exchange fee on one crypto leg. Unknown venue falls back to the worst
    rate on the board rather than to zero."""
    table = CRYPTO_MAKER if maker else CRYPTO_TAKER
    rate = table.get(venue, max(table.values()))
    return abs(notional) * rate


# ------------------------------------------------------- prediction markets
# Kalshi's fee is quadratic in price and charged per contract:
#
#     fee = 0.07 x multiplier x contracts x P x (1 - P)
#
# `multiplier` is a LIVE PER-SERIES FIELD (GET /series returns fee_type and
# fee_multiplier) — 1 on most series, 0.5 on some MLB props, 0 on ten
# fee-free series. Never hardcode it in a live path; the default here is the
# pessimistic one.
#
# Maker orders are FREE on 98.7% of series (9,956 of 10,088 enumerated).
# The exception is the headline economics set — KXFED, KXCPI, KXPAYROLLS,
# KXGDP and peers — which charge makers 0.25x the taker rate. Those are
# exactly the markets a macro consensus model wants, so a desk trading them
# must not assume free resting orders.
KALSHI_COEFFICIENT = 0.07
KALSHI_MAKER_FRACTION = 0.25         # of the taker rate, on series that charge
KALSHI_ROUNDING = 0.000001           # ceil to a millionth of a dollar (2026)
KALSHI_MAKER_FEE_SERIES = {
    "KXFED", "KXFEDDECISION", "KXCPI", "KXCPIYOY", "KXPAYROLLS", "KXGDP",
    "KXU3", "KXRATECUTCOUNT", "KXEGGS", "KXAAAGASM", "KXINXY",
    "KXNASDAQ100Y", "KXIPO", "KXLLM1", "KXBTCMAX125", "KXBTCMAX150",
}


def kalshi_fee(price: float, contracts: float = 1.0, maker: bool = False,
               multiplier: float = 1.0, series: str = "") -> float:
    """Kalshi trading fee in dollars.

    Two facts drive strategy design here, and both are in this formula:

      * The fee peaks at P=0.50 (1.75c per contract, 3.5% of the stake) and
        collapses toward the extremes. Round-tripping at the money costs 7%
        of stake, so a desk must hold to settlement rather than scalp.
      * Resting orders are free on almost every series. A maker-only desk on
        Kalshi pays no exchange fee at all — the rare case where a small
        account's costs are genuinely near zero.

    Rounding is to a millionth of a dollar (2026 rule), not up to the cent
    as older tutorials assume, which is what makes penny-sized orders viable.
    """
    if contracts <= 0 or not 0 < price < 1:
        return 0.0
    rate = KALSHI_COEFFICIENT * float(multiplier)
    if maker:
        if series and series.upper() not in KALSHI_MAKER_FEE_SERIES:
            return 0.0                       # free maker on ~98.7% of series
        rate *= KALSHI_MAKER_FRACTION
    raw = rate * contracts * price * (1 - price)
    return math.ceil(raw / KALSHI_ROUNDING) * KALSHI_ROUNDING


def kalshi_edge_required(price: float, maker: bool = False,
                         hold_to_settlement: bool = True) -> float:
    """Probability edge (in percentage points) needed just to break even.

    At 50c a taker held to settlement needs 1.75pp of true edge; one that
    exits early before settlement needs 3.5pp. This is the number a signal
    has to clear, and it is why the consensus desk gates on it explicitly.
    """
    legs = 1 if hold_to_settlement else 2
    per_leg = kalshi_fee(price, 1.0, maker)
    return per_leg * legs * 100.0


# ------------------------------------------------------------------- spreads
@dataclass(frozen=True)
class SpreadModel:
    """What crossing the book costs when we cannot see the book.

    Live paths always prefer a real quote. This exists for replay over bar
    data, where only OHLCV survives. Values are conservative estimates in
    basis points of notional for ONE crossing (half-spread plus impact).
    """
    half_spread_bps: float
    slippage_bps: float

    @property
    def one_way_bps(self) -> float:
        return self.half_spread_bps + self.slippage_bps

    def cost(self, notional: float) -> float:
        return abs(notional) * self.one_way_bps / 1e4


# How an order reaches the market. This is not a detail: the same strategy
# costs an order of magnitude more crossing the book than participating in
# an auction, and modelling the wrong one is the difference between a desk
# that clears its costs and one that does not.
#
#   CROSSING  a marketable order lifts the ask or hits the bid — pay the
#             half-spread plus impact. Anything reacting to a live quote.
#   AUCTION   market-on-close / market-on-open. The order joins the primary
#             exchange's auction and fills AT the official print, the same
#             price the tape publishes and the same price this repo's bar
#             data records. There is no spread to cross; what remains is the
#             risk of an imbalance moving the print, which is small for a
#             retail-sized order and is what the residual bps below charges.
#             MOC must be in before the exchange cutoff (15:50 ET) or it is
#             rejected — the live executor enforces that, not this table.
CROSSING = "crossing"
AUCTION = "auction"

# Residual cost of auction participation, one way, in bps of notional.
AUCTION_BPS = {
    "etf_liquid": 0.5,
    "etf_normal": 1.0,
    "equity_large": 1.0,
    "equity_mid": 2.0,
    "crypto_major": 3.0,     # crypto has no auction; falls back to crossing
    "crypto_minor": 10.0,
}

# Calibrated to observed quotes, deliberately wide. Mega-cap ETFs quote a
# penny on a $500 book (~0.2bp); we charge ten times that to absorb the
# open/close auction imbalances these desks actually trade into.
SPREADS = {
    "etf_liquid": SpreadModel(1.0, 1.0),      # SPY QQQ IWM
    "etf_normal": SpreadModel(2.0, 2.0),      # sector/thematic ETFs
    "equity_large": SpreadModel(2.0, 3.0),    # mega-cap single names
    "equity_mid": SpreadModel(5.0, 5.0),      # MSTR COIN-class volatility
    "crypto_major": SpreadModel(2.0, 3.0),    # BTC ETH on a US venue
    "crypto_minor": SpreadModel(8.0, 10.0),
}


def execution_cost_bps(symbol: str, asset_class: str = "equity",
                       style: str = CROSSING) -> float:
    """One-way execution cost in bps for a symbol under an execution style."""
    model = spread_for(symbol, asset_class)
    if style == AUCTION and asset_class == "equity":
        for key, sm in SPREADS.items():
            if sm is model:
                return AUCTION_BPS.get(key, model.one_way_bps)
    return model.one_way_bps


def spread_for(symbol: str, asset_class: str = "equity") -> SpreadModel:
    """Pick a spread model for a symbol. Unknown symbols get the wide one."""
    if asset_class == "crypto":
        base = symbol.split("/")[0].split("-")[0].upper()
        return SPREADS["crypto_major" if base in ("BTC", "ETH") else "crypto_minor"]
    sym = symbol.upper()
    if sym in ("SPY", "QQQ", "IWM", "VTI", "VOO"):
        return SPREADS["etf_liquid"]
    if sym in ("XLK", "XLF", "XLE", "XLV", "GLD", "SLV", "TLT", "IBIT", "ETHA",
               "EFA", "EEM", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "SMH"):
        return SPREADS["etf_normal"]
    if sym in ("MSTR", "COIN", "MARA", "RIOT", "TQQQ", "SOXL", "TSLA"):
        return SPREADS["equity_mid"]
    return SPREADS["equity_large"]


# ------------------------------------------------------------------- sizing
def round_shares(shares: float, fractional_ok: bool, side: str) -> float:
    """Venue-truthful share rounding.

    Fractional longs are real at Alpaca (market DAY orders). Fractional
    SHORTS are not, anywhere — a short is a borrow, and you cannot borrow
    0.4 of a share. Replay must round the same way live does or the two
    diverge exactly where positions are smallest.
    """
    if shares <= 0:
        return 0.0
    if side == "short" or not fractional_ok:
        return float(int(shares))
    return round(shares, 6)


def position_notional(equity: float, weight: float, price: float,
                      fractional_ok: bool = True, side: str = "long") -> tuple:
    """(shares, notional) for a target weight of equity at a price."""
    if price <= 0 or equity <= 0 or weight <= 0:
        return 0.0, 0.0
    shares = round_shares(equity * weight / price, fractional_ok, side)
    return shares, shares * price
