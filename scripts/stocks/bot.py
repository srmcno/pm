#!/usr/bin/env python3
"""Equities desk command line.

  python3 -m stocks.bot betas               # fit and show driver betas
  python3 -m stocks.bot scan                # one evaluation pass, no trades
  python3 -m stocks.bot run --minutes 115   # autonomous paper session
  python3 -m stocks.bot backtest --range 5d # replay recent minute history
  python3 -m stocks.bot status              # account summary

`run` trades the paper account autonomously: long and short, intraday only,
flat before the close, halted for the day past the drawdown limit. Adding
--execute mirrors each paper decision to an Alpaca account and requires the
arming steps in livedesk.py. Publishes dashboard/data/stocks.json.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from stocks import backtest as backtest_mod   # noqa: E402
from stocks import paperdesk, stocklib        # noqa: E402
from stocks.strategy import (UNIVERSE, StrategyConfig,   # noqa: E402
                             fit_all_betas)

DASH_DATA = os.path.join(stocklib.BASE, "dashboard", "data", "stocks.json")


def publish(st, cfg, snaps, quotes, eq, betas, market):
    payload = {
        "meta": {
            "generatedAt": int(time.time()),
            "market": market,
            "universe": list(UNIVERSE),
            "riskFrac": cfg.risk_frac,
            "maxPositions": cfg.max_positions,
            "entryBps": cfg.entry_bps,
            "minDriverMoveBps": cfg.min_driver_move_bps,
            "anchorMinutes": cfg.anchor_minutes,
        },
        "account": {
            "bankrollStart": st["bankrollStart"],
            "equity": round(eq, 2),
            "cash": round(st["cash"], 2),
            "day": st.get("day", {}),
            "openPositions": len(st["positions"]),
            "closedTrades": len(st["closed"]),
            "wins": sum(1 for c in st["closed"] if c["pnl"] > 0),
        },
        "positions": st["positions"],
        "recentTrades": st["closed"][-20:][::-1],
        "board": [{
            "symbol": s.symbol, "price": s.price, "driver": s.driver,
            "driverPrice": s.driver_price, "beta": s.beta,
            "dislocationBps": s.dislocation_bps,
            "driverMoveBps": s.driver_move_bps,
            "action": s.action, "reason": s.reason,
        } for s in snaps],
        "quotes": quotes,
        "betas": betas,
        "equityCurve": st["equityCurve"][-500:],
        "backtest": stocklib.load_state("backtest.json", None),
    }
    os.makedirs(os.path.dirname(DASH_DATA), exist_ok=True)
    tmp = DASH_DATA + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, DASH_DATA)
    return payload


def cmd_betas(args):
    cfg = StrategyConfig.load()
    betas = fit_all_betas(cfg)
    print(f"{'symbol':<7}{'driver':<10}{'beta':>7}{'days':>6}{'r2':>7}")
    for s, b in betas.items():
        print(f"{s:<7}{UNIVERSE[s]['driver']:<10}{b['beta']:>7.2f}"
              f"{b['n']:>6}{b['r2']:>7.2f}")
    return 0


def cmd_scan(args):
    cfg = StrategyConfig.load()
    betas = fit_all_betas(cfg)
    tape = paperdesk.seed_tape(cfg)
    st = paperdesk.load()
    snaps, quotes, eq = paperdesk.step(
        st, cfg, betas, tape) if args.trade else _scan_only(
        cfg, betas, tape, st)
    market = stocklib.market_state()
    print(f"market {market} · equity ${eq:.2f} · "
          f"{len(st['positions'])} open positions")
    for s in snaps:
        print(f"  {s.symbol:<6} {s.price:>9.2f}  d={s.dislocation_bps:>+7.1f}bps "
              f"drv={s.driver_move_bps:>+7.1f}bps  {s.action:<6} {s.reason}")
    publish(st, cfg, snaps, quotes, eq, betas, market)
    if args.trade:
        paperdesk.save(st)
    return 0


def _scan_only(cfg, betas, tape, st):
    import time as _t
    from stocks.strategy import evaluate
    now = _t.time()
    anchor_ts = now - cfg.anchor_minutes * 60
    drv_prices = stocklib.crypto_mids(tuple({m["driver"] for m in UNIVERSE.values()}))
    snaps, quotes = [], {}
    for sym, meta in UNIVERSE.items():
        q = stocklib.quote(sym)
        if not q or not q.get("price"):
            continue
        quotes[sym] = q["price"]
        drv = meta["driver"]
        anchor = tape.at(sym, anchor_ts)
        drv_anchor = tape.at(drv, anchor_ts)
        if drv in drv_prices and anchor and drv_anchor:
            s = evaluate(sym, q["price"], anchor, drv_prices[drv],
                         drv_anchor, betas[sym]["beta"], cfg,
                         meta["spreadBps"])
            if s:
                s.driver = drv
                snaps.append(s)
    return snaps, quotes, paperdesk.equity(st, quotes)


def cmd_run(args):
    cfg = StrategyConfig.load()
    if args.risk_frac is not None:
        cfg.risk_frac = args.risk_frac
    betas = fit_all_betas(cfg)
    st = paperdesk.load()
    executor = None
    if args.execute:
        from stocks import livedesk
        livedesk.assert_armed(args)
        executor = livedesk.Alpaca()
        print(f"executor: {executor.base}")

    deadline = time.time() + args.minutes * 60 if args.minutes else None
    last_push = 0.0
    print(f"universe {', '.join(UNIVERSE)} · risk {cfg.risk_frac:.0%}/position · "
          f"max {cfg.max_positions} concurrent · entry {cfg.entry_bps:.0f}bps",
          flush=True)
    tape = paperdesk.seed_tape(cfg)
    while not deadline or time.time() < deadline:
        market = stocklib.market_state()
        if market != "open":
            snaps, quotes, eq = _scan_only(cfg, betas, tape, st)
            publish(st, cfg, snaps, quotes, eq, betas, market)
            if market in ("closed", "afterhours") and not st["positions"]:
                print(f"market {market} — session over", flush=True)
                break
            time.sleep(60)
            continue
        before = {id(p) for p in st["positions"]}
        snaps, quotes, eq = paperdesk.step(st, cfg, betas, tape)
        for p in st["positions"]:
            if id(p) not in before and executor:
                _mirror(executor, p, opening=True)
        for c in st["closed"][-5:]:
            if c.get("closedAt", 0) >= time.time() - cfg.poll_seconds - 2 and executor:
                _mirror(executor, c, opening=False)
        paperdesk.save(st)
        publish(st, cfg, snaps, quotes, eq, betas, market)
        if args.git_push and time.time() - last_push > args.push_minutes * 60:
            last_push = time.time()
            _git_push()
        time.sleep(cfg.poll_seconds)
    paperdesk.save(st)
    if args.git_push:
        _git_push()
    day = st.get("day", {})
    print(f"session done · day P&L {day.get('pnl', 0):+.2f} over "
          f"{day.get('trades', 0)} trades")
    return 0


def _mirror(executor, pos, opening):
    from stocks import livedesk
    try:
        r = livedesk.mirror_position(executor, pos, opening)
        print(f"  alpaca {'open' if opening else 'close'} {pos['symbol']} "
              f"-> {r.get('id', '?')[:8]}", flush=True)
    except Exception as e:                                # noqa: BLE001
        print(f"  alpaca order failed: {e}", flush=True)


def _git_push():
    sys.path.insert(0, os.path.join(stocklib.BASE, "scripts"))
    import pmlib
    pmlib.publish_repo(["dashboard/data/stocks.json", "data/stocks", "reports"],
                       "auto: stocks desk update")


def cmd_backtest(args):
    r = backtest_mod.run(bankroll=args.bankroll, range_=args.range)
    if "error" in r:
        print(r["error"])
        return 1
    print(f"details: reports/stocks-backtest.md")
    return 0


def cmd_status(args):
    st = paperdesk.load()
    day = st.get("day", {})
    curve = st.get("equityCurve") or []
    eq = curve[-1]["equity"] if curve else st["cash"]
    print(f"equity ${eq:.2f} (started ${st['bankrollStart']:.2f}) · "
          f"cash ${st['cash']:.2f}")
    print(f"today: {day.get('trades', 0)} trades, {day.get('pnl', 0):+.2f} P&L"
          + (" · HALTED" if day.get("halted") else ""))
    for p in st["positions"]:
        print(f"  {p['side']:<6}{p['symbol']:<6}{p['shares']:>9.2f} @ "
              f"{p['entry']:.2f}  ({p['reason']})")
    for c in st["closed"][-8:]:
        print(f"  closed {c['side']:<6}{c['symbol']:<6}{c['pnl']:>+8.2f} "
              f"({c['exitReason']})")
    return 0


def cmd_init(args):
    if os.path.exists(os.path.join(stocklib.DATA_DIR, paperdesk.STATE_FILE)) \
            and not args.force:
        raise SystemExit("state exists; use --force to reset")
    paperdesk.save(paperdesk.default_state(args.bankroll))
    StrategyConfig.load().save()
    print(f"paper account funded with ${args.bankroll:.2f} (simulated)")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    p.add_argument("--bankroll", type=float, default=1000.0)
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_init)

    sub.add_parser("betas").set_defaults(fn=cmd_betas)

    p = sub.add_parser("scan")
    p.add_argument("--trade", action="store_true",
                   help="act on the scan instead of only reporting it")
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("run")
    p.add_argument("--minutes", type=float, default=0)
    p.add_argument("--risk-frac", type=float, default=None)
    p.add_argument("--git-push", action="store_true")
    p.add_argument("--push-minutes", type=float, default=10)
    p.add_argument("--execute", action="store_true",
                   help="mirror decisions to Alpaca (see livedesk.py)")
    p.add_argument("--live", action="store_true")
    p.add_argument("--i-accept-total-loss", action="store_true")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("backtest")
    p.add_argument("--bankroll", type=float, default=1000.0)
    p.add_argument("--range", default="5d")
    p.set_defaults(fn=cmd_backtest)

    sub.add_parser("status").set_defaults(fn=cmd_status)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
