#!/usr/bin/env python3
"""Event-driven replay. The same decision path the live loop runs.

Design commitments, each one a lesson from the system this replaces:

  1. Fills happen at a price the venue could actually have given us — the
     open or close of the bar being traded — plus a spread crossing and
     slippage from `core.money`. Never a mid, never a bar we could not have
     reached in time.
  2. Fees are charged on every leg, including the regulatory fees on the
     sell side that are easy to forget and add up over a year of turnover.
  3. Weights are targets; the engine trades the DIFFERENCE. A desk that
     wants the same position two days running pays nothing on day two, so
     turnover is real turnover and not an artifact of restating intent.
  4. Equity is marked every bar whether or not anything traded, so the
     Sharpe reflects the whole calendar rather than only the exciting days.
  5. Cash is tracked explicitly and can go to zero. A backtest that lets a
     $40 account take a $200 position is not describing this account.
"""
import math
from dataclasses import dataclass, field

from ..core import money
from ..desks.base import CLOSE, OPEN, View


@dataclass
class Fill:
    t: int
    symbol: str
    side: str                # buy | sell
    shares: float
    price: float             # fill price INCLUDING spread/slippage
    ref_price: float         # the bar price before costs
    fees: float
    event: str
    note: str = ""


@dataclass
class Position:
    symbol: str
    shares: float = 0.0      # negative = short
    cost_basis: float = 0.0  # average entry, per share, positive
    opened_t: int = 0

    @property
    def side(self):
        return "long" if self.shares > 0 else "short" if self.shares < 0 else "flat"


@dataclass
class Result:
    equity_curve: list = field(default_factory=list)   # [(t, equity)]
    returns: list = field(default_factory=list)        # per-bar equity returns
    fills: list = field(default_factory=list)
    positions_over_time: list = field(default_factory=list)
    fees_paid: float = 0.0
    fee_floor_paid: float = 0.0
    slippage_paid: float = 0.0
    turnover: float = 0.0                              # sum |traded notional|
    bars: int = 0
    start_equity: float = 0.0
    end_equity: float = 0.0
    exposure_sum: float = 0.0
    halted_days: int = 0
    notes: list = field(default_factory=list)


class Engine:
    """Replay one desk over aligned bar history."""

    # A target-weight desk asks for the same weight every bar, but the share
    # count implied by that weight drifts as equity moves. Acting on every
    # drift produces a stream of dust trades that change nothing and pay a
    # fresh $0.03 regulatory floor each day they touch. Real desks use a
    # no-trade band: leave the position alone until it is off target by more
    # than this fraction of equity, or by this fraction of the position.
    REBALANCE_BAND_EQUITY = 0.02      # 2% of account equity
    REBALANCE_BAND_POSITION = 0.10    # or 10% of the position's own size

    def __init__(self, desk, series, start_equity=1000.0, max_gross=1.0,
                 daily_loss_halt=None, allow_short=None, verbose=False,
                 rebalance_band=None):
        self.desk = desk
        self.series = series                       # {symbol: [Bar]} aligned
        self.start_equity = float(start_equity)
        self.max_gross = float(max_gross)
        self.daily_loss_halt = daily_loss_halt     # e.g. 0.04 -> stop at -4% on a day
        self.allow_short = (desk.meta.shortable if allow_short is None else allow_short)
        self.verbose = verbose
        self.rebalance_band = (self.REBALANCE_BAND_EQUITY if rebalance_band is None
                               else float(rebalance_band))

        self.cash = self.start_equity
        self.positions = {}
        self.result = Result(start_equity=self.start_equity)
        self._day_start_equity = self.start_equity
        self._halted_today = False
        self._current_day = None
        self._day_raw_fees = 0.0
        self._day_traded = False

    def _close_fee_day(self):
        """Apply the broker's per-day, per-fee-type cent rounding."""
        if self.desk.meta.asset_class != "equity":
            self._day_raw_fees, self._day_traded = 0.0, False
            return
        extra = money.daily_fee_floor(self._day_raw_fees, self._day_traded)
        if extra > 0:
            self.cash -= extra
            self.result.fees_paid += extra
            self.result.fee_floor_paid += extra
        self._day_raw_fees, self._day_traded = 0.0, False

    # ------------------------------------------------------------- pricing
    def _fill_price(self, symbol, ref, side):
        """Ref price adjusted for how this desk reaches the market.

        A desk trading the open and close prints executes in the auction and
        pays no spread; one reacting to live quotes crosses the book. The
        desk declares which via `meta.execution_style`, and the same setting
        drives the live executor's order type, so the two cannot drift.
        """
        bps = money.execution_cost_bps(
            symbol, self.desk.meta.asset_class,
            getattr(self.desk.meta, "execution_style", money.CROSSING))
        adj = ref * bps / 1e4
        return ref + adj if side == "buy" else ref - adj

    def _fees(self, symbol, shares, price, side):
        if self.desk.meta.asset_class == "crypto":
            maker = getattr(self.desk.meta, "execution_style", "") == "maker"
            return money.crypto_fee(self.desk.meta.venue, abs(shares * price),
                                    maker=maker)
        if self.desk.meta.asset_class == "prediction":
            maker = getattr(self.desk.meta, "execution_style", "") == "maker"
            return money.kalshi_fee(price, abs(shares), maker=maker)
        if side == "sell":
            return money.equity_sell_fees(abs(shares), price)
        return money.equity_buy_fees(abs(shares), price)

    def equity(self, marks):
        """Cash plus mark-to-market of open positions."""
        eq = self.cash
        for sym, p in self.positions.items():
            px = marks.get(sym)
            if px:
                eq += p.shares * px
        return eq

    # ------------------------------------------------------------ trading
    def _trade(self, t, symbol, target_shares, ref_price, event, equity=None,
               force=False):
        """Move `symbol` to `target_shares` at `ref_price`. Returns notional.

        Small adjustments are skipped unless `force` (a full exit always
        executes). See REBALANCE_BAND_* — trading a 0.3% drift costs more
        in fees than the tracking error it corrects.
        """
        pos = self.positions.get(symbol) or Position(symbol)
        delta = target_shares - pos.shares
        if abs(delta) < 1e-9 or ref_price <= 0:
            return 0.0
        if not force and pos.shares != 0 and target_shares != 0:
            drift = abs(delta) * ref_price
            eq = equity or self.start_equity
            held = abs(pos.shares) * ref_price
            if drift < eq * self.rebalance_band and \
               drift < held * self.REBALANCE_BAND_POSITION:
                return 0.0
        side = "buy" if delta > 0 else "sell"
        fill_px = self._fill_price(symbol, ref_price, side)
        notional = abs(delta) * fill_px
        fees = self._fees(symbol, delta, fill_px, side)

        # Cash: buying costs cash, selling raises it; shorts raise cash on
        # open and consume it on cover, which the sign of delta handles.
        self.cash -= delta * fill_px
        self.cash -= fees

        slip = abs(delta) * abs(fill_px - ref_price)
        self.result.fees_paid += fees
        self._day_raw_fees += fees
        self._day_traded = True
        self.result.slippage_paid += slip
        self.result.turnover += notional
        self.result.fills.append(Fill(t, symbol, side, abs(delta), fill_px,
                                      ref_price, fees, event))

        # cost basis bookkeeping for reporting
        if pos.shares == 0 or (pos.shares > 0) != (target_shares > 0):
            pos.cost_basis = fill_px
            pos.opened_t = t
        elif abs(target_shares) > abs(pos.shares):
            prev, add = abs(pos.shares), abs(delta)
            pos.cost_basis = (pos.cost_basis * prev + fill_px * add) / (prev + add)
        pos.shares = target_shares
        if abs(pos.shares) < 1e-9:
            self.positions.pop(symbol, None)
        else:
            self.positions[symbol] = pos
        return notional

    def _apply(self, view, decision, t, event):
        """Turn target weights into trades at this event's prices."""
        marks = {s: view.price_now(s) for s in self.series}
        marks = {s: p for s, p in marks.items() if p}
        eq = self.equity(marks)
        if eq <= 0:
            return

        weights = dict(decision.weights or {})
        if not self.allow_short:
            weights = {s: max(0.0, w) for s, w in weights.items()}

        gross = sum(abs(w) for w in weights.values())
        if gross > self.max_gross and gross > 0:
            scale = self.max_gross / gross
            weights = {s: w * scale for s, w in weights.items()}

        # Close anything not named, then open/adjust the named ones. Closing
        # first frees cash and mirrors how the live executor sequences.
        for sym in list(self.positions):
            if sym not in weights or abs(weights.get(sym, 0.0)) < 1e-9:
                px = marks.get(sym)
                if px:
                    self._trade(t, sym, 0.0, px, event, eq, force=True)

        for sym, w in sorted(weights.items(), key=lambda kv: -abs(kv[1])):
            px = marks.get(sym)
            if not px or abs(w) < 1e-9:
                continue
            side = "long" if w > 0 else "short"
            raw = abs(eq * w) / px
            held = abs((self.positions.get(sym) or Position(sym)).shares)
            # Whole-share hysteresis, identical to the live runner: a held
            # position whose unrounded target is within one share of it stays
            # put, so a fee-sized equity change cannot floor 5.0 to 4.
            if not self.desk.meta.fractional and held > 0 and abs(raw - held) < 1:
                continue
            shares = money.round_shares(raw, self.desk.meta.fractional, side)
            if shares <= 0:
                continue
            self._trade(t, sym, shares if w > 0 else -shares, px, event, eq)

    # --------------------------------------------------------------- run
    def run(self):
        # Until the replay has run, the account is exactly what it started
        # with; a guard return must not read as a total loss.
        self.result.end_equity = self.start_equity
        symbols = list(self.series)
        if not symbols:
            self.result.notes.append("no series")
            return self.result
        length = min(len(v) for v in self.series.values())
        warm = max(self.desk.meta.warmup_bars, 2)
        if length <= warm + 2:
            self.result.notes.append(
                f"history too short: {length} bars, warmup {warm}")
            return self.result

        events = tuple(self.desk.meta.events)
        prev_eq = None
        import datetime as _dt

        for i in range(warm, length):
            t = self.series[symbols[0]][i].t
            day = _dt.datetime.fromtimestamp(t, _dt.timezone.utc).date()
            if day != self._current_day:
                # Settle the previous session's regulatory rounding before
                # opening a new one: each fee type is aggregated per day and
                # rounded up to the cent, so any day with activity costs at
                # least $0.03 regardless of size. On a small account that
                # floor, not the percentage fees, is the dominant drag.
                self._close_fee_day()
                self._current_day = day
                marks_o = {s: self.series[s][i].o for s in symbols}
                self._day_start_equity = self.equity(marks_o)
                self._halted_today = False

            for event in events:
                view = View(self.series, i, event, t)
                marks = {s: view.price_now(s) for s in symbols}
                marks = {s: p for s, p in marks.items() if p}

                # Daily loss halt: flatten and stop trading for the session.
                if self.daily_loss_halt and not self._halted_today:
                    eq_now = self.equity(marks)
                    if self._day_start_equity > 0 and \
                       eq_now / self._day_start_equity - 1 <= -abs(self.daily_loss_halt):
                        for sym in list(self.positions):
                            if marks.get(sym):
                                self._trade(t, sym, 0.0, marks[sym], event,
                                            eq_now, force=True)
                        self._halted_today = True
                        self.result.halted_days += 1
                        continue
                if self._halted_today:
                    continue

                decision = self.desk.decide(view)
                if decision is not None:
                    self._apply(view, decision, t, event)

            close_marks = {s: self.series[s][i].c for s in symbols}
            eq = self.equity(close_marks)
            self.result.equity_curve.append((t, round(eq, 6)))
            if prev_eq and prev_eq > 0:
                self.result.returns.append(eq / prev_eq - 1)
            prev_eq = eq
            self.result.bars += 1
            gross = sum(abs(p.shares) * close_marks.get(s, 0)
                        for s, p in self.positions.items())
            self.result.exposure_sum += (gross / eq) if eq > 0 else 0.0
            self.result.positions_over_time.append(
                (t, {s: round(p.shares, 6) for s, p in self.positions.items()}))

        self._close_fee_day()
        self.result.end_equity = self.result.equity_curve[-1][1] if \
            self.result.equity_curve else self.start_equity
        return self.result


def run_desk(desk, series, start_equity=1000.0, **kw):
    """Convenience wrapper: replay and return (Result, Stats)."""
    from . import metrics
    eng = Engine(desk, series, start_equity=start_equity, **kw)
    res = eng.run()
    if not res.returns:
        return res, metrics.Stats(notes=["no returns produced"] + res.notes)
    years = res.bars / desk.meta.periods_per_year
    turn = (res.turnover / start_equity / years) if years > 0 else 0.0
    stats = metrics.compute(
        res.returns,
        equity_curve=[e for _, e in res.equity_curve],
        periods_per_year=desk.meta.periods_per_year,
        turnover=turn,
        exposure=(res.exposure_sum / res.bars) if res.bars else 0.0,
    )
    return res, stats
