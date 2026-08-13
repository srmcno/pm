#!/usr/bin/env python3
"""Replay backtest for the lead-lag strategy over recent 1-minute history.

Yahoo serves regular-session 1m bars for roughly the last week; MEXC serves
unlimited 1m klines. Both are aligned by minute and the exact production
signal functions are replayed bar by bar, with entries filled at the NEXT
bar's open plus the configured costs — the strategy never trades on the bar
that produced its signal. Results are written to data/stocks/backtest.json
and reports/stocks-backtest.md.
"""
import time
from collections import defaultdict
from datetime import datetime

from . import stocklib
from .strategy import UNIVERSE, StrategyConfig, evaluate, exit_check, fit_all_betas
from .paperdesk import fill_price, sell_side_fees

REPORT = "reports/stocks-backtest.md"


def _sessions(bars):
    """Split minute bars into trading sessions keyed by ET date."""
    out = defaultdict(list)
    for b in bars:
        d = datetime.fromtimestamp(b[0], tz=stocklib.ET)
        out[d.strftime("%Y-%m-%d")].append(b)
    return out


_DATA_CACHE = {}


def load_data(range_="5d", interval="1m"):
    """Bars and driver minutes for a window, cached in-process so a parameter
    sweep fetches once and replays many times."""
    key = (range_, interval)
    if key in _DATA_CACHE:
        return _DATA_CACHE[key]
    stock_bars, spans = {}, []
    for sym in UNIVERSE:
        bars = stocklib.minute_bars(sym, range_, interval)
        if bars:
            stock_bars[sym] = bars
            spans.append((bars[0][0], bars[-1][0]))
    if not stock_bars:
        return None
    start = min(s for s, _ in spans) - 3600
    end = max(e for _, e in spans) + 60
    drivers = {m["driver"] for m in UNIVERSE.values()}
    drv_minutes = {d: stocklib.crypto_minutes(d, start, end) for d in drivers}
    _DATA_CACHE[key] = (stock_bars, drv_minutes)
    return _DATA_CACHE[key]


def run(bankroll=1000.0, range_="5d", cfg=None, verbose=True, interval="1m",
        write=True):
    cfg = cfg or StrategyConfig.load()
    betas = fit_all_betas(cfg)
    step_s = 300 if interval == "5m" else 60

    data = load_data(range_, interval)
    if data is None:
        return {"error": "no equity bars available"}
    stock_bars, drv_minutes = data

    cash = bankroll
    open_pos = {}                     # symbol -> position dict
    closed = []
    sessions_by_sym = {s: _sessions(b) for s, b in stock_bars.items()}
    all_days = sorted({d for by in sessions_by_sym.values() for d in by})

    def drv_at(driver, ts):
        for back in range(0, 300, 60):
            v = drv_minutes[driver].get((ts // 60) * 60 - back)
            if v is not None:
                return v
        return None

    from .strategy import RollingTape

    for day in all_days:
        day_bars = {s: by[day] for s, by in sessions_by_sym.items() if day in by}
        if not day_bars:
            continue
        open_ts = min(b[0][0] for b in day_bars.values())
        # Same rolling-anchor mechanism the live desk uses: within the first
        # anchor window of a session the anchor is the session open.
        tape = RollingTape(keep_seconds=int(cfg.anchor_minutes * 60 * 4))

        idx = {s: 0 for s in day_bars}
        last_ts = max(b[-1][0] for b in day_bars.values())
        t = open_ts
        while t <= last_ts:
            for sym, bars in day_bars.items():
                i = idx[sym]
                while i < len(bars) and bars[i][0] < t:
                    i += 1
                idx[sym] = i
                if i >= len(bars) or bars[i][0] != t:
                    continue
                bar = bars[i]
                px = bar[4]
                meta = UNIVERSE[sym]
                if betas[sym]["r2"] < cfg.min_beta_r2:
                    continue
                # A bar stamped t closes at t + step_s; align the driver to
                # the same observation instant (the 1m kline whose close is
                # t + step_s opens at t + step_s - 60). At 1m intervals this
                # is t itself; at 5m, reading the driver at t would compare
                # prices observed ~4 minutes apart and manufacture
                # dislocations that never existed.
                drv_px = drv_at(meta["driver"], t + step_s - 60)
                if drv_px is None:
                    continue
                tape.record(sym, t, px)
                tape.record(meta["driver"], t, drv_px)
                anchor_ts = t - cfg.anchor_minutes * 60
                anchor = tape.at(sym, anchor_ts)
                drv_anchor_px = tape.at(meta["driver"], anchor_ts)
                if anchor is None or drv_anchor_px is None:
                    continue
                snap = evaluate(sym, px, anchor, drv_px, drv_anchor_px,
                                betas[sym]["beta"], cfg, meta["spreadBps"])
                if snap is None:
                    continue
                mins_left = max(0.0, (last_ts - t) / 60.0)
                pos = open_pos.get(sym)
                if pos:
                    held = (t - pos["openedAt"]) / 60.0
                    why = exit_check(pos, snap.dislocation_bps, held,
                                     mins_left, cfg)
                    if why and i + 1 < len(bars):
                        exit_q = bars[i + 1][1]
                        fpx = fill_price(sym, exit_q, pos["side"] == "short", cfg)
                        if pos["side"] == "long":
                            proceeds = (pos["shares"] * fpx
                                        - sell_side_fees(pos["shares"], fpx))
                        else:
                            proceeds = pos["shares"] * (2 * pos["entry"] - fpx)
                        pnl = proceeds - pos["cost"] - pos.get("openFee", 0.0)
                        cash += proceeds
                        closed.append({**pos, "exit": round(fpx, 4),
                                       "closedAt": t, "pnl": round(pnl, 2),
                                       "exitReason": why, "day": day})
                        del open_pos[sym]
                elif snap.action != "none" and len(open_pos) < cfg.max_positions \
                        and i + 1 < len(bars) \
                        and mins_left > cfg.flatten_minutes_before_close + 1:
                    entry_q = bars[i + 1][1]
                    fpx = fill_price(sym, entry_q, snap.action == "long", cfg)
                    stake = min(cash, (cash + sum(p["cost"] for p in open_pos.values()))
                                * cfg.risk_frac)
                    if stake >= 10.0:
                        # Same sizing the paper/live path applies: shorts are
                        # whole shares only, and a short open is a sale with
                        # regulatory fees on the leg.
                        if snap.action == "short":
                            shares = float(int(stake / fpx))
                        else:
                            shares = stake / fpx
                        if shares > 0:
                            cost = shares * fpx
                            open_fee = (sell_side_fees(shares, fpx)
                                        if snap.action == "short" else 0.0)
                            open_pos[sym] = {
                                "symbol": sym, "side": snap.action,
                                "shares": shares, "entry": round(fpx, 4),
                                "cost": cost, "openFee": round(open_fee, 4),
                                # The hold clock starts when the fill happens
                                # (the next bar), not when the signal printed.
                                "openedAt": bars[i + 1][0],
                                "entryDislocationBps": snap.dislocation_bps}
                            cash -= cost + open_fee
            t += step_s
        # forced flat at session end
        for sym, pos in list(open_pos.items()):
            bars = day_bars.get(sym)
            if not bars:
                continue
            fpx = fill_price(sym, bars[-1][4], pos["side"] == "short", cfg)
            proceeds = (pos["shares"] * fpx - sell_side_fees(pos["shares"], fpx)
                        if pos["side"] == "long"
                        else pos["shares"] * (2 * pos["entry"] - fpx))
            cash += proceeds
            closed.append({**pos, "exit": round(fpx, 4), "closedAt": bars[-1][0],
                           "pnl": round(proceeds - pos["cost"]
                                        - pos.get("openFee", 0.0), 2),
                           "exitReason": "close", "day": day})
            del open_pos[sym]

    wins = [c for c in closed if c["pnl"] > 0]
    ret = (cash / bankroll - 1) * 100
    by_day = defaultdict(float)
    for c in closed:
        by_day[c["day"]] += c["pnl"]
    result = {
        "generatedAt": int(time.time()),
        "range": range_, "interval": interval, "bankroll": bankroll,
        "finalEquity": round(cash, 2), "returnPct": round(ret, 2),
        "trades": len(closed), "wins": len(wins),
        "winRate": round(len(wins) / len(closed), 3) if closed else None,
        "avgPnl": round(sum(c["pnl"] for c in closed) / len(closed), 2) if closed else None,
        "byDay": {d: round(p, 2) for d, p in sorted(by_day.items())},
        "sessionDays": all_days,
        "exitReasons": dict(sorted(
            ((r, sum(1 for c in closed if c["exitReason"] == r))
             for r in {c["exitReason"] for c in closed}),
            key=lambda kv: -kv[1])),
        "betas": betas,
        "config": {k: getattr(cfg, k) for k in
                   ("entry_bps", "exit_bps", "stop_bps", "min_driver_move_bps",
                    "risk_frac", "max_positions", "slippage_bps")},
        "trades_detail": closed[-60:],
    }
    if write:
        # The stress-validation block is produced by validate(), not by every
        # replay; carry it forward so refreshing the canonical replay does
        # not erase it from the dashboard.
        prev = stocklib.load_state("backtest.json", {})
        if isinstance(prev, dict) and prev.get("validation"):
            result["validation"] = prev["validation"]
        stocklib.save_state("backtest.json", result)
        _write_report(result)
    if verbose:
        print(f"{range_}/{interval} replay: ${bankroll:.0f} -> ${cash:.2f} ({ret:+.2f}%) "
              f"over {len(closed)} trades, win rate "
              f"{(len(wins) / len(closed) * 100) if closed else 0:.0f}%")
    return result


def _write_report(r):
    import os
    lines = [
        "# Equities desk — replay backtest",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(r['generatedAt']))} · "
        f"range {r['range']} · entries filled at the next bar's open plus costs.",
        "",
        f"## ${r['bankroll']:.0f} → ${r['finalEquity']:.2f} ({r['returnPct']:+.2f}%)",
        "",
        f"- Trades: {r['trades']} · win rate "
        f"{(r['winRate'] * 100 if r['winRate'] is not None else 0):.0f}% · "
        f"avg P&L ${r['avgPnl'] if r['avgPnl'] is not None else 0}",
        f"- Exits: " + ", ".join(f"{k} {v}" for k, v in r["exitReasons"].items()),
        "",
        "| day | P&L |", "|---|---|",
    ]
    for d, p in r["byDay"].items():
        lines.append(f"| {d} | {p:+.2f} |")
    lines += ["", "| symbol | beta | n | r² |", "|---|---|---|---|"]
    for s, b in r["betas"].items():
        lines.append(f"| {s} | {b['beta']} | {b['n']} | {b['r2']} |")
    path = os.path.join(stocklib.BASE, REPORT)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def validate(cfg=None, range_="1mo", interval="5m", bankroll=1000.0):
    """Coarse-bar stress replay; attaches its summary to backtest.json.

    The 5m cadence means dislocations are detected up to ~300 seconds late,
    a deliberate worst case against the live desk's seconds-scale polling."""
    cfg = cfg or StrategyConfig.load()
    m = run(bankroll=bankroll, range_=range_, cfg=cfg, verbose=True,
            interval=interval, write=False)
    if "error" in m:
        return m
    worst = min(m["byDay"].values()) if m.get("byDay") else 0.0
    block = {
        "range": range_, "interval": interval,
        "fillNote": f"{interval} bars: dislocations detected up to "
                    f"~{300 if interval == '5m' else 60}s late, filled at "
                    f"the next bar's open",
        "returnPct": m["returnPct"], "trades": m["trades"],
        "winRate": m["winRate"], "worstDay": round(worst, 2),
    }
    bt = stocklib.load_state("backtest.json", {})
    bt["validation"] = block
    stocklib.save_state("backtest.json", bt)
    return block


def sweep(grid=None, range_="5d", interval="1m", train_frac=0.6,
          bankroll=1000.0, verbose=True):
    """Grid search with selection on early sessions and honest scoring on the
    held-out later ones. Positions never span sessions, so per-day P&L splits
    cleanly. Returns rows sorted by train-day P&L; the test columns exist to
    be read, not selected on.
    """
    from itertools import product
    grid = grid or {
        "entry_bps": [45, 60, 75, 90],
        "stop_bps": [40, 55, 70],
        "min_driver_move_bps": [25, 35, 50],
        "max_hold_minutes": [20, 45],
        "anchor_minutes": [20, 30, 45],
    }
    keys = list(grid)
    rows = []
    combos = list(product(*(grid[k] for k in keys)))
    for i, combo in enumerate(combos):
        cfg = StrategyConfig()
        for k, v in zip(keys, combo):
            setattr(cfg, k, v)
        r = run(bankroll=bankroll, range_=range_, cfg=cfg, verbose=False,
                interval=interval, write=False)
        if "error" in r:
            return [{"error": r["error"]}]
        # Split on every market session in the window, not on days the config
        # happened to trade — otherwise each config gets its own train/test
        # boundary and the held-out periods are not comparable. A session
        # with no trades scores zero.
        days = r["sessionDays"]
        cut = max(1, int(len(days) * train_frac))
        train_days, test_days = days[:cut], days[cut:]
        train = sum(r["byDay"].get(d, 0.0) for d in train_days)
        test = sum(r["byDay"].get(d, 0.0) for d in test_days)
        n_train = sum(1 for c in r["trades_detail"] if c["day"] in train_days)
        rows.append({**dict(zip(keys, combo)),
                     "trainPnl": round(train, 2), "testPnl": round(test, 2),
                     "trainDays": len(train_days), "testDays": len(test_days),
                     "trades": r["trades"], "winRate": r["winRate"],
                     "returnPct": r["returnPct"]})
        if verbose and (i + 1) % 40 == 0:
            print(f"  {i + 1}/{len(combos)} configs", flush=True)
    rows.sort(key=lambda x: -x["trainPnl"])
    return rows
