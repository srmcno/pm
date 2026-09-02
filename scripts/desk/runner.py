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
from .backtest.engine import Engine
from .core import evidence, money, risk, state as statemod
from .data import bars
from .desks import base as deskbase

# Submission windows, Eastern time. Chosen so an order is in comfortably
# before the exchange cutoff rather than racing it.
PRE_OPEN = ((9, 0), (9, 26))       # MOO cutoff 09:28
PRE_CLOSE = ((15, 30), (15, 48))   # MOC cutoff 15:50
FAILED = {"canceled", "expired", "rejected", "stopped", "suspended", "replaced",
          "done_for_day"}


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
    """Readable and unique: desk, symbol, side and a millisecond stamp. The
    runner also checks it against every id the book already carries, so two
    orders can never share one — a shared id would let one order's state be
    read as another's fill."""
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
    # Sells down or closes an existing position. The risk manager never
    # refuses these on exposure caps, and a loss halt sends them.
    reducing: bool = False


def interval_seconds(interval):
    """'1d' -> 86400, '1h' -> 3600, '15m' -> 900."""
    try:
        n, unit = int(str(interval)[:-1]), str(interval)[-1]
    except ValueError:
        return 86400
    return n * {"m": 60, "h": 3600, "d": 86400, "w": 604800}.get(unit, 86400)


def completed_bars(series, interval, now_ts):
    """Only bars whose period has ended. A 24/7 venue serves the candle
    still forming; a daily desk that saw it as complete would re-decide
    every cycle on a moving close — a strategy the replay never tested."""
    span = interval_seconds(interval)
    return [b for b in series if b.t + span <= now_ts]


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
            code = getattr(e, "status", None)
            if isinstance(code, int) and 400 <= code < 500 and code not in (408, 429):
                # The venue answered and said no: nothing is resting there.
                # Treating this as ambiguous would poll it to not_found and
                # block every desk behind a "pending" order that never was.
                statemod.journal("refused", {"cid": order.client_order_id, "status": code,
                                             "error": str(e)[:300]})
                return {"status": "refused", "filled_qty": 0.0, "price": None,
                        "fees": 0.0, "paper": False,
                        "error": f"venue {code}: {str(e)[:200]}"}
            # Ambiguous (timeout, 5xx, rate limit): the venue may have
            # accepted it. Reconcile by client id.
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
                 series_loader=None, clock=None, verdicts=None):
        self.cfg = cfg or cfgmod.load()
        self.st = st or statemod.load(bankroll=self.cfg.equity)
        self.rm = rm or risk.RiskManager(self.st.cash, self.cfg.limits)
        self.broker = broker
        self.live = broker is not None and not isinstance(broker, PaperBroker)
        self._load = series_loader or self._default_loader
        self._clock = clock                     # () -> aware datetime, for tests
        # None: read data/desk/evidence.json on every cycle, so a Monday
        # validation that fails a desk switches it off at the next cycle.
        self._verdicts = verdicts
        self.telemetry = {}

    def verdicts(self):
        return self._verdicts if self._verdicts is not None else evidence.verdicts()

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
        # --- opening orders that have not been confirmed
        for p in list(self.st.positions):
            if not (p.get("liveCid") and not p.get("liveOpen") and not p.get("liveDead")):
                continue
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
                # The venue has never heard of it. Look once more next cycle
                # in case the query itself failed; then the intent is dead
                # and the desk's next decision restates the target through
                # the normal path. It is NEVER resubmitted from here: that
                # would bypass the risk check, the halts, the STOP file and
                # the auction window the order was decided in.
                n = int(p.get("notFound", 0)) + 1
                if n >= 2:
                    statemod.journal("open_dead", {"cid": p["liveCid"], "status": "not_found"})
                    self.st.positions.remove(p)
                else:
                    p["notFound"] = n
                    pending = True
            else:
                if filled > 0:
                    p["liveQty"] = filled           # partial: exposure exists
                pending = True
        # --- closing orders. One order can span several lots of a symbol,
        # so its fill is distributed across them once, in order — never
        # applied to each lot in full.
        by_cid = {}
        for p in self.st.positions:
            if p.get("closeCid") and p.get("liveOpen"):
                by_cid.setdefault(p["closeCid"], []).append(p)
        for cid, lots in by_cid.items():
            status, filled, px = self.broker.venue.order_state(cid)
            if status == "filled" or status in FAILED:
                if filled > 0:
                    remaining = float(filled)
                    for p in lots:
                        take = min(p["shares"], remaining)
                        if take > 1e-12:
                            self._book_close(p, take, px or p.get("entry") or 0.0,
                                             "close confirmed" if status == "filled"
                                             else "partial close")
                            remaining -= take
                        else:
                            p.pop("closeCid", None)     # not reached: still open
                else:
                    statemod.journal("close_dead", {"cid": cid, "status": status})
                    for p in lots:
                        p.pop("closeCid", None)         # retry on a later cycle
            elif status == "not_found":
                for p in lots:
                    p.pop("closeCid", None)
            else:
                pending = True
        statemod.save(self.st)
        return pending

    def verify_book(self):
        """Live only: the venue's positions are the truth. Returns '' when the
        book agrees with the venue, else a reason not to trade.

        A lot the venue holds LESS of is shrunk to what it holds — Alpaca
        takes crypto fees from the asset received, so 0.01 BTC bought is
        0.009975 BTC held, and a sell sized at 0.01 is rejected forever. A
        lot the venue does not hold at all is dropped. Anything the venue
        holds in this book's universe that the book does not know about is
        untracked exposure; the book refuses to trade until the operator has
        looked and run `desk.cli adopt`.
        """
        if not self.live or not hasattr(self.broker.venue, "positions"):
            return ""
        try:
            raw = self.broker.venue.positions()
        except Exception as e:                                 # noqa: BLE001
            return f"could not read the venue's positions ({str(e)[:120]})"
        if raw is None:
            return ""                       # adapter does not report positions
        canon = {s.replace("/", "").replace("-", ""): s for s in self._symbol_meta}
        venue = {}
        for r in raw:
            key = str(r.get("symbol", "")).replace("/", "").replace("-", "")
            sym = canon.get(key)
            if sym:
                venue[sym] = venue.get(sym, 0.0) + abs(float(r.get("qty") or 0.0))
        book = {}
        for p in self.st.positions:
            if p.get("liveOpen") and not p.get("closeCid") and p.get("shares", 0.0) > 0:
                book.setdefault(p["symbol"], []).append(p)
        problems = []
        for sym, lots in book.items():
            bq = sum(l["shares"] for l in lots)
            vq = venue.get(sym, 0.0)
            if vq + 1e-9 < bq:
                excess = bq - vq
                for l in reversed(lots):
                    cut = min(l["shares"], excess)
                    l["shares"] -= cut
                    excess -= cut
                    if l["shares"] <= 1e-9:
                        self.st.positions.remove(l)
                    if excess <= 1e-12:
                        break
                statemod.journal("book_shrunk", {"symbol": sym, "book": bq, "venue": vq})
            elif vq > bq * (1 + 1e-6) + 1e-6:
                problems.append(f"{sym}: venue holds {vq:g}, book {bq:g}")
        for sym, vq in venue.items():
            if sym not in book and vq > 0:
                problems.append(f"{sym}: venue holds {vq:g}, book none")
        if problems:
            statemod.journal("book_mismatch", {"problems": problems})
            statemod.save(self.st)
            return ("book does not match the venue: " + "; ".join(problems)
                    + ". Check the broker, then run `desk.cli adopt`.")
        statemod.save(self.st)
        return ""

    # ------------------------------------------------------------ booking
    def _book_open(self, p, filled, px):
        fees = self._est_fee(p["symbol"], filled, px, "buy")
        p.update({"shares": filled, "entry": px, "cost": filled * px,
                  "openFee": fees, "liveOpen": True, "liveQty": filled})
        self.st.cash -= filled * px + fees
        # Turnover is counted where the fill is confirmed, so an auction
        # order that fills long after submission still spends its budget.
        self.rm.record_trade(filled * px)
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
        self.rm.record_trade(take * px)
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
                reason = alloc.reason if alloc else "not allocated"
                if self._holds_any(d.universe()):
                    # Funding withdrawn while positions are on — a failed
                    # verdict, a stale record, equity under the floor. Those
                    # positions are liquidated through the normal order path
                    # rather than left as an unmanaged hold.
                    active.update(d.universe())
                    notes.append(f"{d.meta.name}: {reason} — liquidating held positions")
                else:
                    notes.append(f"{d.meta.name}: {reason}")
                continue
            ev = event_for(d.meta, phase)
            if ev is None:
                notes.append(f"{d.meta.name}: holding (outside its window, phase {phase})")
                continue
            series = {}
            now_ts = self.now_et().timestamp()
            for sym in d.universe():
                s = self._load(sym, d.meta.interval, src_for(d))
                if s and d.meta.asset_class == "crypto":
                    # 24/7 venues serve the candle still forming. The replay
                    # decided on completed bars, so the live loop does too.
                    s = completed_bars(s, d.meta.interval, now_ts)
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
            bar_ts = aligned[list(aligned)[0]][-1].t
            prev = self.st.decisions.get(d.meta.name) or {}
            if prev.get("barTs") == bar_ts and prev.get("event") == ev:
                # Same bar, same event: the replay decided exactly once here.
                # Restate that decision so a missed fill still self-corrects,
                # but do not decide again on the same (or a moving) bar.
                weights = dict(prev.get("weights") or {})
                note = "unchanged, already decided on this bar: " + str(prev.get("note", ""))
            else:
                view = deskbase.View(aligned, length - 1, ev, bar_ts)
                decision = d.decide(view)
                weights = dict((decision.weights or {}) if decision else {})
                note = decision.note if decision else ""
                self.st.decisions[d.meta.name] = {
                    "barTs": bar_ts, "event": ev, "weights": weights,
                    "note": note, "at": int(time.time())}
            active.update(d.universe())
            notes.append(f"{d.meta.name}[{ev}]: {note}")
            for sym, w in weights.items():
                targets[sym] = targets.get(sym, 0.0) + w * alloc.weight
        return targets, notes, active

    def _holds_any(self, symbols):
        want = set(symbols)
        for p in self.st.positions:
            if p["symbol"] in want and p.get("shares", 0.0) > 0 \
                    and (p.get("liveOpen") or not self.live):
                return True
        return False

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
            raw = (equity * want_w) / px if want_w else 0.0
            held_qty = held.get(sym, 0.0)
            want = raw
            if whole:
                # Whole shares floor. A held position whose unrounded target
                # is within one share of it stays put: otherwise a fee-sized
                # equity change turns 5.0000 into 4.9999, floors to 4, and
                # sells a share every cycle.
                if held_qty > 0 and raw > 0 and abs(raw - held_qty) < 1:
                    continue
                want = float(int(raw))
            delta = want - held_qty
            notional = abs(delta) * px
            if notional < self.cfg.limits.min_trade_notional:
                continue
            if whole and abs(delta) < 1:
                continue
            # The replay's no-trade band, applied here with the same numbers:
            # a difference under 2% of equity AND under 10% of the position is
            # drift, not a signal. Without it a whole-share desk would sell a
            # share every cycle on fee-sized equity changes.
            if held_qty > 0 and want > 0 \
                    and notional < equity * Engine.REBALANCE_BAND_EQUITY \
                    and notional < held_qty * px * Engine.REBALANCE_BAND_POSITION:
                continue
            out.append(Order(desk=self._owner(sym), symbol=sym,
                             side="buy" if delta > 0 else "sell", shares=abs(delta),
                             ref_price=px, order_type=otype, time_in_force=tif,
                             reason=f"target {want_w:.1%} ({otype})",
                             reducing=(delta < 0 and held.get(sym, 0.0) > 0)))
        return out

    def flatten_orders(self, marks):
        """One market sell per symbol closing every confirmed position. Crypto
        GTC; equity DAY — placed outside the session it queues for the open,
        which is the earliest anything can be sold anyway."""
        by_sym = {}
        for p in self.st.positions:
            if p.get("closeCid") or (p.get("liveCid") and not p.get("liveOpen")):
                continue                        # pending; reconcile owns it
            if p.get("shares", 0.0) <= 0:
                continue
            by_sym[p["symbol"]] = by_sym.get(p["symbol"], 0.0) + p["shares"]
        out = []
        for sym, shares in by_sym.items():
            m = self._symbol_meta.get(sym)
            px = marks.get(sym) or 0.0
            if px <= 0:
                px = next((p.get("entry") for p in self.st.positions
                           if p["symbol"] == sym and p.get("entry")), 0.0)
            out.append(Order(desk=self._owner(sym), symbol=sym, side="sell",
                             shares=shares, ref_price=px, order_type="market",
                             time_in_force="gtc" if (m and m.asset_class == "crypto") else "day",
                             reason="loss halt: flatten", reducing=True))
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
        mismatch = "" if pending else self.verify_book()
        all_syms = list(self._symbol_meta)
        marks = self.marks(all_syms)
        equity = self.account_equity(marks)
        self.rm.roll_session(today, equity)
        halt = self.rm.mark(equity)
        allocs = {a.name: a for a in self.rm.allocate(
            self._desks, equity, explicit_desks=getattr(self.cfg, "explicit_desks", ()),
            verdicts=self.verdicts())}
        targets, notes, active = self.decide_all(self._desks, allocs, phase)

        executed, refused = [], []
        if mismatch:
            refused.append({"reason": mismatch, "scope": "all"})
        elif halt and self.rm.loss_halted() and not pending:
            # A loss halt means get flat, not freeze: the exposure is what is
            # losing. Only the operator's STOP file holds the book as it is.
            refused.append({"reason": halt, "scope": "all new exposure; flattening"})
            statemod.journal("halt_flatten", {"reason": halt,
                                              "positions": len(self.st.positions)})
            for order in self.flatten_orders(marks):
                self._execute(order, executed, refused)
        elif halt:
            refused.append({"reason": halt, "scope": "all"
                            + ("; flattening once the pending order settles" if pending else "")})
        elif pending:
            refused.append({"reason": "an earlier order is still pending; not trading "
                                      "until it reaches a terminal state", "scope": "all"})
        else:
            for order in self.orders_for(targets, marks, equity, active, phase):
                self._execute(order, executed, refused)

        equity = self.account_equity(marks)
        self.st.equity_curve.append({"t": int(time.time()), "equity": round(equity, 4)})
        self.rm.mark(equity)
        self.rm.save()
        statemod.save(self.st)
        self.telemetry = {
            "cycle": today, "phase": phase, "nowEt": now.strftime("%H:%M"),
            "equity": round(equity, 2), "cash": round(self.st.cash, 2),
            "positions": len(self.st.positions), "pending": pending,
            "bookMismatch": mismatch,
            "targets": {k: round(v, 4) for k, v in targets.items()},
            "executed": executed, "refused": refused, "deskNotes": notes,
            "allocations": {k: {"weight": a.weight, "enabled": a.enabled, "reason": a.reason}
                            for k, a in allocs.items()},
            "risk": self.rm.telemetry(), "mode": self.st.mode,
        }
        return self.telemetry

    # ------------------------------------------------------------- effects
    def _execute(self, order, executed, refused):
        """Risk check, journal, submit, book. The only path to a venue."""
        notional = order.shares * order.ref_price
        ok, why = self.rm.check_trade(notional, order.symbol, len(self.st.positions),
                                      reducing=order.reducing)
        if not ok:
            refused.append({"symbol": order.symbol, "reason": why})
            return
        stamp = int(time.time())
        order.client_order_id = self._new_cid(order)
        self._record_intent(order, stamp)
        res = self.broker.execute(order)
        self._apply_result(order, res, stamp)
        if res.get("status") == "filled" and res.get("filled_qty"):
            executed.append({"symbol": order.symbol, "side": order.side,
                             "shares": round(res["filled_qty"], 8),
                             "price": res.get("price"), "type": order.order_type,
                             "reason": order.reason})
        elif res.get("status") == "refused":
            refused.append({"symbol": order.symbol, "reason": res.get("error")})
        else:
            executed.append({"symbol": order.symbol, "side": order.side,
                             "shares": round(order.shares, 8), "type": order.order_type,
                             "status": res.get("status") or "pending",
                             "reason": order.reason})

    def _new_cid(self, order):
        used = set()
        for p in self.st.positions:
            used.add(p.get("liveCid"))
            used.add(p.get("closeCid"))
        base = client_order_id(order.desk, order.symbol, order.side,
                               int(time.time() * 1000))
        cid, n = base, 0
        while cid in used:
            n += 1
            cid = f"{base}-{n}"
        return cid

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
                    self.rm.record_trade(filled * px)
                else:
                    self._book_open(p, filled, px)
            elif res.get("status") in FAILED and filled > 0:
                self._book_open(p, filled, px)          # partial, then terminal
            elif res.get("status") in FAILED or res.get("status") == "refused":
                self.st.positions.remove(p)
            # else: pending — reconcile() picks it up next cycle
        else:
            status = res.get("status")
            if (status == "filled" or status in FAILED) and filled > 0:
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
                        self.rm.record_trade(take * px)
                        p["shares"] -= take
                        p.pop("closeCid", None)
                        if p["shares"] <= 1e-9:
                            self.st.positions.remove(p)
                    else:
                        self._book_close(p, take, px, order.reason)
                    remaining -= take
            if status in FAILED or status == "refused":
                # Whatever did not fill stays open and is retried by the
                # next decision; the lots must not keep a dead close id.
                for p in self.st.positions:
                    if p.get("closeCid") == order.client_order_id:
                        p.pop("closeCid", None)
            # else: pending close — reconcile() finishes it
        statemod.save(self.st)
