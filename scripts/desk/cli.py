#!/usr/bin/env python3
"""Command line for the desk system.

    python3 -m desk.cli status                 what is configured and held
    python3 -m desk.cli desks                  every registered desk and its floor
    python3 -m desk.cli backtest overnight     replay one desk, in-sample
    python3 -m desk.cli validate               walk-forward every desk, write evidence
    python3 -m desk.cli run                    one decision cycle (paper by default)
    python3 -m desk.cli watch --minutes 110    a CI shift
    python3 -m desk.cli publish                write the dashboard payload
    python3 -m desk.cli config --preset small --equity 500
    python3 -m desk.cli halt / resume          the kill switch

Real orders require BOTH --live and --i-accept-total-loss, credentials in
the environment, and the absence of data/desk/STOP. Nothing here can send
an order by accident; the default for every command is paper.
"""
import argparse
import json
import os
import sys
import time

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from desk.core import config as cfgmod            # noqa: E402
from desk.core import evidence, money, risk, state as statemod   # noqa: E402
from desk.backtest import metrics                 # noqa: E402
from desk.backtest.engine import run_desk         # noqa: E402
from desk.backtest.walkforward import walk_forward  # noqa: E402
from desk.data import bars                        # noqa: E402
from desk.desks import base as deskbase           # noqa: E402
from desk import runner as runnermod              # noqa: E402

# Importing these registers them.
from desk.desks import overnight as _o            # noqa: E402,F401
try:
    from desk.desks import trend as _t            # noqa: E402,F401
except Exception:                                 # noqa: BLE001
    pass
try:
    from desk.desks import xsect as _x            # noqa: E402,F401
except Exception:                                 # noqa: BLE001
    pass
try:
    from desk.desks import reversion as _r        # noqa: E402,F401
except Exception:                                 # noqa: BLE001
    pass
try:
    from desk.desks import kalshi_bias as _k      # noqa: E402,F401
except Exception:                                 # noqa: BLE001
    pass

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
DASH = os.path.join(BASE, "dashboard", "data", "desk.json")
EVIDENCE = evidence.PATH
REPORT = os.path.join(BASE, "reports", "desk-evidence.md")


def _source_for(desk):
    return "alpaca" if desk.meta.asset_class == "crypto" else "yahoo"


def _load_series(desk, lookback=3650):
    src = _source_for(desk)
    days = min(lookback, 1500) if src == "alpaca" else lookback
    series = bars.load_many(list(desk.universe()), desk.meta.interval, src,
                            lookback_days=days)
    ts, aligned, dropped = bars.align(series, min_coverage=0.9)
    return aligned, dropped


# ------------------------------------------------------------------ commands
def cmd_desks(args):
    reg = deskbase.all_desks()
    if not reg:
        print("no desks registered")
        return 0
    print(f"{'name':<14}{'class':<10}{'venue':<10}{'floor':>8}{'turnover':>10}  universe")
    for name, cls in sorted(reg.items()):
        m = cls.meta
        print(f"{name:<14}{m.asset_class:<10}{m.venue:<10}${m.capital_floor:>7.0f}"
              f"{('daily' if len(m.events) > 1 else 'periodic'):>10}  "
              f"{','.join(m.universe[:6])}{'...' if len(m.universe) > 6 else ''}")
    return 0


def cmd_status(args):
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    st = statemod.load(bankroll=cfg.equity)
    rm = risk.RiskManager(st.cash, cfg.limits)
    print(cfgmod.describe(cfg))
    print()
    desks = [deskbase.get(n)() for n in cfg.desks if deskbase.get(n)]
    allocs = rm.allocate(desks, st.cash, explicit_desks=cfg.explicit_desks,
                         verdicts=evidence.verdicts())
    print("allocations")
    for a in allocs:
        mark = "on " if a.enabled else "OFF"
        print(f"  {mark} {a.name:<14}{a.weight:>7.1%}  {a.reason}")
    print()
    print(f"cash ${st.cash:,.2f} · positions {len(st.positions)} · "
          f"closed {st.trade_count} · mode {st.mode}")
    if rm.halt_reason:
        print(f"HALTED: {rm.halt_reason}")
    if os.path.exists(risk.STOP_FILE):
        print(f"STOP file present at {risk.STOP_FILE} — trading is disabled")
    return 0


def cmd_backtest(args):
    cls = deskbase.get(args.desk)
    if not cls:
        print(f"unknown desk {args.desk!r}; try `desks`")
        return 1
    d = cls()
    aligned, dropped = _load_series(d)
    if not aligned:
        print("no data")
        return 1
    print(f"{d.meta.title}: {len(aligned)} symbols, "
          f"{min(len(v) for v in aligned.values())} bars"
          + (f" (dropped {dropped} for short history)" if dropped else ""))
    res, st = run_desk(d, aligned, start_equity=args.equity)
    print("in-sample :", metrics.summarize(st))
    print(f"  fills {len(res.fills)} · fees ${res.fees_paid:.2f} "
          f"(floor ${res.fee_floor_paid:.2f}) · turnover {st.turnover_ann:.1f}x/yr")
    if not args.quick:
        grid = {k: [v] for k, v in d.params.items() if k in cls.param_grid()}
        wf = walk_forward(cls, aligned, start_equity=args.equity,
                          n_folds=args.folds, grid=grid or None)
        print("walk-fwd  :", metrics.summarize(wf.stats))
        for n in wf.notes:
            print("  note:", n)
    return 0


def cmd_validate(args):
    """Walk-forward every registered desk and write the evidence file.

    This is what the dashboard reads and what decides whether a desk is
    allowed to trade. A desk whose verdict is not 'validated' stays off.
    """
    out = {"generatedAt": int(time.time()), "folds": args.folds, "desks": {}}
    for name, cls in sorted(deskbase.all_desks().items()):
        d = cls()
        # Replay each desk at the size it claims to work from, unless the
        # operator asked for a specific size. Whole-share desks behave very
        # differently at $500 and $2,000, and a single global equity would
        # let a scheduled run silently re-grade every desk at the wrong size.
        eq = (float(args.equity) if getattr(args, "equity_explicit", False)
              else max(float(d.meta.capital_floor), 100.0))
        print(f"--- {name} (replayed at ${eq:,.0f}, {args.folds} folds)")
        try:
            aligned, dropped = _load_series(d)
            if not aligned:
                out["desks"][name] = {"verdict": "no-data", "equity": eq,
                                      "declared": getattr(d.meta, "status", "validated"),
                                      "declaredReason": getattr(d.meta, "status_reason", ""),
                                      "capitalFloor": d.meta.capital_floor}
                print("    no data")
                continue
            res, ins = run_desk(d, aligned, start_equity=eq)
            grid = {k: [v] for k, v in d.params.items() if k in cls.param_grid()}
            wf = walk_forward(cls, aligned, start_equity=eq,
                              n_folds=args.folds, grid=grid or None)
            bench = _benchmark(aligned, d)
            out["desks"][name] = {
                "title": d.meta.title,
                "assetClass": d.meta.asset_class,
                "venue": d.meta.venue,
                "capitalFloor": d.meta.capital_floor,
                "equity": eq,
                "folds": args.folds,
                "universe": list(d.meta.universe),
                "inSample": ins.to_dict(),
                "walkForward": wf.stats.to_dict() if wf.stats else None,
                "benchmark": bench,
                "fees": round(res.fees_paid, 2),
                "feeFloor": round(res.fee_floor_paid, 2),
                "turnoverAnn": round(ins.turnover_ann, 2),
                "verdict": (wf.stats.verdict if wf.stats else "no-walk-forward"),
                "declared": getattr(d.meta, "status", "validated"),
                "declaredReason": getattr(d.meta, "status_reason", ""),
                "notes": wf.notes,
                "droppedSymbols": dropped,
            }
            print("    in-sample:", metrics.summarize(ins))
            print("    walk-fwd :", metrics.summarize(wf.stats) if wf.stats else "n/a")
        except Exception as e:                                  # noqa: BLE001
            out["desks"][name] = {"verdict": "error", "error": str(e)[:300]}
            print("    ERROR", e)
    os.makedirs(os.path.dirname(EVIDENCE), exist_ok=True)
    with open(EVIDENCE, "w") as f:
        json.dump(out, f, indent=1)
    _write_evidence_report(out)
    print(f"\nwrote {EVIDENCE} and {REPORT}")
    return 0


def _benchmark(aligned, desk):
    """Buy-and-hold the desk's own universe, equal weighted."""
    syms = list(aligned)
    if not syms:
        return None
    n = min(len(v) for v in aligned.values())
    rets = []
    for i in range(n - 1):
        r = [aligned[s][i + 1].c / aligned[s][i].c - 1
             for s in syms if aligned[s][i].c > 0]
        if r:
            rets.append(sum(r) / len(r))
    if len(rets) < 30:
        return None
    st = metrics.compute(rets, periods_per_year=desk.meta.periods_per_year)
    return {"equalWeightBuyHold": st.to_dict()}


def _write_evidence_report(blob):
    lines = ["# Desk evidence", "",
             time.strftime("Generated %Y-%m-%d %H:%M UTC",
                           time.gmtime(blob["generatedAt"])), "",
             f"Walk-forward figures are out-of-sample with fixed parameters over "
             f"{blob.get('folds', '?')} windows (the first trains only, so one fewer",
             "is scored), each desk replayed at its own capital floor with every cost",
             "charged. The `declared` column is the desk author's",
             "verdict, which may be stricter than the statistic; the allocator funds a",
             "desk only when both agree and this record is under 30 days old, and funds",
             "a `marginal` desk only when it is named explicitly in `data/desk/config.json`.", "",
             "| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for name, d in sorted(blob.get("desks", {}).items()):
        wf = d.get("walkForward") or {}
        bm = ((d.get("benchmark") or {}).get("equalWeightBuyHold") or {})
        eq = d.get("equity")
        lines.append(
            f"| {name} | {d.get('verdict','?')} | {d.get('declared','—')} | {wf.get('sharpe','—')} | "
            f"{wf.get('cagr_pct','—')}% | {wf.get('max_drawdown_pct','—')}% | "
            f"{wf.get('p_value','—')} | {bm.get('sharpe','—')} | "
            f"{'$%s' % format(eq, ',.0f') if eq else '—'} | ${format(d.get('capitalFloor', 0), ',.0f')} |")
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w") as f:
        f.write("\n".join(lines) + "\n")


def _mode_for(args):
    if not args.live:
        return "paper"
    return "live-real-money" if not args.venue_paper else "live-paper-endpoint"


def _arm(args, cfg, st):
    """Broker for this process, or None for simulated fills. The state's
    mode is set here, once, so every published cycle says truthfully
    whether it was real money — `run` and `watch` must not differ.

    A book carries positions from exactly one mode. Paper lots replayed
    into a live account would be SOLD there — a short, or a rejection loop
    — so a mode change with positions on the book is refused unless the
    operator asks for a fresh book explicitly.
    """
    mode = _mode_for(args)
    if st.positions and st.mode != mode:
        if getattr(args, "reset_book", False):
            statemod.journal("book_reset", {"from": st.mode, "to": mode,
                                            "positions": len(st.positions)})
            st.positions, st.closed, st.equity_curve, st.decisions = [], [], [], {}
            st.cash = st.bankroll_start = float(cfg.equity)
        else:
            raise SystemExit(
                f"the book holds {len(st.positions)} position(s) opened in "
                f"{st.mode!r} mode; refusing to run in {mode!r} mode with them. "
                f"Close them in that mode, or pass --reset-book to start a fresh "
                f"book (the old lots are journalled, never traded).")
    if not args.live:
        st.mode = "paper"
        return None
    _arm_or_die(args, cfg)
    st.mode = mode
    return _make_broker(args)


def cmd_adopt(args):
    """Rebuild the book from what the venue actually holds.

    For the case the runner refuses to trade on: positions at the broker the
    book does not know about (a shift whose state was never committed, a
    manual trade). Every position in the configured universe becomes one
    confirmed lot at the broker's average entry; anything outside the
    universe is listed and left alone.
    """
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    st = statemod.load(bankroll=cfg.equity)
    if not args.live:
        raise SystemExit("adopt reads a venue: pass --live --i-accept-total-loss "
                         "(and --real-money for the real account)")
    _arm_or_die(args, cfg)
    venue = _make_broker(args).venue
    desks = [deskbase.get(n)() for n in cfg.desks if deskbase.get(n)]
    meta = runnermod.Runner.symbol_meta(desks)
    canon = {s.replace("/", "").replace("-", ""): s for s in meta}
    lots, skipped = [], []
    for r in venue.positions() or []:
        sym = canon.get(str(r.get("symbol", "")).replace("/", "").replace("-", ""))
        qty = abs(float(r.get("qty") or 0.0))
        if not sym or qty <= 0:
            skipped.append(f"{r.get('symbol')} x{r.get('qty')}")
            continue
        px = float(r.get("avg_entry_price") or 0.0)
        owner = next((d.meta.name for d in desks if sym in d.universe()), "portfolio")
        lots.append({"symbol": sym, "desk": owner, "side": "long", "shares": qty,
                     "targetShares": qty, "entry": px, "openedAt": int(time.time()),
                     "cost": qty * px, "openFee": 0.0, "liveCid": "adopted",
                     "liveOpen": True, "liveQty": qty, "orderType": "market",
                     "tif": "day"})
    statemod.journal("book_adopted", {"mode": _mode_for(args), "lots": len(lots),
                                      "skipped": skipped})
    st.positions = lots
    st.decisions = {}
    st.mode = _mode_for(args)
    statemod.save(st)
    print(f"adopted {len(lots)} position(s) from the venue into the book "
          f"({st.mode}):")
    for l in lots:
        print(f"  {l['symbol']:<10} {l['shares']:g} @ {l['entry']:.4f}  desk {l['desk']}")
    if skipped:
        print("left alone (outside the configured universe): " + ", ".join(skipped))
    return 0


def cmd_run(args):
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    st = statemod.load(bankroll=cfg.equity)
    broker = _arm(args, cfg, st)
    r = runnermod.Runner(cfg=cfg, st=st, broker=broker)
    tel = r.run_cycle()
    print(json.dumps(tel, indent=1)[:4000])
    _publish(tel, cfg, st)
    return 0


def cmd_watch(args):
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    st = statemod.load(bankroll=cfg.equity)
    broker = _arm(args, cfg, st)
    r = runnermod.Runner(cfg=cfg, st=st, broker=broker)
    deadline = time.time() + args.minutes * 60
    n = 0
    while time.time() < deadline:
        t0 = time.time()
        try:
            tel = r.run_cycle()
            n += 1
            print(f"{time.strftime('%H:%M:%S')} equity ${tel['equity']:.2f} "
                  f"pos {tel['positions']} exec {len(tel['executed'])} "
                  f"refused {len(tel['refused'])}", flush=True)
            _publish(tel, cfg, st)
        except Exception as e:                                  # noqa: BLE001
            print(f"cycle error: {e}", flush=True)
        if os.path.exists(risk.STOP_FILE):
            print("STOP file appeared — exiting", flush=True)
            break
        time.sleep(max(5.0, args.seconds - (time.time() - t0)))
    print(f"shift over after {n} cycles", flush=True)
    return 0


def _arm_or_die(args, cfg):
    """Every switch must be on at once. The flags are per-invocation; the
    config file's `live` is the one that lives in the repository, so the
    decision to point this at real money is visible in git history and
    cannot be made by a workflow secret alone."""
    if not (args.live and args.i_accept_total_loss):
        raise SystemExit("live execution requires both --live and "
                         "--i-accept-total-loss")
    if not args.venue_paper and not getattr(cfg, "live", False):
        raise SystemExit(
            "the real-money endpoint also requires data/desk/config.json to "
            "say \"live\": true — run `python3 -m desk.cli config --set-live true` "
            "and commit it")
    if os.path.exists(risk.STOP_FILE):
        raise SystemExit(f"STOP file present at {risk.STOP_FILE}")


def _make_broker(args):
    try:
        from desk.venues.alpaca import AlpacaVenue, NotArmed
    except Exception as e:                                      # noqa: BLE001
        raise SystemExit(f"venue adapter unavailable: {e}")
    try:
        return runnermod.LiveBroker(AlpacaVenue(paper=args.venue_paper))
    except NotArmed as e:
        raise SystemExit(f"not armed: {e}")


def _publish(tel, cfg, st):
    evidence = {}
    try:
        with open(EVIDENCE) as f:
            evidence = json.load(f)
    except (OSError, ValueError):
        pass
    payload = {
        "updatedAt": int(time.time()),
        "config": {"preset": cfg.preset, "equity": cfg.equity,
                   "live": cfg.live, "desks": list(cfg.desks),
                   "notes": cfg.notes},
        "cycle": tel,
        "account": {"cash": round(st.cash, 2), "bankrollStart": st.bankroll_start,
                    "positions": st.positions, "closedTrades": st.trade_count,
                    "equityCurve": st.equity_curve[-300:],
                    "recent": st.closed[-20:][::-1], "mode": st.mode},
        "evidence": evidence,
        "notes": ("Paper unless the account is explicitly armed. Walk-forward "
                  "figures are out-of-sample with fixed parameters, each desk "
                  "replayed at its own capital floor. A desk is funded only "
                  "when the statistic and the author's declared status agree; "
                  "a marginal desk runs only when named in the config file."),
    }
    os.makedirs(os.path.dirname(DASH), exist_ok=True)
    tmp = DASH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, DASH)
    return DASH


def cmd_publish(args):
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    st = statemod.load(bankroll=cfg.equity)
    path = _publish({"cycle": "publish-only"}, cfg, st)
    print("wrote", path)
    return 0


def cmd_config(args):
    cfg = cfgmod.load(equity=args.equity, preset=args.preset)
    if args.set_live is not None:
        cfg.live = args.set_live
    if args.desks is not None:
        names = tuple(n.strip() for n in args.desks.split(",") if n.strip())
        unknown = [n for n in names if not deskbase.get(n)]
        if unknown:
            raise SystemExit(f"unknown desk(s): {', '.join(unknown)}; see `desks`")
        cfg.desks = cfg.explicit_desks = names
    cfgmod.save(cfg)
    print(cfgmod.describe(cfg))
    return 0


def cmd_halt(args):
    os.makedirs(os.path.dirname(risk.STOP_FILE), exist_ok=True)
    with open(risk.STOP_FILE, "w") as f:
        f.write(f"halted {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n")
    print(f"STOP file written to {risk.STOP_FILE}. No desk will trade until "
          f"it is removed (`desk.cli resume`).")
    return 0


def cmd_resume(args):
    if os.path.exists(risk.STOP_FILE):
        os.remove(risk.STOP_FILE)
        print("STOP file removed — trading re-enabled")
    else:
        print("no STOP file present")
    return 0


def cmd_costs(args):
    """Show what trading actually costs at a given account size."""
    eq = args.equity
    print(f"cost model at ${eq:,.0f}\n")
    print("US equities")
    print(f"  commission                     $0.00")
    print(f"  regulatory floor, per active day  ${money.FEE_ROUNDING_FLOOR * money.FEE_TYPES_PER_DAY:.2f}")
    for days, label in ((250, "daily desk"), (12, "monthly rebalance")):
        annual = money.FEE_ROUNDING_FLOOR * money.FEE_TYPES_PER_DAY * days
        print(f"  {label:<22} {days:>4} active days = ${annual:>6.2f}/yr "
              f"= {annual/eq*100:>6.2f}% of ${eq:,.0f}")
    print("\ncrypto (Alpaca base tier)")
    print(f"  taker {money.CRYPTO_TAKER['alpaca']*1e4:.0f}bps · maker "
          f"{money.CRYPTO_MAKER['alpaca']*1e4:.0f}bps · BTC spread "
          f"{money.CRYPTO_SPREAD_BPS['BTC']}bps")
    print("\nKalshi (per contract, taker)")
    for p in (0.05, 0.25, 0.50, 0.75, 0.95):
        f = money.kalshi_fee(p, 1)
        print(f"  P={p:.2f}  fee ${f:.4f}  = {f/p*100:5.2f}% of stake · "
              f"edge needed to break even {money.kalshi_edge_required(p):.2f}pp")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--equity", type=float, default=None)
    ap.add_argument("--preset", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("desks").set_defaults(fn=cmd_desks)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("publish").set_defaults(fn=cmd_publish)
    sub.add_parser("halt").set_defaults(fn=cmd_halt)
    sub.add_parser("resume").set_defaults(fn=cmd_resume)
    sub.add_parser("costs").set_defaults(fn=cmd_costs)

    b = sub.add_parser("backtest")
    b.add_argument("desk")
    b.add_argument("--folds", type=int, default=5)
    b.add_argument("--quick", action="store_true")
    b.set_defaults(fn=cmd_backtest)

    v = sub.add_parser("validate")
    v.add_argument("--folds", type=int, default=5)
    v.set_defaults(fn=cmd_validate)

    for name, fn in (("run", cmd_run), ("watch", cmd_watch), ("adopt", cmd_adopt)):
        p = sub.add_parser(name)
        p.add_argument("--reset-book", action="store_true",
                       help="start a fresh book when switching modes with "
                            "positions on the old one (old lots are journalled)")
        p.add_argument("--live", action="store_true",
                       help="mirror decisions to a real venue (still needs "
                            "--i-accept-total-loss, keys, and no STOP file)")
        p.add_argument("--i-accept-total-loss", action="store_true")
        p.add_argument("--venue-paper", action="store_true", default=True,
                       help="use the broker's PAPER endpoint (default)")
        p.add_argument("--real-money", dest="venue_paper", action="store_false",
                       help="target the REAL MONEY endpoint")
        if name == "watch":
            p.add_argument("--minutes", type=float, default=110)
            p.add_argument("--seconds", type=float, default=300)
        p.set_defaults(fn=fn)

    c = sub.add_parser("config")
    c.add_argument("--set-live", type=lambda s: s.lower() == "true", default=None)
    c.add_argument("--desks", default=None,
                   help="comma-separated desks to run, named EXPLICITLY (this is "
                        "what opts a marginal desk in); omit to keep the preset's")
    c.set_defaults(fn=cmd_config)

    args = ap.parse_args()
    args.equity_explicit = args.equity is not None
    if args.equity is None:
        args.equity = cfgmod.load().equity
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
