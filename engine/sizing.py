"""Exchange filters and the depth-walking size solver.

Top-of-book says an edge might exist. This module answers the only question
that matters before sending an order: *how much can actually be executed, and
what is left after the book pushes back?*

Two things the polling desk got wrong and this fixes
----------------------------------------------------
1. **Lot and notional filters.** A cycle sized at $7.31 whose leg-2 quantity
   rounds down to a step boundary hands leg 3 less than the plan assumed. That
   residue is not rounding noise — it is an open position in a micro-cap. So
   sizing runs in two stages: solve continuously, then *quantize*, then re-price
   the quantized plan and keep it only if it still clears the bar.

2. **Monotonicity.** Cycle yield is non-increasing in size: every extra unit is
   filled at a weakly worse price on at least one leg. That makes bisection
   valid and exact, so `solve_cycle_size` finds the largest executable size
   rather than testing three hardcoded candidates and shrugging.

The rounding direction is deliberate everywhere: quantities round **down**,
buy limits round **up** to the tick, sell limits round **down**. Every choice
biases toward "the order is executable and does not over-commit", because the
failure mode on the other side is stranded inventory.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .book import Level, WalkResult, walk_buy, walk_buy_base, walk_sell
from .graph import BUY, SELL, Leg, Triangle

__all__ = [
    "SymbolFilters", "LegPlan", "CyclePlan", "quantize_down", "quantize_up",
    "simulate_cycle", "solve_cycle_size", "DepthSource",
]

# symbol -> (bid_levels, ask_levels), each best-first
DepthSource = Mapping[str, tuple[Sequence[Level], Sequence[Level]]]


def quantize_down(x: float, step: float) -> float:
    if step <= 0:
        return x
    # Nudge by a relative epsilon before flooring: a value that is a step
    # multiple in decimal is often 1 ULP below it in binary, and flooring that
    # silently drops a whole lot.
    return math.floor(x / step + 1e-9) * step


def quantize_up(x: float, step: float) -> float:
    if step <= 0:
        return x
    return math.ceil(x / step - 1e-9) * step


@dataclass(frozen=True)
class SymbolFilters:
    """The venue's trading rules for one symbol.

    Defaults are permissive so a missing `exchangeInfo` field degrades to "no
    constraint" rather than silently zeroing every order.
    """
    symbol: str
    base: str
    quote: str
    taker: float = 0.0005
    tick_size: float = 0.0
    step_size: float = 0.0
    min_qty: float = 0.0
    max_qty: float = float("inf")
    min_notional: float = 0.0

    def qty(self, x: float) -> float:
        return quantize_down(min(x, self.max_qty), self.step_size)

    def price(self, x: float, side: int) -> float:
        """Round a limit price in the aggressive direction for `side`."""
        if self.tick_size <= 0:
            return x
        return quantize_up(x, self.tick_size) if side == BUY else quantize_down(x, self.tick_size)

    def ok(self, qty: float, price: float) -> bool:
        if qty <= 0 or qty < self.min_qty:
            return False
        return qty * price >= self.min_notional


@dataclass
class LegPlan:
    """One leg, ready to send."""
    symbol: str
    side: int                    # BUY / SELL
    limit_price: float           # aggressive IOC price, already tick-rounded
    order_qty: float             # base quantity the venue will match on
    quote_amount: float          # quote spent (BUY) or received (SELL), gross
    net_out: float               # what the NEXT leg gets to work with, net fee
    vwap: float
    levels: int
    fee: float

    @property
    def side_str(self) -> str:
        return "BUY" if self.side == BUY else "SELL"

    def as_dict(self) -> dict:
        return {"symbol": self.symbol, "side": self.side_str,
                "price": self.limit_price, "qty": self.order_qty,
                "netOut": round(self.net_out, 10), "vwap": self.vwap,
                "levels": self.levels}


@dataclass
class CyclePlan:
    """A fully priced, filter-legal, executable cycle.

    `size_usd` is the size that was *requested*; `deployed_usd` is what leg 1
    actually consumes once its quantity is snapped to a legal lot. Yield is
    measured against `deployed_usd`, because that is the capital at risk —
    dividing by the request would quietly credit the cycle for money it never
    spent.
    """
    tri: Triangle
    size_usd: float
    out_usd: float
    deployed_usd: float = 0.0
    legs: list[LegPlan] = field(default_factory=list)
    feasible: bool = False
    reason: str = ""
    max_levels: int = 0

    @property
    def capital_usd(self) -> float:
        return self.deployed_usd or self.size_usd

    @property
    def profit_usd(self) -> float:
        return self.out_usd - self.capital_usd

    @property
    def bps(self) -> float:
        c = self.capital_usd
        return (self.out_usd / c - 1.0) * 10_000.0 if c > 0 else float("-inf")

    def as_dict(self) -> dict:
        return {"path": self.tri.path, "sizeUsd": round(self.capital_usd, 4),
                "requestedUsd": round(self.size_usd, 4),
                "outUsd": round(self.out_usd, 6),
                "profitUsd": round(self.profit_usd, 6),
                "bps": round(self.bps, 2) if self.capital_usd > 0 else None,
                "feasible": self.feasible, "reason": self.reason,
                "legs": [l.as_dict() for l in self.legs]}


def _pad_price(px: float, side: int, pad_bps: float) -> float:
    """Cross the worst consumed level by `pad_bps` so an IOC actually sweeps.

    A limit exactly at the worst level races every other taker to it. The pad
    is not slippage tolerance — the walk already priced every level — it is
    insurance against the touch moving one tick between decision and arrival.
    """
    f = 1.0 + pad_bps / 10_000.0
    return px * f if side == BUY else px / f


def simulate_cycle(tri: Triangle, depth: DepthSource, start_usd: float,
                   filters: Mapping[str, SymbolFilters],
                   quantize: bool = True, pad_bps: float = 5.0) -> CyclePlan:
    """Price the whole cycle at `start_usd` by walking real depth.

    With `quantize=False` this is the smooth function bisection searches over.
    With `quantize=True` it produces the plan that will actually be sent, with
    every quantity snapped to a legal lot and re-priced at that lot.
    """
    plan = CyclePlan(tri=tri, size_usd=start_usd, out_usd=0.0)
    amt = start_usd
    for leg in tri.legs:
        f = filters.get(leg.symbol)
        fee = f.taker if f else leg.fee
        book = depth.get(leg.symbol)
        if not book:
            plan.reason = f"no depth for {leg.symbol}"
            return plan
        bids, asks = book

        if leg.side == BUY:
            # `amt` is quote currency; find how much base it buys.
            w: WalkResult = walk_buy(asks, amt, fee)
            if not w.complete:
                plan.reason = f"{leg.symbol}: book too thin for {amt:.6f} quote"
                return plan
            gross_base = w.filled / (1.0 - fee)          # pre-fee matched qty
            order_qty = f.qty(gross_base) if (quantize and f) else gross_base
            if quantize and f and order_qty <= 0:
                plan.reason = f"{leg.symbol}: qty quantizes to zero"
                return plan
            if quantize and order_qty < gross_base:
                # Re-price the *rounded* quantity — never rescale the walk.
                w2 = walk_buy_base(asks, order_qty, fee)
                if not w2.complete:
                    plan.reason = f"{leg.symbol}: rounded qty unfillable"
                    return plan
                spent, net_out, vwap, lv = w2.filled, w2.consumed, w2.vwap, w2.levels
            else:
                spent, net_out, vwap, lv = amt, w.filled, w.vwap, w.levels
            px = _pad_price(w.worst_px, BUY, pad_bps)
            if f:
                px = f.price(px, BUY)
                if not f.ok(order_qty, px):
                    plan.reason = (f"{leg.symbol}: fails minQty/minNotional "
                                   f"({order_qty:.8f} @ {px:.8f})")
                    return plan
            plan.legs.append(LegPlan(leg.symbol, BUY, px, order_qty, spent,
                                     net_out, vwap, lv, fee))
            amt = net_out
        else:
            # `amt` is base currency; sell it into the bids.
            order_qty = f.qty(amt) if (quantize and f) else amt
            if quantize and f and order_qty <= 0:
                plan.reason = f"{leg.symbol}: qty quantizes to zero"
                return plan
            w = walk_sell(bids, order_qty, fee)
            if not w.complete:
                plan.reason = f"{leg.symbol}: book too thin for {order_qty:.8f} base"
                return plan
            px = _pad_price(w.worst_px, SELL, pad_bps)
            if f:
                px = f.price(px, SELL)
                if not f.ok(order_qty, px):
                    plan.reason = (f"{leg.symbol}: fails minQty/minNotional "
                                   f"({order_qty:.8f} @ {px:.8f})")
                    return plan
            plan.legs.append(LegPlan(leg.symbol, SELL, px, order_qty, w.filled,
                                     w.filled, w.vwap, w.levels, fee))
            amt = w.filled
        plan.max_levels = max(plan.max_levels, plan.legs[-1].levels)

    first = plan.legs[0]
    # Capital at risk = what leg 1 actually consumes. For a BUY that is the
    # quote spent; for a SELL (a cycle whose first hop sells the quote asset,
    # e.g. USDTTRY) it is the base quantity, which is denominated in the quote
    # asset by construction.
    plan.deployed_usd = first.quote_amount if first.side == BUY else first.order_qty
    plan.out_usd = amt
    plan.feasible = True
    return plan


def solve_cycle_size(tri: Triangle, depth: DepthSource,
                     filters: Mapping[str, SymbolFilters],
                     min_bps: float, max_usd: float, min_usd: float = 1.0,
                     iterations: int = 22, pad_bps: float = 5.0
                     ) -> CyclePlan | None:
    """Largest notional whose *quantized* plan still clears `min_bps`.

    Bisection is sound because yield is monotonically non-increasing in size
    (deeper levels are weakly worse). The search runs on the unquantized
    simulation — smooth, so bisection converges cleanly — and only the winning
    size is quantized and re-verified. If quantization pushes it under the bar,
    the search steps down through the bracket rather than shipping a plan whose
    stated edge is fiction.
    """
    if max_usd < min_usd:
        return None

    def yield_bps(size: float) -> float:
        p = simulate_cycle(tri, depth, size, filters, quantize=False, pad_bps=pad_bps)
        return p.bps if p.feasible else float("-inf")

    if yield_bps(min_usd) < min_bps:
        return None                          # not even the smallest size works

    lo, hi = min_usd, max_usd
    if yield_bps(hi) >= min_bps:
        lo = hi                              # whole range clears; take the top
    else:
        for _ in range(iterations):
            mid = (lo + hi) / 2.0
            if yield_bps(mid) >= min_bps:
                lo = mid
            else:
                hi = mid
            if hi - lo < 1e-4:
                break

    # Quantize and re-verify at the smooth optimum. Right at the boundary, lot
    # rounding often costs the last basis point, so fall back to a second
    # bisection on the *quantized* function rather than a coarse step-down —
    # a 2 % step would throw away half a dollar of size for nothing.
    best = simulate_cycle(tri, depth, lo, filters, quantize=True, pad_bps=pad_bps)
    if best.feasible and best.bps >= min_bps:
        return best

    qlo, qhi = min_usd, lo
    found: CyclePlan | None = None
    probe = simulate_cycle(tri, depth, qlo, filters, quantize=True, pad_bps=pad_bps)
    if not (probe.feasible and probe.bps >= min_bps):
        return None                          # quantization kills even the floor
    found = probe
    for _ in range(16):
        mid = (qlo + qhi) / 2.0
        p = simulate_cycle(tri, depth, mid, filters, quantize=True, pad_bps=pad_bps)
        if p.feasible and p.bps >= min_bps:
            found, qlo = p, mid
        else:
            qhi = mid
        if qhi - qlo < 1e-4:
            break
    return found


def capacity_curve(tri: Triangle, depth: DepthSource,
                   filters: Mapping[str, SymbolFilters],
                   sizes: Sequence[float], pad_bps: float = 5.0) -> list[dict]:
    """Yield-vs-size curve — the shape of the edge, for the dashboard.

    A cycle worth 60 bps at $5 and 3 bps at $50 is a different animal from one
    flat at 20 bps to $200, and the difference decides whether it is worth
    holding inventory for.
    """
    out = []
    for s in sizes:
        p = simulate_cycle(tri, depth, s, filters, quantize=True, pad_bps=pad_bps)
        out.append({"sizeUsd": s,
                    "bps": round(p.bps, 2) if p.feasible else None,
                    "profitUsd": round(p.profit_usd, 6) if p.feasible else None,
                    "reason": p.reason})
    return out


def filters_from_mexc_info(info: Mapping[str, Mapping]) -> dict[str, SymbolFilters]:
    """Build filters from a MEXC `exchangeInfo` symbol map.

    MEXC reports precision as decimal places (`baseSizePrecision`,
    `quoteAmountPrecision`, `baseAssetPrecision`) rather than Binance-style
    step strings, so step is derived as 10^-precision.
    """
    out: dict[str, SymbolFilters] = {}
    for sym, s in info.items():
        try:
            base_prec = int(s.get("baseAssetPrecision", 8))
            quote_prec = int(s.get("quotePrecision", s.get("quoteAssetPrecision", 8)))
        except (TypeError, ValueError):
            base_prec, quote_prec = 8, 8
        step = float(s.get("stepSize") or 0.0) or 10.0 ** (-base_prec)
        tick = float(s.get("tickSize") or 0.0) or 10.0 ** (-quote_prec)
        try:
            min_notional = float(s.get("quoteAmountPrecision") or 0.0)
        except (TypeError, ValueError):
            min_notional = 0.0
        out[sym] = SymbolFilters(
            symbol=sym, base=s["base"], quote=s["quote"],
            taker=float(s.get("taker", 0.0005)),
            tick_size=tick, step_size=step,
            min_qty=float(s.get("baseSizePrecision") or 0.0),
            min_notional=min_notional,
        )
    return out
