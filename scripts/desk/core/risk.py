#!/usr/bin/env python3
"""Portfolio risk: allocation, halts, and a turnover budget.

The turnover budget is the load-bearing idea here, and it comes from a
specific regulatory change. Until June 2026 the pattern-day-trader rule
capped a sub-$25,000 account at three day trades per five business days.
That rule was repealed. It had been, perversely, the main thing protecting
small accounts from themselves — because the binding constraint on a $40 or
$500 account was never the regulation, it was the spread:

    a $40 position in a $20 stock with a one-cent spread costs ~5bps per
    round trip. Five round trips a day for 250 days is 1,250 round trips,
    which is roughly 62% of starting capital consumed by spread alone. Ten a
    day exceeds 100%. No signal survives that.

With the regulatory brake gone, the strategy has to supply its own. Every
desk gets an explicit annual turnover allowance sized to its capital, and
`TurnoverBudget` refuses trades that would exceed it. A desk that wants to
trade more than its budget is told no, and the refusal is recorded rather
than hidden, so the dashboard shows when a strategy is straining its own
economics.

The second idea is the capital floor. US equity regulatory fees are
aggregated per day per fee type and rounded up to the cent, so any day with
any trading costs at least $0.03. Measured on the overnight desk over ten
years, that floor alone takes a $40 account to zero while the same strategy
compounds at 9.6% on $1,000. Desks declare a floor; the allocator refuses to
fund them below it instead of letting the fees quietly eat the account.
"""
import json
import os
import time
from dataclasses import dataclass, field, asdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
STOP_FILE = os.path.join(BASE, "data", "desk", "STOP")


class Halted(Exception):
    """Raised when trading is not permitted right now."""


@dataclass
class RiskLimits:
    """Hard limits. Defaults are deliberately tight for a small account."""
    max_gross_exposure: float = 1.0        # of equity, summed across desks
    max_desk_weight: float = 0.5           # any one desk's share of equity
    max_position_weight: float = 0.35      # any one symbol
    daily_loss_halt: float = 0.04          # flatten and stop for the session
    weekly_loss_halt: float = 0.10
    max_drawdown_halt: float = 0.25        # from peak equity — stop everything
    # Annualized turnover allowance as a multiple of equity. 12x means the
    # book may turn over once a month on average. A daily in-and-out desk
    # runs ~500x, which is only survivable when execution is in the auction
    # and the account is large enough to absorb the fee floor.
    max_annual_turnover: float = 60.0
    min_trade_notional: float = 1.0        # skip dust that only pays fees
    max_open_positions: int = 8

    def to_dict(self):
        return asdict(self)


@dataclass
class TurnoverBudget:
    """Rolling turnover accounting against an annual allowance."""
    allowance_x: float = 60.0
    window_days: float = 365.0
    events: list = field(default_factory=list)   # [(ts, notional)]
    refused: int = 0
    refused_notional: float = 0.0

    def _prune(self, now):
        cutoff = now - self.window_days * 86400
        self.events = [(t, n) for t, n in self.events if t >= cutoff]

    def used(self, now=None):
        now = now or time.time()
        self._prune(now)
        return sum(n for _, n in self.events)

    def remaining(self, equity, now=None):
        return max(0.0, self.allowance_x * equity - self.used(now))

    def allows(self, notional, equity, now=None):
        return notional <= self.remaining(equity, now) + 1e-9

    def record(self, notional, now=None):
        self.events.append((now or time.time(), abs(notional)))

    def refuse(self, notional):
        self.refused += 1
        self.refused_notional += abs(notional)

    def utilization(self, equity, now=None):
        cap = self.allowance_x * max(equity, 1e-9)
        return self.used(now) / cap if cap > 0 else 0.0


@dataclass
class DeskAllocation:
    """How much of the account one desk is permitted to run."""
    name: str
    weight: float                 # share of total equity
    enabled: bool = True
    reason: str = ""


class RiskManager:
    """Owns the account-level view across desks.

    Deliberately conservative about state: every mutation is written through
    to disk, because a CI shift can be killed mid-session and the next shift
    must know that the desk halted rather than starting fresh and re-losing
    the same money.
    """

    def __init__(self, equity, limits=None, state_path=None):
        self.limits = limits or RiskLimits()
        self.equity = float(equity)
        self.peak_equity = float(equity)
        self.state_path = state_path or os.path.join(
            BASE, "data", "desk", "risk-state.json")
        self.budget = TurnoverBudget(allowance_x=self.limits.max_annual_turnover)
        self.day = {"date": None, "start_equity": float(equity),
                    "pnl": 0.0, "halted": False, "trades": 0}
        self.week = {"start": None, "start_equity": float(equity)}
        self.halt_reason = ""
        self._load()

    # ------------------------------------------------------------- state
    def _load(self):
        try:
            with open(self.state_path) as f:
                blob = json.load(f)
        except (OSError, ValueError):
            return
        self.peak_equity = blob.get("peakEquity", self.peak_equity)
        self.day = blob.get("day", self.day)
        self.week = blob.get("week", self.week)
        self.halt_reason = blob.get("haltReason", "")
        b = blob.get("budget") or {}
        self.budget.events = [tuple(e) for e in b.get("events", [])]
        self.budget.refused = b.get("refused", 0)
        self.budget.refused_notional = b.get("refusedNotional", 0.0)

    def save(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({
                "updatedAt": int(time.time()),
                "equity": round(self.equity, 4),
                "peakEquity": round(self.peak_equity, 4),
                "day": self.day, "week": self.week,
                "haltReason": self.halt_reason,
                "budget": {"events": self.budget.events,
                           "refused": self.budget.refused,
                           "refusedNotional": round(self.budget.refused_notional, 4)},
            }, f, indent=1)
        os.replace(tmp, self.state_path)

    # ------------------------------------------------------------- gates
    def stop_file_present(self):
        return os.path.exists(STOP_FILE)

    def roll_session(self, today, equity):
        """Start a new session. Clears the daily halt; drawdown halts persist."""
        self.equity = float(equity)
        self.peak_equity = max(self.peak_equity, self.equity)
        if self.day.get("date") != today:
            self.day = {"date": today, "start_equity": self.equity,
                        "pnl": 0.0, "halted": False, "trades": 0}
        if self.week.get("start") is None:
            self.week = {"start": today, "start_equity": self.equity}

    def mark(self, equity):
        """Update equity and evaluate the halts. Returns the halt reason or ''."""
        self.equity = float(equity)
        self.peak_equity = max(self.peak_equity, self.equity)
        d0 = self.day.get("start_equity") or self.equity
        self.day["pnl"] = self.equity - d0

        if self.stop_file_present():
            self.halt_reason = "STOP file present"
            return self.halt_reason
        if self.peak_equity > 0 and \
                self.equity / self.peak_equity - 1 <= -abs(self.limits.max_drawdown_halt):
            self.halt_reason = (
                f"drawdown {100*(self.equity/self.peak_equity-1):.1f}% breached the "
                f"{100*self.limits.max_drawdown_halt:.0f}% limit")
            return self.halt_reason
        if d0 > 0 and self.equity / d0 - 1 <= -abs(self.limits.daily_loss_halt):
            self.day["halted"] = True
            self.halt_reason = (
                f"daily loss {100*(self.equity/d0-1):.1f}% hit the "
                f"{100*self.limits.daily_loss_halt:.0f}% halt")
            return self.halt_reason
        w0 = self.week.get("start_equity") or self.equity
        if w0 > 0 and self.equity / w0 - 1 <= -abs(self.limits.weekly_loss_halt):
            self.halt_reason = (
                f"weekly loss {100*(self.equity/w0-1):.1f}% hit the "
                f"{100*self.limits.weekly_loss_halt:.0f}% halt")
            return self.halt_reason
        self.halt_reason = ""
        return ""

    def can_trade(self):
        return not self.halt_reason and not self.day.get("halted")

    def check_trade(self, notional, symbol="", open_positions=0):
        """Approve or refuse one intended trade. Returns (ok, reason)."""
        if not self.can_trade():
            return False, self.halt_reason or "session halted"
        n = abs(notional)
        if n < self.limits.min_trade_notional:
            return False, f"below minimum trade notional ${self.limits.min_trade_notional:.2f}"
        if n > self.equity * self.limits.max_position_weight * 1.02:
            return False, (f"position would be {n/max(self.equity,1e-9):.0%} of equity, "
                           f"over the {self.limits.max_position_weight:.0%} cap")
        if open_positions >= self.limits.max_open_positions:
            return False, f"already at {open_positions} open positions"
        if not self.budget.allows(n, self.equity):
            self.budget.refuse(n)
            used = self.budget.used()
            return False, (f"turnover budget exhausted: ${used:,.0f} of "
                           f"${self.limits.max_annual_turnover * self.equity:,.0f} "
                           f"used in the trailing year")
        return True, ""

    def record_trade(self, notional):
        self.budget.record(abs(notional))
        self.day["trades"] = self.day.get("trades", 0) + 1

    # -------------------------------------------------------- allocation
    def allocate(self, desks, equity=None, explicit_desks=()):
        """Split equity across desks, refusing any below its capital floor,
        any the author rejected, and any marginal desk not named explicitly.

        A desk funded under its floor does not lose slowly — on a daily
        equity strategy the fee floor takes it to zero. Refusing is the only
        honest response, and the reason is carried through to the dashboard.
        """
        eq = float(equity if equity is not None else self.equity)
        explicit = lambda name: name in set(explicit_desks or ())
        out, eligible = [], []
        for d in desks:
            floor = getattr(d.meta, "capital_floor", 0.0)
            status = getattr(d.meta, "status", "validated")
            if status == "rejected":
                out.append(DeskAllocation(
                    d.meta.name, 0.0, False,
                    "rejected by its own study: " + getattr(d.meta, "status_reason", "")))
                continue
            if status == "marginal" and not explicit(d.meta.name):
                out.append(DeskAllocation(
                    d.meta.name, 0.0, False,
                    "marginal — runs only when named explicitly in config: "
                    + getattr(d.meta, "status_reason", "")))
                continue
            if eq <= 0:
                out.append(DeskAllocation(d.meta.name, 0.0, False, "no equity"))
            elif floor > 0 and eq < floor:
                out.append(DeskAllocation(
                    d.meta.name, 0.0, False,
                    f"needs ${floor:,.0f}; account has ${eq:,.0f}. Below this the "
                    f"per-day fee floor consumes the edge."))
            else:
                eligible.append(d)

        if not eligible:
            return out
        share = min(self.limits.max_desk_weight, 1.0 / len(eligible))
        for d in eligible:
            out.append(DeskAllocation(d.meta.name, round(share, 4), True, ""))
        return out

    def telemetry(self):
        return {
            "equity": round(self.equity, 2),
            "peakEquity": round(self.peak_equity, 2),
            "drawdownPct": round((self.equity / self.peak_equity - 1) * 100, 2)
            if self.peak_equity else 0.0,
            "day": self.day,
            "haltReason": self.halt_reason,
            "canTrade": self.can_trade(),
            "turnover": {
                "usedUsd": round(self.budget.used(), 2),
                "allowanceUsd": round(self.limits.max_annual_turnover * self.equity, 2),
                "utilizationPct": round(self.budget.utilization(self.equity) * 100, 1),
                "refusedTrades": self.budget.refused,
            },
            "limits": self.limits.to_dict(),
        }
