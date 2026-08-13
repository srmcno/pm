#!/usr/bin/env python3
"""Paper-trading simulator for the smart-money signal strategy.

Live loop (no real money ever moves):
  python3 papertrade.py init --bankroll 20
  python3 papertrade.py trade          # act on data/signals/latest.json
  python3 papertrade.py mark           # mark to market, settle, report

Backtest (the honest test — run this before believing anything):
  python3 papertrade.py backtest --bankroll 20 --delay-hours 6

The backtest avoids hindsight bias: wallets qualify for the watchlist using
only the FIRST HALF of the 90-day window, then the strategy trades the
SECOND HALF. Entry fills come from real CLOB price history at signal time
plus a copy delay, so the latency cost of copying is measured, not assumed.
Residual look-ahead: archetype labels (used to exclude market-maker flow)
are computed over the full window.

State lives in data/paper/, reports in reports/.
"""
import argparse
import bisect
import json
import os
import time

import pmlib
import signals as sigmod

PAPER_DIR = os.path.join(pmlib.BASE, "data", "paper")
REP_DIR = os.path.join(pmlib.BASE, "reports")
STATE = os.path.join(PAPER_DIR, "state.json")
DAY = 86400


def load_state():
    with open(STATE) as f:
        return json.load(f)


def save_state(st):
    os.makedirs(PAPER_DIR, exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f, indent=1)


# ------------------------------------------------------------------ live

def cmd_init(args):
    if os.path.exists(STATE) and not args.force:
        raise SystemExit("state exists; use --force to reset")
    save_state({"bankrollStart": args.bankroll, "cash": args.bankroll,
                "createdAt": int(time.time()), "positions": [], "closed": [],
                "equityCurve": [], "log": []})
    print(f"Paper account funded with ${args.bankroll:.2f} (virtual).")


def cmd_trade(args):
    st = load_state()
    with open(os.path.join(pmlib.BASE, "data", "signals", "latest.json")) as f:
        payload = json.load(f)
    sigs = [s for s in payload["signals"] if s["score"] >= args.min_score]
    held = {(p["conditionId"], p["outcomeIndex"]) for p in st["positions"]}
    ever = held | {(p["conditionId"], p["outcomeIndex"]) for p in st["closed"]}
    now = int(time.time())
    placed = 0
    for s in sigs:
        key = (s["conditionId"], s["outcomeIndex"])
        if key in ever or len(st["positions"]) >= args.max_positions:
            continue
        stake = round(st["cash"] * args.risk_frac, 2)
        if stake < 1.0:
            continue
        px = pmlib.midpoint(s["tokenId"]) or s["currentPrice"]
        fill = min(0.99, px + args.slippage)
        if fill > args.max_price:
            continue  # the live rails cap entries at max_price; the paper
                      # record must trade the same book to stay predictive
        shares = round(stake / fill, 4)
        st["cash"] = round(st["cash"] - stake, 4)
        st["positions"].append({
            "conditionId": s["conditionId"], "outcomeIndex": s["outcomeIndex"],
            "tokenId": s["tokenId"], "question": s["question"],
            "outcome": s["outcome"], "shares": shares, "entryPrice": fill,
            "costUsd": stake, "openedAt": now, "signalScore": s["score"]})
        st["log"].append({"t": now, "action": "BUY", "question": s["question"],
                          "outcome": s["outcome"], "stake": stake, "price": fill})
        placed += 1
        print(f"BUY {s['question'][:55]} -> {s['outcome']} @ {fill:.2f} (${stake:.2f})")
    save_state(st)
    print(f"{placed} paper orders placed · cash ${st['cash']:.2f} · "
          f"{len(st['positions'])} open positions")


def cmd_mark(args):
    st = load_state()
    res = pmlib.MarketResolver()
    now = int(time.time())
    still_open, value = [], 0.0
    for p in st["positions"]:
        m = res.get(p["conditionId"])
        oi = p["outcomeIndex"] or 0
        px = (m["outcomePrices"][oi]
              if m and oi < len(m["outcomePrices"]) else p["entryPrice"])
        # Settle only at a final price. A market can be closed to trading
        # while resolution is pending, with outcomePrices still showing the
        # last trade — booking that would misstate every winner and loser.
        final = m and m["closed"] and (m.get("resolved")
                                       or px >= 0.99 or px <= 0.01)
        if final:
            proceeds = round(p["shares"] * px, 4)
            st["cash"] = round(st["cash"] + proceeds, 4)
            p.update({"settledAt": now, "settlePrice": px,
                      "pnl": round(proceeds - p["costUsd"], 4)})
            st["closed"].append(p)
            st["log"].append({"t": now, "action": "SETTLE",
                              "question": p["question"], "price": px,
                              "pnl": p["pnl"]})
            print(f"SETTLED {p['question'][:55]} @ {px:.2f} pnl {p['pnl']:+.2f}")
        else:
            p["markPrice"] = px
            p["valueUsd"] = round(p["shares"] * px, 4)
            value += p["valueUsd"]
            still_open.append(p)
    st["positions"] = still_open
    res.save()
    equity = round(st["cash"] + value, 4)
    st["equityCurve"].append({"t": now, "equity": equity, "cash": st["cash"]})
    save_state(st)

    ret = (equity / st["bankrollStart"] - 1) * 100
    os.makedirs(REP_DIR, exist_ok=True)
    lines = [
        "# Paper portfolio",
        "",
        f"Updated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(now))} · "
        f"started with ${st['bankrollStart']:.2f} (virtual)",
        "",
        f"**Equity ${equity:.2f} ({ret:+.1f}%)** · cash ${st['cash']:.2f} · "
        f"{len(st['positions'])} open · {len(st['closed'])} settled",
        "",
        "| market | side | shares | entry | mark | value |",
        "|---|---|---|---|---|---|",
    ]
    for p in st["positions"]:
        lines.append(f"| {p['question']} | {p['outcome']} | {p['shares']:.2f} "
                     f"| {p['entryPrice']:.2f} | {p.get('markPrice', 0):.2f} "
                     f"| ${p.get('valueUsd', 0):.2f} |")
    if st["closed"]:
        lines += ["", "| settled market | side | entry | settle | PnL |", "|---|---|---|---|---|"]
        for p in st["closed"][-15:]:
            lines.append(f"| {p['question']} | {p['outcome']} | {p['entryPrice']:.2f} "
                         f"| {p['settlePrice']:.2f} | {p['pnl']:+.2f} |")
    with open(os.path.join(REP_DIR, "paper-latest.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    # copy for the live dashboard (served by GitHub Pages)
    dash_data = os.path.join(pmlib.BASE, "dashboard", "data")
    os.makedirs(dash_data, exist_ok=True)
    with open(os.path.join(dash_data, "paper.json"), "w") as f:
        json.dump({
            "updatedAt": now, "bankrollStart": st["bankrollStart"],
            "equity": equity, "cash": st["cash"],
            "positions": st["positions"],
            "closed": st["closed"][-15:],
            "closedCount": len(st["closed"]),
            "wins": sum(1 for p in st["closed"] if p["pnl"] > 0),
            "equityCurve": st["equityCurve"][-180:],
        }, f)
    print(f"Equity ${equity:.2f} ({ret:+.1f}%) -> reports/paper-latest.md")


# -------------------------------------------------------------- backtest

def first_half_pnl(w, cutoff, mid_ts):
    series = w.get("pnlDaily") or []
    if len(series) < 10:
        return None
    h1 = [p["p"] for p in series if p["t"] <= mid_ts]
    return h1[-1] - h1[0] if len(h1) >= 2 else None


def cmd_backtest(args):
    analyzed = pmlib.load_analyzed()
    cutoff = analyzed["cutoff"]
    end_ts = analyzed["generatedAt"]
    if args.train_days:
        mid_ts = cutoff + int(args.train_days * 86400)
        if not cutoff < mid_ts < end_ts:
            raise SystemExit("--train-days must fall inside the data window")
    else:
        mid_ts = cutoff + (end_ts - cutoff) // 2

    # Watchlist from FIRST-HALF performance only.
    cats = ([c.strip() for c in args.categories.split(",")]
            if getattr(args, "categories", None) else None)
    for w in analyzed["wallets"]:
        w["pnlH1"] = first_half_pnl(w, cutoff, mid_ts)
    pool = {"wallets": [w for w in analyzed["wallets"] if w["pnlH1"] is not None]}
    watchlist = pmlib.build_watchlist(pool, min_pnl=args.min_pnl,
                                      max_wallets=args.max_wallets,
                                      pnl_key="pnlH1", categories=cats)
    print(f"Watchlist (first-half qualifiers): {len(watchlist)} wallets"
          + (f" · desk: {'+'.join(cats)}" if cats else ""))

    # Their second-half trades (plus the lookback runway), sorted ascending
    # once so each step can slice its window with bisect instead of scanning.
    trades_all = sigmod.recent_trades_cached(list(watchlist),
                                             mid_ts - args.hours * 3600)
    ts_index = {}
    for a, ts_list in trades_all.items():
        ts_list.sort(key=lambda t: t["timestamp"])
        ts_index[a] = [t["timestamp"] for t in ts_list]
    print(f"Second-half trades loaded: {sum(len(v) for v in trades_all.values()):,}")

    res = pmlib.MarketResolver()
    cash, equity_curve, positions, closed_trades = args.bankroll, [], [], []
    ever = set()
    delay = args.delay_hours * 3600
    latency_costs = []

    step = int(args.step_hours * 3600)
    day = mid_ts
    while day <= end_ts:
        lo = day - args.hours * 3600
        window_trades = {}
        for a, ts_list in trades_all.items():
            i = bisect.bisect_left(ts_index[a], lo)
            j = bisect.bisect_right(ts_index[a], day)
            window_trades[a] = ts_list[i:j]
        sigs = sigmod.compute_signals(window_trades, watchlist, day, args.hours,
                                      min_backers=args.min_backers)
        if cats:
            sigs = [s for s in sigs if s["category"] in cats]
        # entries
        for s in sigs[:args.top_per_day]:
            key = (s["conditionId"], s["outcomeIndex"])
            if key in ever or len(positions) >= args.max_positions:
                continue
            m = res.get(s["conditionId"])
            oi = s["outcomeIndex"] if s["outcomeIndex"] is not None else 0
            if not m or oi >= len(m.get("clobTokenIds") or []):
                continue
            token = m["clobTokenIds"][oi]
            sig_px, _ = pmlib.price_at(token, day, window=2 * 3600)
            fill_px, fill_t = pmlib.price_at(token, day + delay, window=2 * 3600)
            if fill_px is None or not (0.03 <= fill_px <= 0.93):
                continue
            stake = round(cash * args.risk_frac, 4)
            if stake < 0.5:
                continue
            fill_px = min(0.99, fill_px + args.slippage)
            cash -= stake
            ever.add(key)
            if sig_px:
                latency_costs.append(fill_px - args.slippage - sig_px)
            positions.append({
                "key": key, "token": token, "question": m["question"],
                "outcome": (m["outcomes"][oi] if oi < len(m["outcomes"]) else str(oi)),
                "shares": stake / fill_px, "entry": fill_px, "cost": stake,
                "openedAt": fill_t, "path": None})
        # mark / settle
        value = 0.0
        for p in positions[:]:
            if p["path"] is None:
                p["path"] = pmlib.price_history(p["token"], p["openedAt"],
                                                end_ts + DAY, fidelity=720)
            px = None
            for pt in p["path"]:
                if pt["t"] <= day:
                    px = pt["p"]
                else:
                    break
            last_t = p["path"][-1]["t"] if p["path"] else p["openedAt"]
            m = res.get(p["key"][0])
            if m and m["closed"] and day > last_t + DAY:
                oi = p["key"][1] if p["key"][1] is not None else 0
                final = m["outcomePrices"][oi] if oi < len(m["outcomePrices"]) else 0.0
                proceeds = p["shares"] * final
                cash += proceeds
                closed_trades.append({**p, "settle": final,
                                      "pnl": proceeds - p["cost"]})
                positions.remove(p)
            else:
                value += p["shares"] * (px if px is not None else p["entry"])
        equity_curve.append({"t": day, "equity": round(cash + value, 4)})
        if len(equity_curve) % 20 == 0:
            print(f"  step {len(equity_curve)}: "
                  f"{time.strftime('%b %d', time.gmtime(day))} · "
                  f"equity ${cash + value:.2f} · {len(ever)} entered",
                  flush=True)
        day += step

    # liquidate whatever is still open at the end-of-window mark
    final_equity = equity_curve[-1]["equity"]
    res.save()

    wins = [t for t in closed_trades if t["pnl"] > 0]
    ret = (final_equity / args.bankroll - 1) * 100
    gross_profit = sum(t["pnl"] for t in wins)
    top3 = sum(t["pnl"] for t in
               sorted((t for t in wins), key=lambda x: -x["pnl"])[:3])
    concentration = (top3 / gross_profit) if gross_profit > 0 else 0.0
    peak, mdd = 0.0, 0.0
    for pt in equity_curve:
        peak = max(peak, pt["equity"])
        mdd = min(mdd, pt["equity"] - peak)
    lat = (sum(latency_costs) / len(latency_costs)) if latency_costs else 0.0

    verdict = (
        "Copying did NOT beat holding cash in this window. The latency cost is real. Do not fund this."
        if ret <= 0 else
        "Positive, but the profit sits in a handful of trades — one window of luck, not proof. Keep paper trading; do not fund."
        if concentration > 0.6 or len(closed_trades) < 15 else
        "The strategy showed a broad-based edge in this window — worth continuing to paper trade across more weeks before drawing conclusions."
        if ret > 15 else
        "Mildly positive and diversified — interesting, unproven. Keep paper trading; do not fund."
    )
    now = int(time.time())
    os.makedirs(REP_DIR, exist_ok=True)
    os.makedirs(PAPER_DIR, exist_ok=True)
    lines = [
        "# Copy-trading backtest — out-of-sample",
        "",
        f"Run {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(now))} · "
        f"virtual bankroll ${args.bankroll:.2f} · copy delay {args.delay_hours}h · "
        f"{args.risk_frac:.0%} of cash per position, max {args.max_positions} open.",
        "",
        "Watchlist chosen on first-half PnL only; traded on the second half "
        f"({time.strftime('%b %d', time.gmtime(mid_ts))} – "
        f"{time.strftime('%b %d', time.gmtime(end_ts))}). Entries filled from real "
        "price history after the copy delay, +1¢ slippage.",
        "",
        f"## Result: ${args.bankroll:.2f} → **${final_equity:.2f}** ({ret:+.1f}%)",
        "",
        f"- Trades entered: {len(ever)} · settled: {len(closed_trades)} · "
        f"open at end: {len(positions)}",
        f"- Settled win rate: {len(wins)}/{len(closed_trades)}"
        f" ({(len(wins)/len(closed_trades)*100 if closed_trades else 0):.0f}%)",
        f"- Max drawdown: ${mdd:.2f}",
        f"- Average latency cost (fill vs signal-time price): {lat*100:+.1f}¢ per share",
        f"- Profit concentration: top 3 winners = {concentration*100:.0f}% of gross profit",
        "",
        f"**Verdict: {verdict}**",
        "",
        "## Settled trades",
        "",
        "| market | side | entry | settle | PnL |",
        "|---|---|---|---|---|",
    ]
    for t in sorted(closed_trades, key=lambda x: -abs(x["pnl"]))[:40]:
        lines.append(f"| {t['question']} | {t['outcome']} | {t['entry']:.2f} "
                     f"| {t['settle']:.2f} | {t['pnl']:+.2f} |")
    lines += ["", "## Equity curve (daily)", "", "| date | equity |", "|---|---|"]
    for pt in equity_curve:
        lines.append(f"| {time.strftime('%Y-%m-%d', time.gmtime(pt['t']))} "
                     f"| ${pt['equity']:.2f} |")
    with open(os.path.join(REP_DIR, "backtest-latest.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(PAPER_DIR, "backtest.json"), "w") as f:
        json.dump({"meta": vars(args), "finalEquity": final_equity,
                   "equityCurve": equity_curve, "closed": [
                       {k: v for k, v in t.items() if k != "path"}
                       for t in closed_trades]}, f, indent=1, default=str)
    print(f"\n${args.bankroll:.2f} -> ${final_equity:.2f} ({ret:+.1f}%) · "
          f"{len(closed_trades)} settled · win rate "
          f"{(len(wins)/len(closed_trades)*100 if closed_trades else 0):.0f}% · "
          f"latency cost {lat*100:+.1f}¢/share")
    print(f"Verdict: {verdict}")
    print("Full report: reports/backtest-latest.md")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init");  p.add_argument("--bankroll", type=float, default=20.0)
    p.add_argument("--force", action="store_true"); p.set_defaults(fn=cmd_init)

    p = sub.add_parser("trade")
    p.add_argument("--max-positions", type=int, default=8)
    p.add_argument("--risk-frac", type=float, default=0.08)
    p.add_argument("--min-score", type=float, default=0.8)
    p.add_argument("--slippage", type=float, default=0.01)
    p.add_argument("--max-price", type=float, default=0.90,
                   help="skip fills above this, mirroring the live rails")
    p.set_defaults(fn=cmd_trade)

    p = sub.add_parser("mark"); p.set_defaults(fn=cmd_mark)

    p = sub.add_parser("backtest")
    p.add_argument("--bankroll", type=float, default=20.0)
    p.add_argument("--delay-hours", type=float, default=1.0)
    p.add_argument("--step-hours", type=float, default=6.0,
                   help="how often the simulated bot recomputes signals")
    p.add_argument("--train-days", type=float, default=None,
                   help="watchlist qualifies on the first N days (default: half)")
    p.add_argument("--categories", default=None,
                   help="specialist desk: comma-separated categories")
    p.add_argument("--hours", type=int, default=72, help="signal lookback")
    p.add_argument("--min-backers", type=int, default=2)
    p.add_argument("--min-pnl", type=float, default=50_000,
                   help="first-half PnL to qualify for the watchlist")
    p.add_argument("--max-wallets", type=int, default=60)
    p.add_argument("--top-per-day", type=int, default=5)
    p.add_argument("--max-positions", type=int, default=10)
    p.add_argument("--risk-frac", type=float, default=0.08)
    p.add_argument("--slippage", type=float, default=0.01)
    p.set_defaults(fn=cmd_backtest)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
