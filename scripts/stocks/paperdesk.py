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


# Sell-side regulatory fees, charged on the leg that is a sale exactly as a
# US broker passes them through: SEC fee per dollar of sale proceeds and
# FINRA TAF per share sold.
SEC_FEE_PER_DOLLAR = 27.80 / 1_000_000
TAF_PER_SHARE = 0.000166


def sell_side_fees(shares, price):
    return shares * price * SEC_FEE_PER_DOLLAR + shares * TAF_PER_SHARE


def quote_is_fresh(q, now, max_age_s):
    """Entry-gate freshness. A quote with no venue timestamp cannot prove it
    is current, so it fails closed — usable for marks and exits, not entries.
    A timestamp meaningfully ahead of now is equally unverifiable (venue
    clock fault or bad payload); only small clock skew is tolerated."""
    ts = q.get("ts")
    if not ts:
        return False
    age = now - ts
    return -2.0 <= age <= max_age_s


def fill_price(symbol, quote, side_is_buy, cfg):
    """Simulated fill. With a real NBBO quote (dict with bid/ask) the fill is
    the touch plus slippage — a buy lifts the ask, a sell hits the bid. With
    only a last price, the symbol's spread estimate stands in for the touch."""
    slip = cfg.slippage_bps / 1e4
    if isinstance(quote, dict) and quote.get("bid") and quote.get("ask"):
        return (quote["ask"] * (1 + slip) if side_is_buy
                else quote["bid"] * (1 - slip))
    px = quote["price"] if isinstance(quote, dict) else quote
    half_spread = UNIVERSE[symbol]["spreadBps"] / 2.0 / 1e4
    if side_is_buy:
        return px * (1 + half_spread + slip)
    return px * (1 - half_spread - slip)


def open_position(st, snap, quote_px, cfg: StrategyConfig, now=None):
    day = _day(st)
    if day["halted"]:
        return None
    if len(st["positions"]) >= cfg.max_positions:
        return None
    if any(p["symbol"] == snap.symbol for p in st["positions"]):
        return None
    mark = quote_px["price"] if isinstance(quote_px, dict) else quote_px
    eq = equity(st, {snap.symbol: mark})
    stake = round(eq * cfg.risk_frac, 2)
    if stake < 10.0 or stake > st["cash"]:
        stake = min(stake, round(st["cash"], 2))
        if stake < 10.0:
            return None
    px = fill_price(snap.symbol, quote_px, snap.action == "long", cfg)
    if snap.action == "short":
        # Live shorting cannot be fractional; simulate the same constraint.
        shares = float(int(stake / px))
        if shares < 1:
            return None
    else:
        shares = round(stake / px, 4)
    pos = {"symbol": snap.symbol, "side": snap.action, "shares": shares,
           "entry": round(px, 4), "cost": round(shares * px, 2),
           "openedAt": int(now or time.time()),
           "entryDislocationBps": snap.dislocation_bps,
           "driverMoveBps": snap.driver_move_bps, "beta": snap.beta,
           "reason": snap.reason}
    st["cash"] = round(st["cash"] - pos["cost"], 4)
    if snap.action == "short":
        # Opening a short is a sale; regulatory fees apply on this leg. The
        # fee is recorded on the position so realized P&L includes it.
        pos["openFee"] = round(sell_side_fees(shares, px), 4)
        st["cash"] = round(st["cash"] - pos["openFee"], 4)
    st["positions"].append(pos)
    log(st, action="OPEN", **{k: pos[k] for k in
        ("symbol", "side", "shares", "entry", "cost", "reason")})
    return pos


def close_position(st, pos, quote_px, why, cfg: StrategyConfig, now=None):
    px = fill_price(pos["symbol"], quote_px, pos["side"] == "short", cfg)
    if pos["side"] == "long":
        # Closing a long is a sale; regulatory fees come out of proceeds.
        proceeds = pos["shares"] * px - sell_side_fees(pos["shares"], px)
    else:
        proceeds = pos["shares"] * (2 * pos["entry"] - px)
    pnl = round(proceeds - pos["cost"] - pos.get("openFee", 0.0), 2)
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
    fixed_now = now
    now = now or time.time()
    mins_left = stocklib.minutes_to_close()
    # One batched quote call: real NBBO with venue timestamps when Alpaca
    # keys are present, Yahoo last prices otherwise. The crypto driver is
    # sampled AFTER the potentially slow equity fetches, so the dislocation
    # always compares the freshest crypto print against equity quotes whose
    # own staleness the entry gate bounds.
    raw_quotes, feed = stocklib.live_quotes(list(UNIVERSE))
    drv_prices = stocklib.crypto_mids(tuple({m["driver"] for m in UNIVERSE.values()}))
    # Freshness, quote ages, and the rolling anchor are all measured
    # against the wall clock AFTER every retrieval — equity and crypto —
    # so time spent in any slow request counts against the quotes' age
    # instead of hiding inside a stale cycle-start timestamp.
    if fixed_now is None:
        now = time.time()
    anchor_ts = now - cfg.anchor_minutes * 60
    quotes, quote_objs, ages, snaps = {}, {}, [], []

    day = _day(st)
    for drv, px in drv_prices.items():
        tape.record(drv, now, px)
    for sym, meta in UNIVERSE.items():
        q = raw_quotes.get(sym)
        if not q or not q.get("price"):
            continue
        quotes[sym] = q["price"]
        quote_objs[sym] = q
        if q.get("ts"):
            ages.append(max(0.0, now - q["ts"]))
        # The signal tape records at the VENUE timestamp: a fallback quote
        # older than an observation already on the tape is silently dropped
        # (RollingTape rejects out-of-order writes), so a stale price can
        # never be time-shifted forward to fabricate an anchor regression.
        # The quote itself stays usable for marks and exits regardless.
        tape.record(sym, q.get("ts") or now, q["price"])
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
    closed_now = set()
    if (day["startEquity"] - eq) / max(day["startEquity"], 1) >= cfg.max_daily_loss_frac \
            and not day["halted"]:
        day["halted"] = True
        log(st, action="HALT", reason="daily loss limit")
    if day["halted"]:
        # Flatten on every halted cycle, not only the tripping one: a
        # symbol with no quote in that cycle would otherwise keep its
        # exposure until an ordinary exit fired, unbounded by the rail.
        for p in list(st["positions"]):
            if p["symbol"] in quote_objs:
                close_position(st, p, quote_objs[p["symbol"]], "halt", cfg, now)
                closed_now.add(p["symbol"])

    by_symbol = {s.symbol: s for s in snaps}
    for p in list(st["positions"]):
        q = quote_objs.get(p["symbol"])
        if q is None:
            continue
        snap = by_symbol.get(p["symbol"])
        d_bps = snap.dislocation_bps if snap else 0.0
        held_min = (now - p["openedAt"]) / 60.0
        why = exit_check(p, d_bps, held_min, mins_left, cfg)
        if why:
            close_position(st, p, q, why, cfg, now)
            closed_now.add(p["symbol"])

    if not day["halted"] and mins_left > cfg.flatten_minutes_before_close:
        ranked = sorted((s for s in snaps if s.action != "none"),
                        key=lambda s: -abs(s.dislocation_bps))
        for snap in ranked:
            # No same-cycle re-entry: a symbol that just closed would have
            # its replacement racing the old position's live close, and the
            # signal it would chase is the one that was just exited.
            if snap.symbol in closed_now:
                log(st, action="SKIP", symbol=snap.symbol,
                    reason="closed this cycle; no same-cycle re-entry")
                continue
            # Latency gate: the measured edge decays within minutes, so an
            # entry priced off a stale — or unverifiable — quote has already
            # missed it. Exits are never gated: leaving late beats not
            # leaving.
            q = quote_objs[snap.symbol]
            if not quote_is_fresh(q, now, cfg.max_quote_age_s):
                ts = q.get("ts")
                log(st, action="SKIP", symbol=snap.symbol,
                    reason=(f"quote {now - ts:.0f}s old" if ts
                            else "quote has no venue timestamp"))
                continue
            open_position(st, snap, q, cfg, now)

    eq = equity(st, quotes)
    st["equityCurve"].append({"t": int(now), "equity": round(eq, 2)})
    ages.sort()
    telemetry = {"feed": feed,
                 "quoteAgeS": round(ages[len(ages) // 2], 1) if ages else None}
    return snaps, quotes, eq, telemetry
