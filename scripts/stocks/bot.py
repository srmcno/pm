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


def publish(st, cfg, snaps, quotes, eq, betas, market, telemetry=None):
    payload = {
        "meta": {
            "generatedAt": int(time.time()),
            "market": market,
            "dataFeed": (telemetry or {}).get("feed", "yahoo"),
            "quoteAgeS": (telemetry or {}).get("quoteAgeS"),
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
    if args.trade:
        snaps, quotes, eq, telemetry = paperdesk.step(st, cfg, betas, tape)
    else:
        snaps, quotes, eq, telemetry = _scan_only(cfg, betas, tape, st)
    market = stocklib.market_state()
    print(f"market {market} · equity ${eq:.2f} · feed {telemetry['feed']} · "
          f"{len(st['positions'])} open positions")
    for s in snaps:
        print(f"  {s.symbol:<6} {s.price:>9.2f}  d={s.dislocation_bps:>+7.1f}bps "
              f"drv={s.driver_move_bps:>+7.1f}bps  {s.action:<6} {s.reason}")
    publish(st, cfg, snaps, quotes, eq, betas, market, telemetry)
    if args.trade:
        paperdesk.save(st)
    return 0


def _scan_only(cfg, betas, tape, st):
    import time as _t
    from stocks.strategy import evaluate
    now = _t.time()
    anchor_ts = now - cfg.anchor_minutes * 60
    drv_prices = stocklib.crypto_mids(tuple({m["driver"] for m in UNIVERSE.values()}))
    raw, feed = stocklib.live_quotes(list(UNIVERSE))
    snaps, quotes, ages = [], {}, []
    for sym, meta in UNIVERSE.items():
        q = raw.get(sym)
        if not q or not q.get("price"):
            continue
        quotes[sym] = q["price"]
        if q.get("ts"):
            ages.append(max(0.0, now - q["ts"]))
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
    ages.sort()
    return snaps, quotes, paperdesk.equity(st, quotes), {
        "feed": feed,
        "quoteAgeS": round(ages[len(ages) // 2], 1) if ages else None}


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
        # Closed trades with no trace of a live order have nothing to mirror.
        # Anything pending from an interrupted session — an unconfirmed open
        # (liveCid) or an unfinished close (liveOpen without mirrored) —
        # keeps its state and is reconciled immediately, before any new
        # trading. Open positions that predate execution are marked
        # paper-only: submitting them now would chase a signal from before
        # this session started.
        for c in st["closed"]:
            if not c.get("liveOpen") and not c.get("liveCid"):
                c.setdefault("mirrored", True)
        for p in st["positions"]:
            if not p.get("liveCid"):
                p["liveDead"] = True
        _reconcile_mirrors(executor, st, save=paperdesk.save)

    deadline = time.time() + args.minutes * 60 if args.minutes else None
    last_push = 0.0
    print(f"universe {', '.join(UNIVERSE)} · risk {cfg.risk_frac:.0%}/position · "
          f"max {cfg.max_positions} concurrent · entry {cfg.entry_bps:.0f}bps",
          flush=True)
    tape = paperdesk.seed_tape(cfg)
    while not deadline or time.time() < deadline:
        market = stocklib.market_state()
        if market != "open":
            snaps, quotes, eq, telemetry = _scan_only(cfg, betas, tape, st)
            publish(st, cfg, snaps, quotes, eq, betas, market, telemetry)
            # Pending live orders are worked even off-hours: a close queued
            # after the bell fills at the next open, and ending the session
            # before it confirms would leave live exposure with nobody
            # watching it.
            if executor and _reconcile_mirrors(executor, st, save=paperdesk.save):
                paperdesk.save(st)
                print("  waiting on pending live orders", flush=True)
                time.sleep(30)
                continue
            if market in ("closed", "afterhours") and not st["positions"]:
                print(f"market {market} — session over", flush=True)
                break
            time.sleep(60)
            continue
        if executor:
            # A close still settling live blocks new paper decisions: a
            # fresh position in the same symbol could be flattened or
            # reversed when the old close finally fills.
            _reconcile_mirrors(executor, st, save=paperdesk.save)
            if _pending_close(st):
                paperdesk.save(st)
                print("  reconciling pending live closes before trading",
                      flush=True)
                time.sleep(3)
                continue
        snaps, quotes, eq, telemetry = paperdesk.step(st, cfg, betas, tape)
        if executor:
            from stocks import livedesk
            # Closes created by this step are submitted before any new
            # opens; the paper desk additionally never re-enters a symbol
            # in the cycle that closed it, so an old close and its
            # replacement's open can never race at the broker. A new open
            # is a position with neither a liveCid nor the explicit
            # paper-only marker (liveDead) — never object identity, since
            # id() values can be reused within one step, and never bare
            # CID absence, which would resubmit dead or pre-execution
            # positions on a stale signal.
            _reconcile_mirrors(executor, st, save=paperdesk.save)
            for p in st["positions"]:
                if not p.get("liveCid") and not p.get("liveDead"):
                    # The CID is assigned and DURABLY SAVED before the
                    # network call: if the order is accepted but the
                    # response is lost — or the process dies mid-flight —
                    # the position stays reconcilable instead of becoming
                    # untracked live exposure. Submission is only step one;
                    # liveOpen is set when the order confirms filled in the
                    # reconcile pass.
                    p["liveCid"] = livedesk.mirror_cid(p, True)
                    paperdesk.save(st)
                    try:
                        livedesk.mirror_position(executor, p, opening=True)
                        print(f"  alpaca open submitted {p['symbol']}",
                              flush=True)
                    except Exception as e:                # noqa: BLE001
                        print(f"  alpaca open failed: {e}", flush=True)
            _reconcile_mirrors(executor, st, save=paperdesk.save)
        paperdesk.save(st)
        publish(st, cfg, snaps, quotes, eq, betas, market, telemetry)
        if args.git_push and time.time() - last_push > args.push_minutes * 60:
            last_push = time.time()
            _git_push()
        # The batched Alpaca quote endpoint tolerates a far faster cadence
        # than per-symbol Yahoo calls; poll at a third of the configured
        # interval when that feed is active.
        sleep_s = cfg.poll_seconds
        if telemetry.get("feed") == "alpaca":
            sleep_s = max(3.0, cfg.poll_seconds / 3.0)
        time.sleep(sleep_s)
    if executor:
        from stocks import livedesk
        # The paper-session deadline never abandons live orders: a DAY
        # order can fill after the process stops, so pending mirrors keep
        # being reconciled past the deadline until settled. If the grace
        # period expires, every unconfirmed OPEN order is cancelled — an
        # open filling after exit would be unmanaged new exposure — and
        # reconciliation continues briefly so cancellations confirm and
        # any partial fills get their closes submitted. Closes are left
        # working: they can only flatten, and the next session's startup
        # reconciliation settles their records from persisted state.
        settle_deadline = time.time() + 1800
        cancelled_opens = False
        while _reconcile_mirrors(executor, st, save=paperdesk.save):
            paperdesk.save(st)
            if time.time() > settle_deadline and not cancelled_opens:
                cancelled_opens = True
                settle_deadline = time.time() + 300
                for p in st["positions"]:
                    if p.get("liveCid") and not p.get("liveOpen"):
                        if livedesk.cancel_by_client_id(executor, p["liveCid"]):
                            print(f"  cancelled pending open {p['symbol']} "
                                  f"at shutdown", flush=True)
            elif time.time() > settle_deadline:
                print("  ALERT: live close orders still working at "
                      "shutdown; they only reduce exposure and the next "
                      "session resumes reconciliation", flush=True)
                break
            print("  settling pending live orders before shutdown",
                  flush=True)
            time.sleep(15)
    paperdesk.save(st)
    if args.git_push:
        _git_push()
    day = st.get("day", {})
    print(f"session done · day P&L {day.get('pnl', 0):+.2f} over "
          f"{day.get('trades', 0)} trades")
    return 0


def _pending_close(st):
    """True while any closed trade still has an unsettled live close."""
    return any(not c.get("mirrored")
               and (c.get("liveOpen") or c.get("liveCid"))
               for c in st["closed"])


def _reconcile_mirrors(executor, st, save=None):
    """Advance every pending live order to a confirmed terminal state.

    Nothing is recorded complete on submission alone: an accepted order can
    still be rejected, canceled, or partially filled. Opens gain liveOpen
    only once their order reports filled; closes are flagged mirrored only
    once theirs does, retrying failed submissions with attempt-scoped order
    ids. Returns True while anything is still pending so callers keep the
    process alive until live state matches paper state."""
    from stocks import livedesk
    pending = False

    def settle_open(rec):
        """Resolve what the opening order actually did live. Returns
        'live' (shares are held, possibly a partial), 'dead' (nothing ever
        filled), or 'pending' (keep checking)."""
        status, filled = livedesk.order_state(executor, rec["liveCid"])
        if status == "filled" or \
                (status in livedesk.FAILED_STATUSES and filled > 0):
            # A terminal order with a partial fill still put shares on the
            # book; they are live exposure and must be closed like any
            # other, at the actually-filled quantity.
            rec["liveOpen"] = True
            rec["liveQty"] = filled
            if status != "filled":
                print(f"  alpaca open for {rec['symbol']} ended '{status}' "
                      f"with {filled:g} of {rec['shares']:g} filled; "
                      f"tracking the partial", flush=True)
            return "live"
        if status in livedesk.FAILED_STATUSES:
            return "dead"
        if status == "not_found":
            # "Never landed" is only concluded after SUSTAINED 404s — at
            # least three probes spanning two minutes of wall clock — and
            # the streak resets on any other response, so a slowly indexed
            # or intermittently unavailable accepted order is never
            # converted into a dead one within a poll cycle.
            rec["liveNotFound"] = rec.get("liveNotFound", 0) + 1
            rec.setdefault("liveNotFoundSince", time.time())
            if rec["liveNotFound"] >= 3 and \
                    time.time() - rec["liveNotFoundSince"] >= 120:
                return "dead"
            return "pending"
        rec.pop("liveNotFound", None)
        rec.pop("liveNotFoundSince", None)
        return "pending"

    for p in st["positions"]:
        if p.get("liveCid") and not p.get("liveOpen"):
            outcome = settle_open(p)
            if outcome == "dead":
                # The open never happened; the position stays paper-only
                # PERMANENTLY (liveDead) — resubmitting later would chase
                # the stale signal that priced the original entry.
                p["liveCid"] = None
                p["liveDead"] = True
            elif outcome == "pending":
                pending = True
    for c in st["closed"]:
        if c.get("mirrored"):
            continue
        if not c.get("liveOpen"):
            # The open was submitted but unconfirmed when the paper side
            # closed; settle what actually happened live before deciding.
            if not c.get("liveCid"):
                c["mirrored"] = True     # never touched the live account
                continue
            outcome = settle_open(c)
            if outcome == "dead":
                c["mirrored"] = True     # open died; nothing live to close
                continue
            if outcome == "pending":
                pending = True
                continue
        cid = c.get("closeCid")
        attempt = c.get("mirrorAttempts", 0)
        if cid:
            status, filled = livedesk.order_state(executor, cid)
            if status == "filled":
                c["mirrored"] = True
                continue
            if status is None or (status not in livedesk.FAILED_STATUSES
                                  and status != "not_found"):
                pending = True           # working, queued, or lookup failed
                continue
            if status in livedesk.FAILED_STATUSES:
                if filled > 0:
                    # Terminal with a partial fill: shares remain live, so
                    # the record STAYS pending — new paper decisions remain
                    # blocked — and the residual resubmits at the reduced
                    # quantity under the next attempt id.
                    remaining = round((c.get("liveQty") or c["shares"])
                                      - filled, 4)
                    c["liveQty"] = remaining
                    print(f"  alpaca close for {c['symbol']} ended "
                          f"'{status}' with {filled:g} filled; resubmitting "
                          f"the remaining {remaining:g}", flush=True)
                    if remaining <= 0:
                        c["mirrored"] = True
                        continue
                c["mirrorAttempts"] = attempt = attempt + 1
                if attempt >= 5:
                    # Never mark a live position done just because retries
                    # ran out: the record stays pending, which keeps new
                    # trading blocked — the safe state for real money — and
                    # stops resubmitting so a hard-rejecting broker is not
                    # spammed. Clearing it requires closing the live
                    # position and resetting the record.
                    print(f"  ALERT: close mirror failed {attempt}x for "
                          f"{c['symbol']}; trading stays blocked until the "
                          f"live position is closed (manually if needed)",
                          flush=True)
                    pending = True
                    continue
            # status == "not_found": the submission never landed — fall
            # through and resubmit under the SAME attempt id, which stays
            # idempotent if it did land after all.
        # The CID is assigned and durably saved BEFORE the network call so
        # an accepted-but-lost submission — or a crash mid-flight — remains
        # reconcilable instead of spawning a second full-size close under a
        # fresh id.
        c["closeCid"] = livedesk.mirror_cid(c, False, attempt)
        if save:
            save(st)
        try:
            livedesk.mirror_position(executor, c, opening=False,
                                     attempt=attempt)
            print(f"  alpaca close submitted {c['symbol']}", flush=True)
        except Exception as e:                            # noqa: BLE001
            print(f"  alpaca close submit failed: {e}", flush=True)
        pending = True                   # confirm on a later pass either way
    return pending


def _git_push():
    sys.path.insert(0, os.path.join(stocklib.BASE, "scripts"))
    import pmlib
    pmlib.publish_repo(["dashboard/data/stocks.json", "data/stocks", "reports"],
                       "auto: stocks desk update")


def cmd_sweep(args):
    from stocks.backtest import sweep
    rows = sweep(range_=args.range, interval=args.interval,
                 train_frac=args.train_frac)
    if rows and "error" in rows[0]:
        print(rows[0]["error"])
        return 1
    hdr = ["entry_bps", "stop_bps", "min_driver_move_bps", "max_hold_minutes",
           "anchor_minutes", "trainPnl", "testPnl", "trades", "winRate"]
    print("  ".join(f"{h[:9]:>9}" for h in hdr))
    for r in rows[:args.top]:
        print("  ".join(f"{str(r[h])[:9]:>9}" for h in hdr))
    return 0


def cmd_backtest(args):
    r = backtest_mod.run(bankroll=args.bankroll, range_=args.range)
    if "error" in r:
        print(r["error"])
        return 1
    if args.validate:
        v = backtest_mod.validate(bankroll=args.bankroll)
        if "error" in v:
            print(v["error"])
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

    p = sub.add_parser("sweep")
    p.add_argument("--range", default="5d")
    p.add_argument("--interval", default="1m")
    p.add_argument("--train-frac", type=float, default=0.6)
    p.add_argument("--top", type=int, default=15)
    p.set_defaults(fn=cmd_sweep)

    p = sub.add_parser("backtest")
    p.add_argument("--bankroll", type=float, default=1000.0)
    p.add_argument("--range", default="5d")
    p.add_argument("--validate", action="store_true",
                   help="also refresh the coarse-bar stress validation")
    p.set_defaults(fn=cmd_backtest)

    sub.add_parser("status").set_defaults(fn=cmd_status)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
