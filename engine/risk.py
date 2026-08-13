"""Rails, inventory ledger, and the kill switch.

Every check here is evaluated **on the order path**, immediately before each
leg leaves — not once at signal time. A signal that cleared the rails 40 ms ago
is not a permission slip: balances move, the daily counter moves, and the STOP
file can appear between the decision and the third leg.

The ledger is the part the polling desk never had. A triangle that dies on leg 3
leaves real inventory in a real asset, and until that is unwound the engine is
not flat. `RiskEngine.stranded_usd` is what the kill switch actually watches,
because a bot that keeps trading while quietly accumulating micro-cap inventory
is not running a strategy — it is buying a bag one failed cycle at a time.
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Iterable

from .clock import now_ns, wall_ms
from .config import RiskLimits

__all__ = ["RiskEngine", "RiskVerdict", "Position", "Ledger"]


@dataclass(slots=True)
class RiskVerdict:
    ok: bool
    reason: str = ""
    size_usd: float = 0.0

    def __bool__(self) -> bool:
        return self.ok


@dataclass
class Position:
    asset: str
    qty: float = 0.0
    cost_usd: float = 0.0        # what we paid to acquire the current qty
    opened_ns: int = 0

    @property
    def open(self) -> bool:
        return abs(self.qty) > 1e-12


class Ledger:
    """Inventory by asset plus a rolling record of realized PnL."""

    def __init__(self, quote: str = "USDT") -> None:
        self.quote = quote
        self.positions: dict[str, Position] = defaultdict(lambda: Position(""))
        self.realized_usd = 0.0
        self.fills = 0
        self.marks: dict[str, float] = {}     # asset -> last USD price

    def credit(self, asset: str, qty: float, cost_usd: float = 0.0) -> None:
        if asset == self.quote:
            return
        p = self.positions[asset]
        p.asset = asset
        if not p.open:
            p.opened_ns = now_ns()
        p.qty += qty
        p.cost_usd += cost_usd
        self.fills += 1

    def debit(self, asset: str, qty: float, proceeds_usd: float = 0.0) -> None:
        if asset == self.quote:
            return
        p = self.positions[asset]
        p.asset = asset
        released = 0.0
        if p.qty > 1e-18:
            frac = min(1.0, qty / p.qty)
            released = p.cost_usd * frac
            p.cost_usd -= released
        p.qty -= qty
        if abs(p.qty) < 1e-12:
            p.qty = 0.0
            p.cost_usd = 0.0
        self.realized_usd += proceeds_usd - released
        self.fills += 1

    def mark(self, asset: str, usd_price: float) -> None:
        if usd_price > 0:
            self.marks[asset] = usd_price

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.open]

    def stranded_usd(self) -> float:
        """Inventory valued at the last mark, falling back to acquisition cost.

        Falling back to cost is deliberately *pessimistic about our knowledge*,
        not about the price: an unmarked micro-cap is exactly the case where we
        should assume the position is as big as we paid for it.
        """
        total = 0.0
        for p in self.open_positions():
            px = self.marks.get(p.asset, 0.0)
            total += abs(p.qty * px) if px > 0 else abs(p.cost_usd)
        return total

    def snapshot(self) -> dict:
        return {
            "realizedUsd": round(self.realized_usd, 6),
            "strandedUsd": round(self.stranded_usd(), 4),
            "fills": self.fills,
            "positions": [{"asset": p.asset, "qty": p.qty,
                           "costUsd": round(p.cost_usd, 4),
                           "ageS": round((now_ns() - p.opened_ns) / 1e9, 1)}
                          for p in self.open_positions()],
        }


class RiskEngine:
    """The gate every order passes through."""

    def __init__(self, limits: RiskLimits, quote: str = "USDT",
                 journal_path: str | None = None) -> None:
        self.limits = limits
        self.quote = quote
        self.ledger = Ledger(quote)
        self.journal_path = journal_path
        self._day_stakes: deque[tuple[float, float]] = deque()   # (ts, usd)
        self._day_pnl: deque[tuple[float, float]] = deque()
        self.open_cycles = 0
        self._symbol_leases: dict[str, int] = defaultdict(int)
        self.balances: dict[str, float] = {}
        self.halted = False
        self.halt_reason = ""
        self.rejections: dict[str, int] = defaultdict(int)

    # ---------------------------------------------------------------- state

    def set_balances(self, balances: dict[str, float]) -> None:
        self.balances = dict(balances)

    def _prune(self) -> None:
        cutoff = time.time() - 86400
        while self._day_stakes and self._day_stakes[0][0] < cutoff:
            self._day_stakes.popleft()
        while self._day_pnl and self._day_pnl[0][0] < cutoff:
            self._day_pnl.popleft()

    @property
    def staked_today(self) -> float:
        self._prune()
        return sum(v for _, v in self._day_stakes)

    @property
    def pnl_today(self) -> float:
        self._prune()
        return sum(v for _, v in self._day_pnl)

    def stop_file_present(self) -> bool:
        return bool(self.limits.stop_file) and os.path.exists(self.limits.stop_file)

    def halt(self, reason: str) -> None:
        """Trip the switch and persist it, so a restart does not resume."""
        self.halted = True
        self.halt_reason = reason
        try:
            os.makedirs(os.path.dirname(self.limits.stop_file), exist_ok=True)
            with open(self.limits.stop_file, "w") as f:
                f.write(f"halted {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}: "
                        f"{reason}\n")
        except OSError:
            pass
        self._journal({"action": "HALT", "reason": reason})

    def resume(self) -> None:
        """Clear the in-memory halt. Does NOT delete the STOP file — removing
        that is a human's job, on purpose."""
        self.halted = False
        self.halt_reason = ""

    # ------------------------------------------------------------- decisions

    def check_cycle(self, size_usd: float, bps: float, signal_age_ms: float,
                    book_age_ms: float, symbols: Iterable[str]) -> RiskVerdict:
        """Full pre-trade gate. Returns the size that is actually permitted."""
        if self.halted:
            return self._no("halted:" + self.halt_reason)
        if self.stop_file_present():
            self.halted = True
            self.halt_reason = "STOP file"
            return self._no("stop-file")

        lim = self.limits
        if bps < lim.min_edge_bps:
            return self._no(f"edge {bps:.1f} < {lim.min_edge_bps} bps")
        if signal_age_ms > lim.max_signal_age_ms:
            return self._no(f"signal {signal_age_ms:.0f}ms old")
        if book_age_ms > lim.max_book_age_ms:
            return self._no(f"book {book_age_ms:.0f}ms stale")
        if self.open_cycles >= lim.max_open_cycles:
            return self._no("max open cycles")

        syms = list(symbols)
        for s in syms:
            if self._symbol_leases[s] >= lim.max_inflight_per_symbol:
                return self._no(f"{s} already in flight")

        stranded = self.ledger.stranded_usd()
        if stranded > lim.max_stranded_usd:
            self.halt(f"stranded inventory ${stranded:.2f} > ${lim.max_stranded_usd:.2f}")
            return self._no("stranded inventory")

        if self.pnl_today <= -abs(lim.max_daily_loss_usd):
            self.halt(f"daily loss ${self.pnl_today:.2f}")
            return self._no("daily loss limit")

        budget = min(lim.max_daily_stake_usd - self.staked_today, lim.bankroll_usd)
        allowed = min(size_usd, lim.max_stake_per_cycle_usd, budget)
        if allowed < 1.0:
            return self._no(f"budget exhausted (${budget:.2f} left)")

        free = self.balances.get(self.quote)
        if free is not None and free < allowed:
            allowed = free
            if allowed < 1.0:
                return self._no(f"insufficient {self.quote} balance")

        # Never silently shrink below the depth-verified size: the edge was
        # computed at `size_usd` and a different size is a different trade.
        if allowed < size_usd - 1e-9:
            return self._no(f"cap {allowed:.2f} < verified size {size_usd:.2f}")

        return RiskVerdict(True, "", allowed)

    def _no(self, reason: str) -> RiskVerdict:
        self.rejections[reason.split(":")[0].split(" ")[0]] += 1
        return RiskVerdict(False, reason, 0.0)

    def check_leg(self, symbol: str, notional_usd: float) -> RiskVerdict:
        """Per-leg gate — cheap, and re-checks the things that can flip mid-cycle."""
        if self.halted:
            return RiskVerdict(False, "halted")
        if self.stop_file_present():
            self.halted = True
            self.halt_reason = "STOP file"
            return RiskVerdict(False, "stop-file")
        if notional_usd > self.limits.max_stake_per_cycle_usd * 1.5:
            return RiskVerdict(False, f"leg notional ${notional_usd:.2f} out of band")
        return RiskVerdict(True, "", notional_usd)

    # ----------------------------------------------------------- bookkeeping

    def lease(self, symbols: Iterable[str]) -> None:
        self.open_cycles += 1
        for s in symbols:
            self._symbol_leases[s] += 1

    def release(self, symbols: Iterable[str]) -> None:
        self.open_cycles = max(0, self.open_cycles - 1)
        for s in symbols:
            self._symbol_leases[s] = max(0, self._symbol_leases[s] - 1)

    def record_stake(self, usd: float) -> None:
        self._day_stakes.append((time.time(), usd))

    def record_pnl(self, usd: float) -> None:
        self._day_pnl.append((time.time(), usd))
        if self.pnl_today <= -abs(self.limits.max_daily_loss_usd):
            self.halt(f"daily loss ${self.pnl_today:.2f}")

    def _journal(self, event: dict) -> None:
        if not self.journal_path:
            return
        try:
            os.makedirs(os.path.dirname(self.journal_path), exist_ok=True)
            with open(self.journal_path, "a") as f:
                f.write(json.dumps({"t": wall_ms(), **event}) + "\n")
        except OSError:
            pass

    def snapshot(self) -> dict:
        return {
            "halted": self.halted, "haltReason": self.halt_reason,
            "openCycles": self.open_cycles,
            "stakedToday": round(self.staked_today, 2),
            "pnlToday": round(self.pnl_today, 4),
            "limits": self.limits.as_dict(),
            "ledger": self.ledger.snapshot(),
            "rejections": dict(self.rejections),
        }
