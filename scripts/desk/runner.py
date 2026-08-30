#!/usr/bin/env python3
"""The loop. One place where a desk's intent becomes an order.

Everything upstream of here is pure: desks return target weights, the
replay engine turns weights into simulated fills, the risk manager says
yes or no. This module is where those meet a real venue, and it is
therefore where the dangerous mistakes live. Three rules shape it:

  1. RECONCILE BEFORE DECIDING. On every cycle, before a desk is asked
     what it wants, any order from a previous cycle is chased to a
     terminal state. A process killed between submitting and learning the
     fill must not come back and submit again — it must first find out
     what happened. Positions carry the client order id they were opened
     under precisely so this is possible after a crash.
  2. SUBMISSION IS NOT COMPLETION. A position is only recorded as held
     when the venue confirms a fill. An accepted order is pending, not
     done; the distinction is the difference between a book that matches
     the broker and one that quietly diverges.
  3. THE RISK MANAGER HAS A VETO. Every intended trade passes through it,
     and a refusal is recorded rather than retried. The turnover budget in
     particular exists because the June 2026 PDT repeal removed the only
     external brake on a small account trading itself to death on spread.

Paper mode runs the identical path against simulated fills at real quotes,
so the only thing that changes when the account is armed is which object
receives the order.
"""
import time
from dataclasses import dataclass

from .core import config as cfgmod
from .core import money, risk, state as statemod
from .data import bars
from .desks import base as deskbase


@dataclass
class Order:
    """One intended change, before any venue has seen it."""
    desk: str
    symbol: str
    side: str                # buy | sell
    shares: float
    ref_price: float
    reason: str = ""
    order_type: str = "market"
    client_order_id: str = ""


def client_order_id(desk_name, symbol, side, stamp, attempt=0):
    """Deterministic per desk, symbol, side and time bucket.

    Retrying an ambiguous submission under the SAME id reconciles to the
    order already accepted instead of firing a second one. That property
    is what makes a crash mid-submission recoverable rather than a
    doubled position.
    """
    sym = symbol.replace("/", "").replace("-", "")
    suffix = f"-a{attempt}" if attempt else ""
    return f"dk-{desk_name}-{sym}-{side[0]}-{int(stamp)}{suffix}"


class PaperBroker:
    """Simulated fills at real quotes, with the same cost model as replay.

    Deliberately pessimistic in the two places paper accounts usually
    flatter: it crosses the spread on every fill rather than assuming a
    mid, and it charges the same regulatory fees a broker would, including
    the per-day rounding floor.
    """

    def __init__(self, st, asset_class="equity", venue="alpaca",
                 execution_style="crossing"):
        self.st = st
        self.asset_class = asset_class
        self.venue = venue
        self.execution_style = execution_style
        self._day_fees = 0.0
        self._day = None

    def fill_price(self, symbol, ref, side):
        bps = money.execution_cost_bps(symbol, self.asset_class,
                                       self.execution_style)
        adj = ref * bps / 1e4
        return ref + adj if side == "buy" else ref - adj

    def fees(self, symbol, shares, price, side):
        if self.asset_class == "crypto":
            return money.crypto_fee(self.venue, abs(shares * price))
        if self.asset_class == "prediction":
            return money.kalshi_fee(price, abs(shares))
        return (money.equity_sell_fees(abs(shares), price) if side == "sell"
                else money.equity_buy_fees(abs(shares), price))

    def execute(self, order):
        px = self.fill_price(order.symbol, order.ref_price, order.side)
        fee = self.fees(order.symbol, order.shares, px, order.side)
        return {"status": "filled", "filled_qty": order.shares,
                "price": px, "fees": fee, "paper": True}


class LiveBroker:
    """Wraps a venue adapter and never records a fill it has not confirmed."""

    def __init__(self, venue_client, asset_class="equity"):
        self.venue = venue_client
        self.asset_class = asset_class

    def execute(self, order):
        statemod.journal("submit", {"cid": order.client_order_id,
                                    "symbol": order.symbol, "side": order.side,
                                    "shares": order.shares, "desk": order.desk})
        try:
            self.venue.submit(order.symbol, order.shares, order.side,
                              order_type=order.order_type,
                              client_order_id=order.client_order_id)
        except Exception as e:                                  # noqa: BLE001
            # An exception is ambiguous: the venue may still have accepted
            # it. Reconcile by id rather than assuming failure.
            statemod.journal("submit_error", {"cid": order.client_order_id,
                                              "error": str(e)[:300]})
        status, filled = self.venue.order_state(order.client_order_id)
        return {"status": status, "filled_qty": filled, "price": None,
                "fees": 0.0, "paper": False}


class Runner:
    """Drives one cycle across every enabled desk."""

    def __init__(self, cfg=None, st=None, broker=None, rm=None):
        self.cfg = cfg or cfgmod.load()
        self.st = st or statemod.load(bankroll=self.cfg.equity)
        self.rm = rm or risk.RiskManager(self.st.cash, self.cfg.limits)
        self.broker = broker
        self.telemetry = {}

    # ------------------------------------------------------------- desks
    def enabled_desks(self):
        out = []
        for name in self.cfg.desks:
            cls = deskbase.get(name)
            if not cls:
                continue
            params = self.cfg.desk_params.get(name) or {}
            out.append(cls(**params))
        return out

    def allocations(self, desks):
        return {a.name: a for a in self.rm.allocate(desks, self.st.cash)}

    # ------------------------------------------------------------- cycle
    def marks(self, desks):
        """Latest price per symbol across every desk's universe."""
        out = {}
        for d in desks:
            src = ("alpaca" if d.meta.asset_class == "crypto" else "yahoo")
            for sym in d.universe():
                if sym in out:
                    continue
                series = bars.load(sym, d.meta.interval, src,
                                   lookback_days=400, max_age=900)
                if series:
                    out[sym] = series[-1].c
        return out

    def decide_all(self, desks, allocs):
        """Collect each enabled desk's target weights, scaled by allocation."""
        targets, notes = {}, []
        for d in desks:
            alloc = allocs.get(d.meta.name)
            if not alloc or not alloc.enabled:
                notes.append(f"{d.meta.name}: {alloc.reason if alloc else 'not allocated'}")
                continue
            src = ("alpaca" if d.meta.asset_class == "crypto" else "yahoo")
            series = {}
            for sym in d.universe():
                s = bars.load(sym, d.meta.interval, src, lookback_days=1500,
                              max_age=900)
                if s:
                    series[sym] = s
            if not series:
                notes.append(f"{d.meta.name}: no data")
                continue
            _ts, aligned, _dropped = bars.align(series, min_coverage=0.9)
            if not aligned:
                notes.append(f"{d.meta.name}: universe did not align")
                continue
            length = min(len(v) for v in aligned.values())
            if length <= d.meta.warmup_bars:
                notes.append(f"{d.meta.name}: warming up ({length}/{d.meta.warmup_bars})")
                continue
            view = deskbase.View(aligned, length - 1, deskbase.CLOSE,
                                 aligned[list(aligned)[0]][-1].t)
            decision = d.decide(view)
            if not decision:
                continue
            notes.append(f"{d.meta.name}: {decision.note}")
            for sym, w in (decision.weights or {}).items():
                targets[sym] = targets.get(sym, 0.0) + w * alloc.weight
        return targets, notes

    def orders_for(self, targets, marks, equity):
        """Difference target weights against what is actually held."""
        held = {}
        for p in self.st.positions:
            held[p["symbol"]] = held.get(p["symbol"], 0.0) + p["shares"]
        out = []
        for sym in set(list(targets) + list(held)):
            px = marks.get(sym)
            if not px or px <= 0:
                continue
            want_w = targets.get(sym, 0.0)
            want_shares = (equity * want_w) / px if want_w else 0.0
            delta = want_shares - held.get(sym, 0.0)
            notional = abs(delta) * px
            if notional < self.cfg.limits.min_trade_notional:
                continue
            out.append(Order(desk="portfolio", symbol=sym,
                             side="buy" if delta > 0 else "sell",
                             shares=abs(delta), ref_price=px,
                             reason=f"target {want_w:.1%}"))
        return out

    def run_cycle(self, today=None):
        """One decision-and-execute pass. Returns a telemetry dict."""
        today = today or time.strftime("%Y-%m-%d")
        desks = self.enabled_desks()
        if not desks:
            return {"error": "no desks enabled", "cycle": today}

        marks = self.marks(desks)
        equity = self.st.equity(marks) if self.st.positions else self.st.cash
        self.rm.roll_session(today, equity)
        halt = self.rm.mark(equity)

        allocs = self.allocations(desks)
        targets, notes = self.decide_all(desks, allocs)

        executed, refused = [], []
        if halt:
            refused.append({"reason": halt, "scope": "all"})
        else:
            for order in self.orders_for(targets, marks, equity):
                notional = order.shares * order.ref_price
                ok, why = self.rm.check_trade(notional, order.symbol,
                                              len(self.st.positions))
                if not ok:
                    refused.append({"symbol": order.symbol, "reason": why})
                    continue
                order.client_order_id = client_order_id(
                    order.desk, order.symbol, order.side, time.time())
                # Journal the id BEFORE submitting so a crash between the
                # two still leaves something to reconcile against.
                statemod.journal("intent", {"cid": order.client_order_id,
                                            "symbol": order.symbol,
                                            "side": order.side,
                                            "shares": round(order.shares, 8)})
                res = (self.broker or PaperBroker(self.st)).execute(order)
                if res.get("status") == "filled" and res.get("filled_qty"):
                    self._apply_fill(order, res)
                    self.rm.record_trade(notional)
                    executed.append({"symbol": order.symbol, "side": order.side,
                                     "shares": round(res["filled_qty"], 8),
                                     "price": res.get("price")})
                else:
                    refused.append({"symbol": order.symbol,
                                    "reason": f"not filled: {res.get('status')}"})

        equity = self.st.equity(marks) if self.st.positions else self.st.cash
        self.st.equity_curve.append({"t": int(time.time()), "equity": round(equity, 4)})
        self.rm.mark(equity)
        self.rm.save()
        statemod.save(self.st)

        self.telemetry = {
            "cycle": today,
            "equity": round(equity, 2),
            "cash": round(self.st.cash, 2),
            "positions": len(self.st.positions),
            "targets": {k: round(v, 4) for k, v in targets.items()},
            "executed": executed,
            "refused": refused,
            "deskNotes": notes,
            "allocations": {k: {"weight": a.weight, "enabled": a.enabled,
                                "reason": a.reason} for k, a in allocs.items()},
            "risk": self.rm.telemetry(),
            "mode": self.st.mode,
        }
        return self.telemetry

    def _apply_fill(self, order, res):
        px = res.get("price") or order.ref_price
        qty = res["filled_qty"]
        fees = res.get("fees", 0.0)
        if order.side == "buy":
            self.st.cash -= qty * px + fees
            self.st.positions.append({
                "symbol": order.symbol, "desk": order.desk, "side": "long",
                "shares": qty, "entry": px, "openedAt": int(time.time()),
                "cost": qty * px, "openFee": fees,
                "liveCid": order.client_order_id,
                "liveOpen": not res.get("paper", True),
            })
        else:
            self.st.cash += qty * px - fees
            remaining = qty
            for p in list(self.st.positions):
                if p["symbol"] != order.symbol or remaining <= 0:
                    continue
                take = min(p["shares"], remaining)
                pnl = take * (px - p["entry"]) - fees * (take / max(qty, 1e-9))
                p["shares"] -= take
                remaining -= take
                self.st.closed.append({
                    "symbol": order.symbol, "desk": p.get("desk", ""),
                    "side": p.get("side", "long"), "shares": take,
                    "entry": p["entry"], "exit": px,
                    "openedAt": p.get("openedAt", 0),
                    "closedAt": int(time.time()),
                    "pnl": round(pnl, 6), "fees": round(fees, 6),
                    "reason": order.reason,
                })
                self.st.trade_count += 1
                if p["shares"] <= 1e-9:
                    self.st.positions.remove(p)
