#!/usr/bin/env python3
"""Smart-money signal engine.

Finds market outcomes that several *qualified* top wallets are independently
net-buying inside a recent window. Market-maker/HFT flow is excluded; each
backer must show real conviction (net stake vs their own median trade).

Usage:
  python3 signals.py                 # from cached data/raw trades
  python3 signals.py --live          # re-fetch the last --hours of trades
  python3 signals.py --hours 48 --min-backers 3 --top 15

Output: data/signals/latest.json and reports/signals-latest.md
"""
import argparse
import glob
import json
import math
import os
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import pmlib

RAW_DIR = os.path.join(pmlib.BASE, "data", "raw")
SIG_DIR = os.path.join(pmlib.BASE, "data", "signals")
REP_DIR = os.path.join(pmlib.BASE, "reports")


def recent_trades_cached(wallets, since):
    """Read qualifying wallets' trades newer than `since` from data/raw."""
    out = {}
    for addr in wallets:
        path = os.path.join(RAW_DIR, f"wallet_{addr}.json")
        try:
            with open(path) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            continue
        out[addr] = [t for t in raw["trades"] if t["timestamp"] >= since]
    return out


def recent_trades_live(wallets, since):
    """Fetch each wallet's trades since `since` straight from the API."""
    def one(addr):
        trades, cursor = [], None
        for _ in range(20):
            params = {"user": addr, "type": "TRADE", "limit": 500,
                      "sortBy": "TIMESTAMP", "sortDirection": "DESC"}
            if cursor is not None:
                params["end"] = cursor
            rows = pmlib.get_json(f"{pmlib.DATA_API}/activity", params)
            if not rows:
                break
            stop = False
            for t in rows:
                if t["timestamp"] < since:
                    stop = True
                    break
                trades.append({k: t.get(k) for k in (
                    "timestamp", "conditionId", "size", "usdcSize", "price",
                    "side", "outcome", "outcomeIndex", "title")})
            if stop or len(rows) < 500:
                break
            oldest = rows[-1]["timestamp"]
            cursor = oldest if cursor is None or oldest < cursor else cursor - 1
        return addr, trades

    out = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for addr, trades in ex.map(one, wallets):
            out[addr] = trades
    return out


def compute_signals(trades_by_wallet, watchlist, now, hours,
                    min_net_usd=200.0, min_conviction=0.5, min_backers=2,
                    dominance=1.5):
    """Score consensus per market outcome.

    A wallet's stance in a market is its single best-net outcome, discounted
    by anything it spent on the other side — a trader who bought both sides
    of a game has hedged, not spoken. Markets where two outcomes both attract
    real backing are contested: only a side that beats the other by
    `dominance`× survives; otherwise the market emits no signal at all.
    """
    # (conditionId) -> wallet -> outcomeIndex -> flow
    flows = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {
        "net": 0.0, "bought": 0.0, "px_num": 0.0, "last": 0})))
    titles = {}
    for addr, trades in trades_by_wallet.items():
        for t in trades:
            cid = t["conditionId"]
            f = flows[cid][addr][t.get("outcomeIndex") or 0]
            usd = t.get("usdcSize") or 0
            if t["side"] == "BUY":
                f["net"] += usd
                f["bought"] += usd
                f["px_num"] += usd * (t.get("price") or 0)
            else:
                f["net"] -= usd
            f["last"] = max(f["last"], t["timestamp"])
            titles.setdefault(cid, t.get("title"))

    per_market = defaultdict(lambda: defaultdict(list))  # cid -> oi -> backers
    for cid, per_wallet in flows.items():
        for addr, by_outcome in per_wallet.items():
            w = watchlist[addr]
            best_oi = max(by_outcome, key=lambda oi: by_outcome[oi]["net"])
            f = by_outcome[best_oi]
            hedged = sum(max(0.0, by_outcome[oi]["net"])
                         for oi in by_outcome if oi != best_oi)
            net = f["net"] - hedged
            conviction = net / max(w["medianTrade"], 1.0)
            if net < min_net_usd or conviction < min_conviction:
                continue
            age_h = (now - f["last"]) / 3600
            recency = math.exp(-age_h / max(hours / 2, 1))
            avg_px = f["px_num"] / f["bought"] if f["bought"] else None
            per_market[cid][best_oi].append({
                "wallet": addr, "name": w["name"], "quality": w["quality"],
                "netUsd": round(net, 2),
                "avgPrice": round(avg_px, 4) if avg_px else None,
                "conviction": round(min(conviction, 10.0), 2),
                "lastTradeAgoH": round(age_h, 1),
                "score": w["quality"] * min(conviction, 10.0) ** 0.5 * recency,
            })

    signals = []
    for cid, sides in per_market.items():
        scored = sorted(((sum(b["score"] for b in bs), oi, bs)
                         for oi, bs in sides.items()), reverse=True)
        top_score, top_oi, top_backers = scored[0]
        if len(scored) > 1 and top_score < dominance * scored[1][0]:
            continue  # contested market — the sharps disagree; no signal
        if len(top_backers) < min_backers:
            continue
        top_backers.sort(key=lambda b: -b["score"])
        signals.append({
            "conditionId": cid, "outcomeIndex": top_oi,
            "title": titles.get(cid),
            "backers": top_backers,
            "backerCount": len(top_backers),
            "contested": len(scored) > 1,
            "totalNetUsd": round(sum(b["netUsd"] for b in top_backers), 2),
            "score": round(top_score, 4),
        })
    signals.sort(key=lambda s: -s["score"])
    return signals


def enrich(signals, top, max_drift=0.15):
    """Attach live market metadata; drop dead or priced-out markets."""
    res = pmlib.MarketResolver()
    kept = []
    for s in signals:
        if len(kept) >= top:
            break
        m = res.get(s["conditionId"])
        if not m or m["closed"]:
            continue
        oi = s["outcomeIndex"] if s["outcomeIndex"] is not None else 0
        prices = m["outcomePrices"]
        cur = prices[oi] if oi < len(prices) else None
        if cur is None or cur > 0.93 or cur < 0.03:
            continue  # no room left, or a lottery ticket
        wavg_entry = [b["avgPrice"] for b in s["backers"] if b["avgPrice"]]
        entry = sum(wavg_entry) / len(wavg_entry) if wavg_entry else None
        if entry is not None and cur - entry > max_drift:
            continue  # the move already happened; copying now is chasing
        s.update({
            "question": m["question"],
            "outcome": m["outcomes"][oi] if oi < len(m["outcomes"]) else None,
            "tokenId": m["clobTokenIds"][oi] if oi < len(m["clobTokenIds"]) else None,
            "currentPrice": cur,
            "backersAvgEntry": round(entry, 4) if entry else None,
            "driftSinceEntry": round(cur - entry, 4) if entry else None,
            "endDate": m["endDate"],
        })
        kept.append(s)
    res.save()
    return kept


def write_report(signals, meta):
    os.makedirs(REP_DIR, exist_ok=True)
    lines = [
        "# Smart-money signals",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(meta['generatedAt']))} · "
        f"window {meta['hours']}h · {meta['watchlistSize']} qualified wallets watched · "
        f"minimum {meta['minBackers']} independent backers per signal.",
        "",
        "A signal means several historically profitable wallets (market makers excluded) "
        "independently put meaningful money on the same outcome recently. It is information, "
        "not a guarantee — treat it as a shortlist for your own judgment.",
        "",
    ]
    if not signals:
        lines.append("_No qualifying consensus signals in this window._")
    for i, s in enumerate(signals, 1):
        drift = s.get("driftSinceEntry")
        drift_txt = ("already moved " if (drift or 0) > 0.02 else
                     "moved against them " if (drift or 0) < -0.02 else "roughly flat ")
        lines += [
            f"## {i}. {s['question']} — **{s['outcome']}**",
            "",
            f"- Score **{s['score']:.2f}** · {s['backerCount']} backers · "
            f"net ${s['totalNetUsd']:,.0f} staked",
            f"- Backers' average entry {s['backersAvgEntry'] and format(s['backersAvgEntry'], '.2f')} → "
            f"current price **{s['currentPrice']:.2f}** "
            f"({drift_txt}{drift:+.2f} since entry)" if s.get("backersAvgEntry") else
            f"- Current price **{s['currentPrice']:.2f}**",
            f"- Resolves by {(s.get('endDate') or 'unknown')[:10]}",
            "",
            "| backer | 90d PnL rank quality | net stake | their entry | conviction ×median |",
            "|---|---|---|---|---|",
        ]
        for b in s["backers"][:6]:
            lines.append(
                f"| {b['name']} | {b['quality']:.2f} | ${b['netUsd']:,.0f} | "
                f"{b['avgPrice'] if b['avgPrice'] else '—'} | {b['conviction']}× |")
        lines.append("")
    with open(os.path.join(REP_DIR, "signals-latest.md"), "w") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live", action="store_true", help="fetch fresh trades from the API")
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--min-backers", type=int, default=2)
    ap.add_argument("--min-net-usd", type=float, default=200.0)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--min-pnl", type=float, default=100_000)
    ap.add_argument("--max-wallets", type=int, default=60)
    args = ap.parse_args()

    analyzed = pmlib.load_analyzed()
    watchlist = pmlib.build_watchlist(analyzed, min_pnl=args.min_pnl,
                                      max_wallets=args.max_wallets)
    now = int(time.time())
    since = now - args.hours * 3600
    print(f"Watchlist: {len(watchlist)} qualified wallets")

    fetch = recent_trades_live if args.live else recent_trades_cached
    trades = fetch(list(watchlist), since)
    n_tr = sum(len(v) for v in trades.values())
    print(f"Trades in window: {n_tr}")

    signals = compute_signals(trades, watchlist, now, args.hours,
                              min_net_usd=args.min_net_usd,
                              min_backers=args.min_backers)
    print(f"Raw consensus candidates: {len(signals)}")
    signals = enrich(signals, args.top)
    print(f"Live signals after enrichment: {len(signals)}")

    meta = {"generatedAt": now, "hours": args.hours,
            "watchlistSize": len(watchlist), "minBackers": args.min_backers,
            "live": args.live}
    os.makedirs(SIG_DIR, exist_ok=True)
    with open(os.path.join(SIG_DIR, "latest.json"), "w") as f:
        json.dump({"meta": meta, "signals": signals}, f, indent=1)
    write_report(signals, meta)
    print(f"Wrote data/signals/latest.json and reports/signals-latest.md")
    for s in signals[:8]:
        print(f"  [{s['score']:6.2f}] {s['question'][:60]} -> {s['outcome']}"
              f" @ {s['currentPrice']:.2f} ({s['backerCount']} backers)")


if __name__ == "__main__":
    main()
