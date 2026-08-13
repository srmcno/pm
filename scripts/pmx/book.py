#!/usr/bin/env python3
"""Order book normalization and depth walking.

One detail here is worth more than the rest of the file. The Polymarket CLOB
returns `bids` ASCENDING and `asks` DESCENDING -- both arrays run from worst
price to best, so the top of book is the LAST element of each, not the first.
Verified live on a liquid market:

    bids[0]  = 0.001 @ 2,069,778      bids[-1] = 0.230 @ 2,925
    asks[0]  = 0.999 @ 3,016,566      asks[-1] = 0.231 @ 2,447
    /price side=BUY -> 0.230 (best bid)   side=SELL -> 0.231 (best ask)

Reading `asks[0]` as the best ask returns 0.999 on a market trading at 0.231.
An engine that sizes against that number thinks there is unlimited depth at
any price and will hand its bankroll to the first market order it sends. Every
accessor in this module sorts explicitly rather than trusting arrival order.

A buyer pays the ask and a seller receives the bid, which is why `/price` with
side=BUY returns the bid: the endpoint names the side of the resting order it
reads, not the side you are taking.
"""
from dataclasses import dataclass, field


def _levels(rows, reverse):
    """(price, size) pairs sorted best-first, tolerating string numerics."""
    out = []
    for r in rows or []:
        if isinstance(r, dict):
            p, s = r.get("price"), r.get("size")
        else:
            p, s = getattr(r, "price", None), getattr(r, "size", None)
        try:
            p, s = float(p), float(s)
        except (TypeError, ValueError):
            continue
        if s > 0:
            out.append((p, s))
    out.sort(key=lambda kv: kv[0], reverse=reverse)
    return out


@dataclass
class Book:
    """A normalized snapshot. `bids` and `asks` are always best-first."""

    asset_id: str = ""
    bids: list = field(default_factory=list)     # descending price
    asks: list = field(default_factory=list)     # ascending price
    tick_size: float = 0.01
    min_order_size: float = 5.0
    neg_risk: bool = False
    timestamp: int = 0

    @classmethod
    def parse(cls, raw, asset_id=""):
        """From a REST dict, a WS `book` event, or an SDK OrderBookSummary."""
        get = (raw.get if isinstance(raw, dict)
               else lambda k, d=None: getattr(raw, k, d))
        def num(key, default):
            try:
                return float(get(key, default))
            except (TypeError, ValueError):
                return default
        return cls(
            asset_id=get("asset_id", asset_id) or asset_id,
            bids=_levels(get("bids"), reverse=True),
            asks=_levels(get("asks"), reverse=False),
            tick_size=num("tick_size", 0.01),
            min_order_size=num("min_order_size", 5.0),
            neg_risk=bool(get("neg_risk", False)),
            timestamp=int(num("timestamp", 0)),
        )

    # ------------------------------------------------------------ top of book
    @property
    def best_bid(self):
        return self.bids[0][0] if self.bids else None

    @property
    def best_ask(self):
        return self.asks[0][0] if self.asks else None

    @property
    def spread(self):
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    @property
    def mid(self):
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2.0

    def is_crossed(self):
        """A crossed or locked book is a stale snapshot, not an opportunity."""
        return (self.best_bid is not None and self.best_ask is not None
                and self.best_bid >= self.best_ask)

    # -------------------------------------------------------------- depth
    def depth_notional(self, limit_price, side="buy"):
        """USDC resting at or better than `limit_price` on the side we take."""
        levels = self.asks if side == "buy" else self.bids
        tot = 0.0
        for p, s in levels:
            if (side == "buy" and p > limit_price) or \
               (side == "sell" and p < limit_price):
                break
            tot += p * s
        return tot

    def walk(self, notional, limit_price=None, side="buy"):
        """Consume the book for `notional` USDC and report the real fill.

        This is what makes slippage a measured number rather than an assumed
        constant: a $4 order into a book whose top level holds $3 fills the
        rest a tick higher, and the caller needs the resulting average, not
        the touch price.

        Returns dict with avgPrice, shares, filled (USDC), levels, and
        `complete` -- False when the book ran out inside the limit, which for
        a Fill-Or-Kill order means do not send it.
        """
        levels = self.asks if side == "buy" else self.bids
        remaining, shares, spent, used = notional, 0.0, 0.0, 0
        for p, s in levels:
            if limit_price is not None:
                if side == "buy" and p > limit_price:
                    break
                if side == "sell" and p < limit_price:
                    break
            if remaining <= 1e-9:
                break
            take_usd = min(remaining, p * s)
            shares += take_usd / p
            spent += take_usd
            remaining -= take_usd
            used += 1
        avg = spent / shares if shares > 0 else None
        return {"avgPrice": avg, "shares": round(shares, 6),
                "filled": round(spent, 6), "levels": used,
                "complete": remaining <= 1e-6,
                "shortfall": round(max(0.0, remaining), 6)}

    def effective_price(self, notional, limit_price=None, side="buy"):
        w = self.walk(notional, limit_price, side)
        return w["avgPrice"], w

    def slippage(self, notional, side="buy"):
        """Difference between the touch and the average this size would pay."""
        touch = self.best_ask if side == "buy" else self.best_bid
        avg, _ = self.effective_price(notional, side=side)
        if touch is None or avg is None:
            return None
        return (avg - touch) if side == "buy" else (touch - avg)


def round_to_tick(price, tick, direction="down"):
    """Snap a price to the market's grid. The CLOB rejects off-grid prices.

    A buyer rounds its limit DOWN (never pay more than intended); a seller
    rounds UP. Rounding the wrong way turns a bounded-slippage order into an
    unbounded one, one tick at a time.
    """
    if not tick or tick <= 0:
        return round(price, 4)
    import math
    n = price / tick
    # int() truncates toward zero, which is not ceil for positive numbers --
    # it rounded 0.2311 UP to 0.23 instead of 0.24. Use math explicitly.
    if direction == "down":
        n = math.floor(n + 1e-9)
    elif direction == "up":
        n = math.ceil(n - 1e-9)
    else:
        n = round(n)
    out = n * tick
    # Keep inside the tradable band and off floating-point dust.
    decimals = max(0, len(str(tick).split(".")[-1])) if "." in str(tick) else 0
    return round(min(max(out, tick), 1.0 - tick), decimals + 2)
