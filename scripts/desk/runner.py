#!/usr/bin/env python3
"""The loop. The one place a desk's intent becomes an order.

Everything upstream is pure: desks return target weights, the replay engine
turns weights into simulated fills, the risk manager says yes or no. This
module is where those meet a real venue, so it is where the dangerous
mistakes live. Four rules shape it:

  1. RECONCILE BEFORE DECIDING. Every cycle begins by chasing any order
     from a previous cycle to a terminal state. A process killed between
     submitting and learning the fill must not come back and submit again;
     it must first find out what happened. Positions carry the client order
     id they were opened under so this is possible after a crash, and while
     anything is still pending no new order is placed.
  2. SUBMISSION IS NOT COMPLETION. A position is only booked when the venue
     confirms a fill, at the venue's fill price. An accepted order is
     pending, not done.
  3. THE VENUE'S CLOCK DECIDES THE WINDOW. Equity desks that trade the
     auctions only act in the minutes before each auction's cutoff — MOO
     before 09:28 ET, MOC before 15:50 ET — and hold otherwise. A desk that
     is not in its window keeps whatever it holds; it is not flattened.
     Crypto is 24/7 and acts on any cycle.
  4. THE RISK MANAGER HAS A VETO, and the turnover budget in particular
     exists because the June 2026 PDT repeal removed the only external
     brake on a small account trading itself to death on spread.

Paper mode runs the identical path against simulated fills at real quotes,
so the only thing that changes when the account is armed is which object
receives the order.
"""
import datetime as _dt
import time
from dataclasses import dataclass, field

from .core import config as cfgmod
from .core import money, risk, state as statemod
from .data import bars
from .desks import base as deskbase

# Submission windows, Eastern time. Chosen so an order is in comfortably
# before the exchange cutoff rather than racing it.
PRE_OPEN = ((9, 0), (9, 26))       # MOO cutoff 09:28
PRE_CLOSE = ((15, 30), (15, 48))   # MOC cutoff 15:50
FAILED = {"canceled", "expired", "rejected", "stopped", "suspended", "replaced",
          "done_for_day"}
MAX_ATTEMPTS = 3


def _et_tz():
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("America/New_York")
    except Exception:                                        # noqa: BLE001
        return _dt.timezone(_dt.timedelta(hours=-4))


def session_phase(now_et):
    """pre_open | open | pre_close | closed, on the venue's clock."""
    if now_et.weekday() >= 5:
        return "closed"
    hm = (now_et.hour, now_et.minute)
    if PRE_OPEN[0] <= hm <= PRE_OPEN[1]:
        return "pre_open"
    if PRE_CLOSE[0] <= hm <= PRE_CLOSE[1]:
        return "pre_close"
    if (9, 30) <= hm < (16, 0):
        return "open"
    return "closed"


def event_for(desk_meta, phase):
    """Which decision event a desk evaluates in this phase, or None to hold."""
    if desk_meta.asset_class == "crypto":
        return deskbase.CLOSE                       # 24/7: any cycle
    if desk_meta.asset_class == "prediction":
        return deskbase.CLOSE
    if phase == "pre_open" and deskbase.OPEN in desk_meta.events:
        return deskbase.OPEN
    if phase == "pre_close" and deskbase.CLOSE in desk_meta.events:
        return deskbase.CLOSE
    return None


def order_style(desk_meta, phase):
    """(order_type, time_in_force, whole_shares) the live venue must use.

    Mirrors the replay's cost model exactly: an auction desk sends cls/opg,
    which cannot be fractional; a crossing desk sends a market DAY order,
    which can; crypto sends market GTC. The backtest charged the matching
    cost, so live and replay cannot quietly diverge here.
    """
    if desk_meta.asset_class == "crypto":
        return "market", "gtc", False
    if desk_meta.execution_style == "auction":
        return ("opg" if phase == "pre_open" else "cls"), "day", True
    return "market", "day", not desk_meta.fractional


def client_order_id(desk_name, symbol, side, stamp, attempt=0):
    """Deterministic per desk, symbol, side and time bucket, so a retried
    ambiguous submission reconciles to the accepted order instead of firing
    a second one."""
    sym = symbol.replace("/", "").replace("-", "")
    suffix = f"-a{attempt}" if attempt else ""
    return f"dk-{desk_name}-{sym}-{side[0]}-{int(stamp)}{suffix}"


@dataclass
class Order:
    desk: str
    symbol: str
    side: str                    # buy | sell
    shares: float
    ref_price: float
    order_type: str = "market"
    time_in_force: str = "day"
    reason: str = ""
    client_order_id: str = ""
    attempt: int = 0


# ------------------------------------------------------------------ brokers
class PaperBroker:
    """Simulated fills at real quotes with the replay's cost model — and
    deliberately pessimistic where paper accounts usually flatter: it
    crosses the spread on every crossing fill and charges every fee."""

    def __init__(self, symbol_meta):
        self.symbol_meta = symbol_meta          # symbol -> DeskMeta

    def _meta(self, symbol):
        return self.symbol_meta.get(symbol)

    def execute(self, order):
        m = self._meta(order.symbol)
        cls = m.asset_class if m else "equity"
        style = (money.AUCTION if order.order_type in ("cls", "opg")
                 else money.CROSSING)
        bps = money.execution_cost_bps(order.symbol, cls, style)
        adj = order.ref_price * bps / 1e4
        px = order.ref_price + adj if order.side == "buy" else order.ref_price - adj
        if cls == "crypto":
            fee = money.crypto_fee(m.venue if m else "alpaca", order.shares * px)
        elif cls == "prediction":
            fee = money.kalshi_fee(px, order.shares)
        elif order.side == "sell":
            fee = money.equity_sell_fees(order.shares, px)
        else:
            fee = money.equity_buy_fees(order.shares, px)
        return {"status": "filled", "filled_qty": order.shares, "price": px,
                "fees": fee, "paper": True}


class LiveBroker:
    """Wraps a venue adapter. Never reports a fill it has not confirmed."""

    def __init__(self, venue, settle_seconds=6.0, poll=1.0):
        self.venue = venue
        self.settle_seconds = settle_seconds
        self.poll = poll

    def execute(self, order):
        statemod.journal("submit", {"cid": order.client_order_id, "symbol": order.symbol,
                                    "side": order.side, "shares": order.shares,
                                    "type": order.order_type, "desk": order.desk})
        try:
            self.venue.submit(order.symbol, order.shares, order.side,
                              order_type=order.order_type,
                              time_in_force=order.time_in_force,
                              client_order_id=order.client_order_id)
        except ValueError as e:
            # Client-side validation refused it: nothing reached the venue.
            statemod.journal("refused", {"cid": order.client_order_id, "error": str(e)[:300]})
            return {"status": "refused", "filled_qty": 0.0, "price": None,
                    "fees": 0.0, "paper": False, "error": str(e)}
        except Exception as e:                                 # noqa: BLE001
            # Ambiguous: the venue may have accepted it. Reconcile by id.
            statemod.journal("submit_error", {"cid": order.client_order_id,
                                              "error": str(e)[:300]})
        deadline = time.time() + self.settle_seconds
        status, filled, px = None, 0.0, None
        while True:
            status, filled, px = self.venue.order_state(order.client_order_id)
            if status == "filled" or status in FAILED or time.time() >= deadline:
                break
            time.sleep(self.poll)
        return {"status": status, "filled_qty": filled, "price": px,
                "fees": 0.0, "paper": False}


# ------------------------------------------------------------------- runner
class Runner:
    def __init__(self, cfg=None, st=None, broker=None, rm=None,
                 series_loader=None, clock=None):
        self.cfg = cfg or cfgmod.load()
        self.st = st or statemod.load(bankroll=self.cfg.equity)
        self.rm = rm or risk.RiskManager(self.st.cash, self.cfg.limits)
        self.broker = broker
        self.live = broker is not None and not isinstance(broker, PaperBroker)
        self._load = series_loader or self._default_loader
        self._clock = clock                     # () -> aware datetime, for tests
        self.telemetry = {}

    # --------------------------------------------------------------- setup
    @staticmethod
    def _default_loader(symbol, interval, source):
        return bars.load(symbol, interval, source, lookback_days=1500, max_age=900)

    def enabled_desks(self):
        out = []
        for name in self.cfg.desks:
            cls = deskbase.get(name)
            if cls:
                out.append(cls(**(self.cfg.desk_params.get(name) or {})))
        return out

    @staticmethod
    def symbol_meta(desks):
        """symbol -> owning desk's meta. Overlaps agree on execution style
        (both equity/auction or both equity/crossing) or the first wins and
        the telemetry says so."""
        out = {}
        for d in desks:
            for s in d.universe():
                out.setdefault(s, d.meta)
        return out

    def now_et(self):
        if self._clock:
            return self._clock()
        if self.live and hasattr(self.broker.venue, "now_et"):
            try:
                return self.broker.venue.now_et()
            except Exception:                                 # noqa: BLE001
                pass
        return _dt.datetime.now(_dt.timezone.utc).astimezone(_et_tz())

    def account_equity(self, marks):
        """Live: the venue's equity is the truth. Paper: local book."""
        if self.live and hasattr(self.broker.venue, "account"):
            try:
                eq = float(self.broker.venue.account().get("equity") or 0)
                if eq > 0:
                    return eq
            except Exception:                                 # noqa: BLE001
                pass
        return self.st.equity(marks) if self.st.positions else self.st.cash

    # ----------------------------------------------------------- reconcile
    def reconcile(self):
        """Chase every pending order to a terminal state. Returns True if
        anything is still pending, in which case this cycle does not trade."""
        if not self.live:
            return False
        pending = False
        for p in list(self.st.positions):
            # --- opening orders that have not been confirmed
            if p.get("liveCid") and not p.get("liveOpen") and not p.get("liveDead"):
                status, filled, px = self.broker.venue.order_state(p["liveCid"])
                if status == "filled" and filled > 0:
                    self._book_open(p, filled, px or p.get("entry") or 0.0)
                elif status in FAILED:
                    if filled > 0:
                        self._book_open(p, filled, px or p.get("entry") or 0.0)
                    else:
                        statemod.journal("open_dead", {"cid": p["liveCid"], "status": status})
                        self.st.positions.remove(p)
                elif status == "not_found":
                    attempt = int(p.get("mirrorAttempts", 0)) + 1
                    if attempt > MAX_ATTEMPTS:
                        statemod.journal("open_abandoned", {"cid": p["liveCid"]})
                        self.st.positions.remove(p)
                    else:
                        # Never landed: resubmit under a fresh attempt id.
                        p["mirrorAttempts"] = attempt
                        p["liveCid"] = client_order_id(p["desk"], p["symbol"], "buy",
                                                       p["openedAt"], attempt)
                        statemod.save(self.st)
                        o = Order(p["desk"], p["symbol"], "buy", p["targetShares"],
                                  p.get("entry") or 0.0, p.get("orderType", "market"),
                                  p.get("tif", "day"), client_order_id=p["liveCid"])
                        res = self.broker.execute(o)
                        if res.get("status") == "filled" and res.get("filled_qty"):
                            self._book_open(p, res["filled_qty"], res.get("price") or o.ref_price)
                        else:
                            pending = True
                else:
                    if filled > 0:
                        p["liveQty"] = filled           # partial: exposure exists
                    pending = True
                continue
            # --- closing orders that have not been confirmed
            if p.get("closeCid"):
                status, filled, px = self.broker.venue.order_state(p["closeCid"])
                if status == "filled" and filled > 0:
                    self._book_close(p, filled, px or p.get("entry") or 0.0, "close confirmed")
                elif status in FAILED:
                    if filled > 0:
                        self._book_close(p, filled, px or p.get("entry") or 0.0, "partial close")
                    else:
                        statemod.journal("close_dead", {"cid": p["closeCid"], "status": status})
                        p.pop("closeCid", None)         # retry on a later cycle
                elif status == "not_found":
                    p.pop("closeCid", None)
                else:
                    pending = True
        statemod.save(self.st)
        return pending

    # ------------------------------------------------------------ booking
    def _book_open(self, p, filled, px):
        fees = self._est_fee(p["symbol"], filled, px, "buy")
        p.update({"shares": filled, "entry": px, "cost": filled * px,
                  "openFee": fees, "liveOpen": True, "liveQty": filled})
        self.st.cash -= filled * px + fees
        statemod.journal("open_confirmed", {"cid": p.get("liveCid"), "symbol": p["symbol"],
                                            "shares": filled, "price": px})

    def _book_close(self, p, filled, px, reason):
        fees = self._est_fee(p["symbol"], filled, px, "sell")
        take = min(filled, p["shares"]) if p["shares"] else filled
        pnl = take * (px - p.get("entry", px)) - fees - (p.get("openFee", 0.0) * (take / max(p["shares"], take, 1e-9)))
        self.st.cash += take * px - fees
        self.st.closed.append({"symbol": p["symbol"], "desk": p.get("desk", ""),
                               "side": p.get("side", "long"), "shares": take,
                               "entry": p.get("entry", 0.0), "exit": px,
                               "openedAt": p.get("openedAt", 0), "closedAt": int(time.time()),
                               "pnl": round(pnl, 6), "fees": round(fees, 6), "reason": reason})
        self.st.trade_count += 1
        p["shares"] = max(0.0, p["shares"] - take)
        p.pop("closeCid", None)
        if p["shares"] <= 1e-9:
            self.st.positions.remove(p)
        statemod.journal("close_confirmed", {"symbol": p["symbol"], "shares": take, "price": px})

    def _est_fee(self, symbol, shares, px, side):
        m = self._symbol_meta.get(symbol) if hasattr(self, "_symbol_meta") else None
        cls = m.asset_class if m else "equity"
        if cls == "crypto":
            return money.crypto_fee(m.venue if m else "alpaca", shares * px)
        if cls == "prediction":
            return money.kalshi_fee(px, shares)
        return (money.equity_sell_fees(shares, px) if side == "sell"
                else money.equity_buy_fees(shares, px))

    # ------------------------------------------------------------- decide
    def decide_all(self, desks, allocs, phase):
        """Targets from every desk that is in its window; symbols of desks
        that are holding are left untouched (returned in `held_only`)."""
        targets, notes, active = {}, [], set()
        src_for = lambda d: "alpaca" if d.meta.asset_class == "crypto" else "yahoo"
        for d in desks:
            alloc = allocs.get(d.meta.name)
            if not alloc or not alloc.enabled:
                notes.append(f"{d.meta.name}: {alloc.reason if alloc else 'not allocated'}")
                continue
            ev = event_for(d.meta, phase)
            if ev is None:
                notes.append(f"{d.meta.name}: holding (outside its window, phase {phase})")
                continue
            series = {}
            for sym in d.universe():
                s = self._load(sym, d.meta.interval, src_for(d))
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
            view = deskbase.View(aligned, length - 1, ev,
                                 aligned[list(aligned)[0]][-1].t)
            decision = d.decide(view)
            active.update(d.universe())
            if not decision:
                continue
            notes.append(f"{d.meta.name}[{ev}]: {decision.note}")
            for sym, w in (decision.weights or {}).items():
                targets[sym] = targets.get(sym, 0.0) + w * alloc.weight
        return targets, notes, active

    def marks(self, symbols):
        out = {}
        for sym in symbols:
            m = self._symbol_meta.get(sym)
            src = "alpaca" if (m and m.asset_class == "crypto") else "yahoo"
            s = self._load(sym, m.interval if m else "1d", src)
            if s:
                out[sym] = s[-1].c
        return out

    def orders_for(self, targets, marks, equity, active, phase):
        held = {}
        for p in self.st.positions:
            if p.get("closeCid") or (p.get("liveCid") and not p.get("liveOpen")):
                continue                        # pending; reconcile owns it
            held[p["symbol"]] = held.get(p["symbol"], 0.0) + p["shares"]
        out = []
        for sym in set(list(targets) + list(held)):
            if sym not in active:
                continue                        # owning desk is holding
            px = marks.get(sym)
            if not px or px <= 0:
                continue
            m = self._symbol_meta.get(sym)
            if m is None:
                continue
            otype, tif, whole = order_style(m, phase)
            want_w = targets.get(sym, 0.0)
            want = (equity * want_w) / px if want_w else 0.0
            if whole:
                want = float(int(want))
            delta = want - held.get(sym, 0.0)
            notional = abs(delta) * px
            if notional < self.cfg.limits.min_trade_notional:
                continue
            if whole and abs(delta) < 1:
                continue
            out.append(Order(desk=self._owner(sym), symbol=sym,
                             side="buy" if delta > 0 else "sell", shares=abs(delta),
                             ref_price=px, order_type=otype, time_in_force=tif,
                             reason=f"target {want_w:.1%} ({otype})"))
        return out

    def _owner(self, sym):
        for d in self._desks:
            if sym in d.universe():
                return d.meta.name
        return "portfolio"

    # ---------------------------------------------------------------- cycle
    def run_cycle(self, today=None):
        now = self.now_et()
        today = today or now.strftime("%Y-%m-%d")
        phase = session_phase(now)
        self._desks = self.enabled_desks()
        if not self._desks:
            return {"error": "no desks enabled", "cycle": today}
        self._symbol_meta = self.symbol_meta(self._desks)
        if self.broker is None:
            self.broker = PaperBroker(self._symbol_meta)

        pending = self.reconcile()
        all_syms = list(self._symbol_meta)
        marks = self.marks(all_syms)
        equity = self.account_equity(marks)
        self.rm.roll_session(today, equity)
        halt = self.rm.mark(equity)
        allocs = {a.name: a for a in self.rm.allocate(
            self._desks, equity, explicit_desks=getattr(self.cfg, "explicit_desks", ()))}
        targets, notes, active = self.decide_all(self._desks, allocs, phase)

        executed, refused = [], []
        if halt:
            refused.append({"reason": halt, "scope": "all"})
        elif pending:
            refused.append({"reason": "an earlier order is still pending; not trading "
                                      "until it reaches a terminal state", "scope": "all"})
        else:
            for order in self.orders_for(targets, marks, equity, active, phase):
                notional = order.shares * order.ref_price
                ok, why = self.rm.check_trade(notional, order.symbol, len(self.st.positions))
                if not ok:
                    refused.append({"symbol": order.symbol, "reason": why})
                    continue
                stamp = int(time.time())
                order.client_order_id = client_order_id(order.desk, order.symbol,
                                                        order.side, stamp)
                self._record_intent(order, stamp)
                res = self.broker.execute(order)
                self._apply_result(order, res, stamp)
                if res.get("status") == "filled" and res.get("filled_qty"):
                    self.rm.record_trade(notional)
                    executed.append({"symbol": order.symbol, "side": order.side,
                                     "shares": round(res["filled_qty"], 8),
                                     "price": res.get("price"), "type": order.order_type})
                elif res.get("status") == "refused":
                    refused.append({"symbol": order.symbol, "reason": res.get("error")})
                else:
                    executed.append({"symbol": order.symbol, "side": order.side,
                                     "shares": round(order.shares, 8), "type": order.order_type,
                                     "status": res.get("status") or "pending"})

        equity = self.account_equity(marks)
        self.st.equity_curve.append({"t": int(time.time()), "equity": round(equity, 4)})
        self.rm.mark(equity)
        self.rm.save()
        statemod.save(self.st)
        self.telemetry = {
            "cycle": today, "phase": phase, "nowEt": now.strftime("%H:%M"),
            "equity": round(equity, 2), "cash": round(self.st.cash, 2),
            "positions": len(self.st.positions), "pending": pending,
            "targets": {k: round(v, 4) for k, v in targets.items()},
            "executed": executed, "refused": refused, "deskNotes": notes,
            "allocations": {k: {"weight": a.weight, "enabled": a.enabled, "reason": a.reason}
                            for k, a in allocs.items()},
            "risk": self.rm.telemetry(), "mode": self.st.mode,
        }
        return self.telemetry

    # ------------------------------------------------------------- effects
    def _record_intent(self, order, stamp):
        """Journal, and for a BUY create the pending position BEFORE the
        order leaves, so a crash between the two leaves an id to reconcile."""
        statemod.journal("intent", {"cid": order.client_order_id, "symbol": order.symbol,
                                    "side": order.side, "shares": round(order.shares, 8),
                                    "type": order.order_type})
        if order.side == "buy":
            self.st.positions.append({
                "symbol": order.symbol, "desk": order.desk, "side": "long",
                "shares": 0.0, "targetShares": order.shares, "entry": order.ref_price,
                "openedAt": stamp, "cost": 0.0, "openFee": 0.0,
                "liveCid": order.client_order_id if self.live else "",
                "liveOpen": False, "liveQty": 0.0, "mirrorAttempts": 0,
                "orderType": order.order_type, "tif": order.time_in_force,
            })
        else:
            remaining = order.shares
            for p in self.st.positions:
                if p["symbol"] == order.symbol and p.get("liveOpen", not self.live) \
                        and not p.get("closeCid") and remaining > 0:
                    if self.live:
                        p["closeCid"] = order.client_order_id
                    remaining -= p["shares"]
        statemod.save(self.st)

    def _apply_result(self, order, res, stamp):
        filled = res.get("filled_qty") or 0.0
        px = res.get("price") or order.ref_price
        if order.side == "buy":
            p = next((q for q in self.st.positions if q.get("openedAt") == stamp
                      and q["symbol"] == order.symbol and not q.get("liveOpen")), None)
            if p is None:
                return
            if res.get("status") == "filled" and filled > 0:
                if res.get("paper"):
                    fees = res.get("fees", 0.0)
                    p.update({"shares": filled, "entry": px, "cost": filled * px,
                              "openFee": fees, "liveOpen": True, "liveQty": filled})
                    self.st.cash -= filled * px + fees
                else:
                    self._book_open(p, filled, px)
            elif res.get("status") in FAILED or res.get("status") == "refused":
                self.st.positions.remove(p)
            # else: pending — reconcile() picks it up next cycle
        else:
            if res.get("status") == "filled" and filled > 0:
                remaining = filled
                for p in list(self.st.positions):
                    if p["symbol"] != order.symbol or remaining <= 0 or p["shares"] <= 0:
                        continue
                    take = min(p["shares"], remaining)
                    if res.get("paper"):
                        fees = res.get("fees", 0.0) * (take / filled)
                        pnl = take * (px - p["entry"]) - fees - p.get("openFee", 0.0) * (take / p["shares"])
                        self.st.cash += take * px - fees
                        self.st.closed.append({"symbol": order.symbol, "desk": p.get("desk", ""),
                                               "side": "long", "shares": take, "entry": p["entry"],
                                               "exit": px, "openedAt": p.get("openedAt", 0),
                                               "closedAt": int(time.time()), "pnl": round(pnl, 6),
                                               "fees": round(fees, 6), "reason": order.reason})
                        self.st.trade_count += 1
                        p["shares"] -= take
                        p.pop("closeCid", None)
                        if p["shares"] <= 1e-9:
                            self.st.positions.remove(p)
                    else:
                        self._book_close(p, take, px, order.reason)
                    remaining -= take
            elif res.get("status") in FAILED or res.get("status") == "refused":
                for p in self.st.positions:
                    if p.get("closeCid") == order.client_order_id:
                        p.pop("closeCid", None)
            # else: pending close — reconcile() finishes it
        statemod.save(self.st)
