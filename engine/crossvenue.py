"""Synthetic cross-venue spread monitor (MEXC vs Gate.io).

Cross-venue "arbitrage" on micro-caps is mostly a mirage, and this module is
built around the reasons why:

  * **Ticker collisions.** The same three letters are frequently a completely
    different token on each venue. A 4,000 bps gap is not an opportunity, it is
    a name collision. The price-ratio band and the maximum-edge ceiling exist
    to throw those out — inherited from `scripts/arb.py`, which got this right.
  * **You cannot move inventory in time.** Capturing a gap needs funded
    balances on *both* venues simultaneously, sized on both sides. So the
    monitor checks real balances and reports what is *executable now*, not what
    would be executable after a 20-minute chain transfer that the gap will not
    survive.
  * **Top of book is not size.** The gap is re-priced by walking both books at
    the balance-constrained size before it is reported at all.

What survives all of that is a small number of genuinely two-sided
opportunities, and the honest framing for the rest is intel.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Mapping, Sequence

from .book import walk_buy, walk_sell
from .clock import now_ns, wall_ms
from .config import EngineConfig

__all__ = ["CrossVenueMonitor", "CrossGap"]


@dataclass
class CrossGap:
    symbol: str
    direction: str              # "mexc->gate" = buy on MEXC, sell on Gate
    top_bps: float
    sized_bps: float
    size_usd: float
    buy_venue: str
    sell_venue: str
    executable: bool
    blocked_by: str = ""
    mexc_vol_usd: float = 0.0
    gate_vol_usd: float = 0.0
    detected_ms: int = field(default_factory=wall_ms)

    def as_dict(self) -> dict:
        return {"symbol": self.symbol, "direction": self.direction,
                "topBps": round(self.top_bps, 1),
                "sizedBps": round(self.sized_bps, 1),
                "sizeUsd": round(self.size_usd, 2),
                "executable": self.executable, "blockedBy": self.blocked_by,
                "mexcVol24hUsd": round(self.mexc_vol_usd, 0),
                "gateVol24hUsd": round(self.gate_vol_usd, 0),
                "at": self.detected_ms}


class CrossVenueMonitor:
    def __init__(self, cfg: EngineConfig,
                 depth: Mapping[str, Callable[[str], object]],
                 fees: Mapping[str, float],
                 volumes: Mapping[str, Mapping[str, float]] | None = None) -> None:
        self.cfg = cfg
        self.depth = depth            # venue -> callable(symbol) -> (bids, asks)
        self.fees = dict(fees)        # venue -> taker
        self.volumes = {k: dict(v) for k, v in (volumes or {}).items()}
        self.balances: dict[str, dict[str, float]] = {}
        self.gaps: list[CrossGap] = []

    def set_balances(self, venue: str, balances: Mapping[str, float]) -> None:
        self.balances[venue] = dict(balances)

    def set_volumes(self, venue: str, vols: Mapping[str, float]) -> None:
        self.volumes[venue] = dict(vols)

    # ------------------------------------------------------------------ scan

    def scan(self, symbols: Sequence[str], base_of: Mapping[str, str],
             quote: str = "USDT") -> list[CrossGap]:
        cfg = self.cfg
        lo, hi = cfg.cross_price_ratio_band
        out: list[CrossGap] = []
        for sym in symbols:
            books = {}
            for venue, getter in self.depth.items():
                d = getter(sym)
                if d and d[0] and d[1]:
                    books[venue] = d
            if len(books) < 2:
                continue
            venues = list(books)
            for i, va in enumerate(venues):
                for vb in venues[i + 1:]:
                    for buy_v, sell_v in ((va, vb), (vb, va)):
                        gap = self._price_pair(sym, buy_v, sell_v, books,
                                               base_of.get(sym, ""), quote, lo, hi)
                        if gap is not None:
                            out.append(gap)
        out.sort(key=lambda g: -g.sized_bps)
        self.gaps = out[:24]
        return self.gaps

    def _price_pair(self, sym: str, buy_v: str, sell_v: str, books: dict,
                    base: str, quote: str, ratio_lo: float, ratio_hi: float
                    ) -> CrossGap | None:
        cfg = self.cfg
        b_bids, b_asks = books[buy_v]
        s_bids, s_asks = books[sell_v]
        if not (b_asks and s_bids):
            return None
        buy_px, sell_px = b_asks[0][0], s_bids[0][0]
        if buy_px <= 0 or sell_px <= 0:
            return None

        # Same-ticker-different-token guard, before anything else is computed.
        mid_a = (b_bids[0][0] + b_asks[0][0]) / 2 if b_bids else buy_px
        mid_b = (s_bids[0][0] + s_asks[0][0]) / 2 if s_asks else sell_px
        ratio = mid_b / mid_a if mid_a > 0 else 0.0
        if not ratio_lo < ratio < ratio_hi:
            return None

        vol_buy = self.volumes.get(buy_v, {}).get(sym, 0.0)
        vol_sell = self.volumes.get(sell_v, {}).get(sym, 0.0)
        if self.volumes and min(vol_buy, vol_sell) < cfg.cross_min_vol_usd:
            return None

        fee_b = self.fees.get(buy_v, 0.001)
        fee_s = self.fees.get(sell_v, 0.001)
        top_bps = ((sell_px / buy_px) * (1 - fee_b) * (1 - fee_s) - 1) * 10_000
        if not (cfg.cross_min_bps <= top_bps <= cfg.cross_max_bps):
            return None

        # Size it against real balances on BOTH sides. Quote on the buy venue,
        # base inventory on the sell venue — a gap you can only half-execute is
        # a directional bet, not an arbitrage.
        quote_avail = self.balances.get(buy_v, {}).get(quote, 0.0)
        base_avail = self.balances.get(sell_v, {}).get(base, 0.0)
        blocked = ""
        cap_usd = min(cfg.risk.max_stake_per_cycle_usd,
                      cfg.risk.bankroll_usd)
        if self.balances:
            if quote_avail <= 0:
                blocked = f"no {quote} on {buy_v}"
            elif base_avail <= 0:
                blocked = f"no {base} on {sell_v}"
            cap_usd = min(cap_usd, quote_avail or cap_usd,
                          (base_avail * sell_px) or cap_usd)
        size = max(0.0, cap_usd)
        sized_bps = top_bps
        if size >= 1.0:
            wb = walk_buy(b_asks, size, fee_b)
            if wb.complete:
                ws = walk_sell(s_bids, wb.filled, fee_s)
                sized_bps = ((ws.filled / size - 1) * 10_000 if ws.complete
                             else float("-inf"))
            else:
                sized_bps = float("-inf")
                blocked = blocked or "buy book too thin at size"
        if sized_bps < cfg.cross_min_bps:
            return None

        return CrossGap(sym, f"{buy_v}->{sell_v}", top_bps, sized_bps, size,
                        buy_v, sell_v, executable=not blocked and size >= 1.0,
                        blocked_by=blocked, mexc_vol_usd=vol_buy,
                        gate_vol_usd=vol_sell)

    def summary(self) -> dict:
        return {"gaps": [g.as_dict() for g in self.gaps],
                "executable": sum(1 for g in self.gaps if g.executable),
                "note": ("Executable means balances exist on both venues right "
                         "now and the gap survives a depth walk at that size. "
                         "Everything else is intel: a transfer takes longer "
                         "than the gap lives.")}
