#!/usr/bin/env python3
"""Real-time smart-money watcher.

Polls Polymarket's global trade feed (~every 45s), filters it to the
qualified watchlist, recomputes consensus signals on a rolling window, and
reacts within about a minute of the sharps moving — instead of a batch cycle.

  python3 watch.py                          # watch + journal (plan-only)
  python3 watch.py --paper                  # also advance the paper account
  python3 watch.py --execute                # place REAL orders (needs keys +
                                            #   the same flags as livetrade)
  python3 watch.py --duration-minutes 110   # exit after a shift (for CI)

New signals append to data/signals/latest.json and reports/signals-latest.md;
every reaction is journaled. A data/live/STOP file pauses real orders only.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import pmlib
import signals as sigmod

TRADES_URL = f"{pmlib.DATA_API}/trades"
SEEN_PATH = os.path.join(pmlib.BASE, "data", "live", "seen_signals.json")


def poll_feed(last_seen_ts, watch_set, max_pages=6):
    """Fetch platform trades newer than last_seen_ts; keep watchlist rows."""
    fresh, newest = [], last_seen_ts
    for page in range(max_pages):
        rows = pmlib.get_json(TRADES_URL, {"limit": 500, "offset": page * 500})
        if not rows:
            break
        for t in rows:
            ts = t.get("timestamp", 0)
            newest = max(newest, ts)
            if ts <= last_seen_ts:
                break
            w = (t.get("proxyWallet") or "").lower()
            if w in watch_set:
                fresh.append({
                    "wallet": w, "timestamp": ts,
                    "conditionId": t.get("conditionId"),
                    "outcomeIndex": t.get("outcomeIndex"),
                    "side": t.get("side"),
                    "usdcSize": (t.get("size") or 0) * (t.get("price") or 0),
                    "price": t.get("price"), "title": t.get("title"),
                })
        if rows[-1].get("timestamp", 0) <= last_seen_ts:
            break
    return fresh, newest


def run_step(script_args):
    subprocess.run([sys.executable] + script_args,
                   cwd=os.path.dirname(os.path.abspath(__file__)), check=False)


BRANCH = "claude/polymarket-wallets-analysis-m81p4j"


def git_publish(message):
    """Best-effort commit+push of live data so the site updates in minutes."""
    def git(*argv):
        return subprocess.run(["git", *argv], cwd=pmlib.BASE, check=False,
                              capture_output=True, text=True)
    git("add", "data/live", "data/signals", "data/paper", "reports",
        "dashboard/data")
    if git("diff", "--cached", "--quiet").returncode == 0:
        return
    git("commit", "-m", message)
    git("pull", "--rebase", "origin", BRANCH)
    r = git("push", "origin", f"HEAD:{BRANCH}")
    print("  site push:", "ok" if r.returncode == 0 else r.stderr.strip()[:200],
          flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--poll-seconds", type=int, default=45)
    ap.add_argument("--duration-minutes", type=float, default=0,
                    help="0 = run until stopped")
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--min-backers", type=int, default=3)
    ap.add_argument("--max-days", type=float, default=3)
    ap.add_argument("--min-pnl", type=float, default=100_000)
    ap.add_argument("--max-wallets", type=int, default=60)
    ap.add_argument("--paper", action="store_true",
                    help="run papertrade trade+mark when new signals land")
    ap.add_argument("--execute", action="store_true",
                    help="run livetrade execute on new signals (real money)")
    ap.add_argument("--git-push", action="store_true",
                    help="commit and push site data after each event/heartbeat")
    ap.add_argument("--heartbeat-minutes", type=float, default=30,
                    help="re-mark the paper account this often even when quiet")
    args = ap.parse_args()

    analyzed = pmlib.load_analyzed()
    watchlist = pmlib.build_watchlist(analyzed, min_pnl=args.min_pnl,
                                      max_wallets=args.max_wallets)
    watch_set = set(watchlist)
    print(f"Watching {len(watchlist)} qualified wallets · poll every "
          f"{args.poll_seconds}s · consensus ≥{args.min_backers} backers · "
          f"resolution ≤{args.max_days:g}d", flush=True)

    now = int(time.time())
    window = {a: list(ts) for a, ts in sigmod.recent_trades_live(
        list(watchlist), now - args.hours * 3600).items()}
    n_seed = sum(len(v) for v in window.values())
    print(f"Seeded rolling window: {n_seed:,} trades", flush=True)

    seen = set(tuple(k) for k in (json.load(open(SEEN_PATH))
                                  if os.path.exists(SEEN_PATH) else []))
    last_seen_ts = now
    deadline = time.time() + args.duration_minutes * 60 if args.duration_minutes else None

    last_heartbeat = time.time()
    while True:
        if deadline and time.time() > deadline:
            print("Shift over — exiting cleanly.", flush=True)
            break
        time.sleep(args.poll_seconds)
        if args.paper and time.time() - last_heartbeat > args.heartbeat_minutes * 60:
            last_heartbeat = time.time()
            run_step(["papertrade.py", "mark"])
            if args.git_push:
                git_publish("auto: heartbeat mark")
        try:
            fresh, last_seen_ts = poll_feed(last_seen_ts, watch_set)
        except Exception as e:  # noqa: BLE001 — a bad poll must not kill the watch
            print(f"poll error: {e}", flush=True)
            continue
        for t in fresh:
            window.setdefault(t["wallet"], []).append(t)
        cutoff = time.time() - args.hours * 3600
        if fresh or int(time.time()) % 600 < args.poll_seconds:
            window = {a: [t for t in ts if t["timestamp"] >= cutoff]
                      for a, ts in window.items()}
        if not fresh:
            continue

        print(f"{time.strftime('%H:%M:%S')} +{len(fresh)} watchlist trades",
              flush=True)
        sigs = sigmod.compute_signals(window, watchlist, int(time.time()),
                                      args.hours, min_backers=args.min_backers)
        new = [s for s in sigs
               if (s["conditionId"], s["outcomeIndex"]) not in seen]
        if not new:
            continue
        enriched = sigmod.enrich(new, top=10, max_days=args.max_days)
        if not enriched:
            for s in new[:50]:
                seen.add((s["conditionId"], s["outcomeIndex"]))
            continue

        meta = {"generatedAt": int(time.time()), "hours": args.hours,
                "watchlistSize": len(watchlist),
                "minBackers": args.min_backers, "live": True,
                "source": "watch.py"}
        sigmod.publish_signals({"meta": meta, "signals": enriched})
        for s in enriched:
            seen.add((s["conditionId"], s["outcomeIndex"]))
            print(f"  NEW SIGNAL [{s['score']:.1f}] {s['question']} -> "
                  f"{s['outcome']} @ {s['currentPrice']:.2f} "
                  f"({s['backerCount']} backers)", flush=True)
        os.makedirs(os.path.dirname(SEEN_PATH), exist_ok=True)
        with open(SEEN_PATH, "w") as f:
            json.dump([list(k) for k in seen], f)

        if args.paper:
            run_step(["papertrade.py", "trade"])
            run_step(["papertrade.py", "mark"])
        if args.execute:
            run_step(["livetrade.py", "execute", "--live",
                      "--i-accept-total-loss"])
        else:
            run_step(["livetrade.py", "plan"])
        if args.git_push:
            git_publish("auto: new signal reaction")


if __name__ == "__main__":
    main()
