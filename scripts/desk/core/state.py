#!/usr/bin/env python3
"""Durable portfolio state, written to survive a killed process.

These desks run as CI shifts: a two-hour job that can be cancelled by a
concurrency group, evicted by a runner timeout, or killed between the
moment an order is accepted and the moment its fill is known. State that
only lives in memory is state that gets replayed as a second order.

So every mutation is journalled and then snapshotted atomically. The
journal is append-only and is the record of what was intended; the
snapshot is the current truth and is written via a temp file and rename,
which is atomic on POSIX. A process that dies mid-write leaves either the
old snapshot or the new one, never half of either.

Positions carry the identifiers the live executor needs to reconcile — the
client order id it submitted under, whether that order was confirmed
filled, and how much actually filled — because "I sent an order" and "I
have a position" are different facts and conflating them is how a crashed
bot ends up double-sized.
"""
import json
import os
import time
from dataclasses import dataclass, field, asdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
STATE_DIR = os.path.join(BASE, "data", "desk")


@dataclass
class Position:
    symbol: str
    desk: str
    side: str                      # long | short
    shares: float = 0.0
    entry: float = 0.0
    opened_at: int = 0
    cost: float = 0.0
    open_fee: float = 0.0
    # Live-mirroring fields. None/absent means paper-only.
    live_cid: str = ""             # client order id of the opening order
    live_open: bool = False        # a fill was CONFIRMED, not merely submitted
    live_qty: float = 0.0          # what actually filled, which may be partial
    live_final: bool = False       # the opening order reached a terminal state
    live_dead: bool = False        # confirmed never to have landed
    mirror_attempts: int = 0
    close_cid: str = ""

    def to_dict(self):
        return asdict(self)


@dataclass
class ClosedTrade:
    symbol: str
    desk: str
    side: str
    shares: float
    entry: float
    exit: float
    opened_at: int
    closed_at: int
    pnl: float
    fees: float
    reason: str

    def to_dict(self):
        return asdict(self)


@dataclass
class DeskState:
    """One account's book. Shared across desks; `desk` tags ownership."""
    bankroll_start: float = 1000.0
    cash: float = 1000.0
    positions: list = field(default_factory=list)
    closed: list = field(default_factory=list)
    equity_curve: list = field(default_factory=list)
    created_at: int = 0
    updated_at: int = 0
    trade_count: int = 0
    mode: str = "paper"            # paper | live-paper-endpoint | live-real-money

    def equity(self, marks):
        eq = self.cash
        for p in self.positions:
            px = marks.get(p["symbol"] if isinstance(p, dict) else p.symbol)
            if px:
                sh = p["shares"] if isinstance(p, dict) else p.shares
                eq += sh * px
        return eq


def _path(name):
    return os.path.join(STATE_DIR, name)


def load(name="state.json", bankroll=1000.0):
    """Read the snapshot, or a fresh book if there is none."""
    try:
        with open(_path(name)) as f:
            blob = json.load(f)
    except (OSError, ValueError):
        now = int(time.time())
        return DeskState(bankroll_start=float(bankroll), cash=float(bankroll),
                         created_at=now, updated_at=now)
    st = DeskState()
    st.bankroll_start = blob.get("bankrollStart", bankroll)
    st.cash = blob.get("cash", bankroll)
    st.positions = blob.get("positions", [])
    st.closed = blob.get("closed", [])
    st.equity_curve = blob.get("equityCurve", [])
    st.created_at = blob.get("createdAt", int(time.time()))
    st.updated_at = blob.get("updatedAt", 0)
    st.trade_count = blob.get("tradeCount", len(st.closed))
    st.mode = blob.get("mode", "paper")
    return st


def save(st, name="state.json"):
    """Atomic snapshot. Temp file plus rename — never a partial file."""
    os.makedirs(STATE_DIR, exist_ok=True)
    st.updated_at = int(time.time())
    path = _path(name)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({
            "bankrollStart": st.bankroll_start,
            "cash": round(st.cash, 6),
            "positions": st.positions,
            "closed": st.closed[-300:],
            "equityCurve": st.equity_curve[-1000:],
            "createdAt": st.created_at,
            "updatedAt": st.updated_at,
            "tradeCount": st.trade_count,
            "mode": st.mode,
        }, f, indent=1)
    os.replace(tmp, path)
    return path


def journal(event, payload, name="journal.jsonl"):
    """Append-only record of intent, written BEFORE the action it describes.

    The ordering matters: a client order id is journalled before the order
    is submitted, so a process killed between the two still knows on restart
    which id to reconcile against. A journal written after the fact would
    lose exactly the case it exists to cover.
    """
    os.makedirs(STATE_DIR, exist_ok=True)
    line = {"t": int(time.time()), "event": event, **(payload or {})}
    with open(_path(name), "a") as f:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return line


def read_journal(name="journal.jsonl", limit=500):
    try:
        with open(_path(name)) as f:
            lines = f.readlines()[-limit:]
    except OSError:
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out
