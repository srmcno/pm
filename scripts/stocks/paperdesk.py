#!/usr/bin/env python3
"""Autonomous paper trading account for the equities desk.

The account is fully self-directed inside its configuration: it sizes, opens,
and closes long and short intraday positions without operator input, holds
nothing overnight, and halts itself for the day past a maximum drawdown.
Fills are simulated at the current quote plus half the symbol's spread
estimate plus configured slippage. State persists in data/stocks/paper.json;
every decision is journalled with its reason.
"""
import time

from . import stocklib
from .strategy import (UNIVERSE, RollingTape, StrategyConfig, evaluate,
                       exit_check)


def seed_tape(cfg, now=None):
    """Tape pre-filled from today's minute bars and the driver's klines, so a
    process starting mid-session has anchors immediately."""
    now = now or time.time()
    tape = RollingTape(keep_seconds=int(cfg.anchor_minutes * 60 * 4))
    for sym in UNIVERSE:
        for b in stocklib.minute_bars(sym, "1d"):
            tape.record(sym, b[0], b[4])
    start = now - cfg.anchor_minutes * 60 * 3
    for drv in {m["driver"] for m in UNIVERSE.values()}:
        for ts, px in sorted(stocklib.crypto_minutes(drv, start, now).items()):
            tape.record(drv, ts, px)
    return tape

STATE_FILE = "paper.json"


def default_state(bankroll=1000.0):
    return {"bankrollStart": bankroll, "cash": bankroll,
            "createdAt": int(time.time()), "positions": [], "closed": [],
            "equityCurve": [], "log": [], "day": {}}


def load():
    return stocklib.load_state(STATE_FILE, default_state())


def save(st):
    st["log"] = st["log"][-400:]
    st["closed"] = st["closed"][-300:]
    st["equityCurve"] = st["equityCurve"][-2000:]
    stocklib.save_state(STATE_FILE, st)


def log(st, **event):
    st["log"].append({"t": int(time.time()), **event})


def equity(st, quotes):
    val = st["cash"]
    for p in st["positions"]:
        px = quotes.get(p["symbol"], p["entry"])
        if p["side"] == "long":
            val += p["shares"] * px
        else:
            val += p["shares"] * (2 * p["entry"] - px)
    return val


def _day(st):
    today = time.strftime("%Y-%m-%d")
    if st["day"].get("date") != today:
        st["day"] = {"date": today, "trades": 0, "pnl": 0.0, "halted": False,
                     "startEquity": None}
    return st["day"]


def fill_price(symbol, quote_px, side_is_buy, cfg):
    half_spread = UNIVERSE[symbol]["spreadBps"] / 2.0
    adj = (half_spread + cfg.slippage_bps) / 1e4
    return quote_px * (1 + adj) if side_is_buy else quote_px * (1 - adj)


def open_position(st, snap, quote_px, cfg: StrategyConfig, now=None):
    day = _day(st)
    if day["halted"]:
        return None
    if len(st["positions"]) >= cfg.max_positions:
        return None
    if any(p["symbol"] == snap.symbol for p in st["positions"]):
        return None
    eq = equity(st, {snap.symbol: quote_px})
    stake = round(eq * cfg.risk_frac, 2)
    if stake < 10.0 or stake > st["cash"]:
        stake = min(stake, round(st["cash"], 2))
        if stake < 10.0:
            return None
    px = fill_price(snap.symbol, quote_px, snap.action == "long", cfg)
    shares = round(stake / px, 4)
    pos = {"symbol": snap.symbol, "side": snap.action, "shares": shares,
           "entry": round(px, 4), "cost": round(shares * px, 2),
           "openedAt": int(now or time.time()),
           "entryDislocationBps": snap.dislocation_bps,
           "driverMoveBps": snap.driver_move_bps, "beta": snap.beta,
           "reason": snap.reason}
    st["cash"] = round(st["cash"] - pos["cost"], 4)
    st["positions"].append(pos)
    log(st, action="OPEN", **{k: pos[k] for k in
        ("symbol", "side", "shares", "entry", "cost", "reason")})
    return pos


def close_position(st, pos, quote_px, why, cfg: StrategyConfig, now=None):
    px = fill_price(pos["symbol"], quote_px, pos["side"] == "short", cfg)
    if pos["side"] == "long":
        proceeds = pos["shares"] * px
    else:
        proceeds = pos["shares"] * (2 * pos["entry"] - px)
    pnl = round(proceeds - pos["cost"], 2)
    st["cash"] = round(st["cash"] + proceeds, 4)
    st["positions"].remove(pos)
    closed = {**pos, "exit": round(px, 4), "closedAt": int(now or time.time()),
              "pnl": pnl, "exitReason": why}
    st["closed"].append(closed)
    day = _day(st)
    day["trades"] += 1
    day["pnl"] = round(day["pnl"] + pnl, 2)
    log(st, action="CLOSE", symbol=pos["symbol"], side=pos["side"],
        exit=round(px, 4), pnl=pnl, reason=why)
    return closed


def step(st, cfg: StrategyConfig, betas, tape, now=None):
    """One evaluation cycle: quotes, exits, entries, mark. Returns snapshot
    rows for publication. Dislocation is measured against the tape value
    `cfg.anchor_minutes` back for both the equity and its driver."""
    now = now or time.time()
    anchor_ts = now - cfg.anchor_minutes * 60
    mins_left = stocklib.minutes_to_close()
    drv_prices = stocklib.crypto_mids(tuple({m["driver"] for m in UNIVERSE.values()}))
    quotes, snaps = {}, []

    day = _day(st)
    for drv, px in drv_prices.items():
        tape.record(drv, now, px)
    for sym, meta in UNIVERSE.items():
        q = stocklib.quote(sym)
        if not q or not q.get("price"):
            continue
        quotes[sym] = q["price"]
        tape.record(sym, now, q["price"])
        drv = meta["driver"]
        if betas.get(sym, {}).get("r2", 0) < cfg.min_beta_r2:
            continue
        anchor = tape.at(sym, anchor_ts)
        drv_anchor = tape.at(drv, anchor_ts)
        if drv not in drv_prices or anchor is None or drv_anchor is None:
            continue
        snap = evaluate(sym, q["price"], anchor, drv_prices[drv],
                        drv_anchor, betas[sym]["beta"], cfg,
                        meta["spreadBps"])
        if snap:
            snap.driver = drv
            snaps.append(snap)

    eq = equity(st, quotes)
    if day["startEquity"] is None:
        day["startEquity"] = round(eq, 2)
    if (day["startEquity"] - eq) / max(day["startEquity"], 1) >= cfg.max_daily_loss_frac \
            and not day["halted"]:
        day["halted"] = True
        log(st, action="HALT", reason="daily loss limit")
        for p in list(st["positions"]):
            if p["symbol"] in quotes:
                close_position(st, p, quotes[p["symbol"]], "halt", cfg, now)

    by_symbol = {s.symbol: s for s in snaps}
    for p in list(st["positions"]):
        q = quotes.get(p["symbol"])
        if q is None:
            continue
        snap = by_symbol.get(p["symbol"])
        d_bps = snap.dislocation_bps if snap else 0.0
        held_min = (now - p["openedAt"]) / 60.0
        why = exit_check(p, d_bps, held_min, mins_left, cfg)
        if why:
            close_position(st, p, q, why, cfg, now)

    if not day["halted"] and mins_left > cfg.flatten_minutes_before_close:
        ranked = sorted((s for s in snaps if s.action != "none"),
                        key=lambda s: -abs(s.dislocation_bps))
        for snap in ranked:
            open_position(st, snap, quotes[snap.symbol], cfg, now)

    eq = equity(st, quotes)
    st["equityCurve"].append({"t": int(now), "equity": round(eq, 2)})
    return snaps, quotes, eq
