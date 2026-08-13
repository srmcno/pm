#!/usr/bin/env python3
"""Wallet edge profiles: what each tracked wallet has actually proven, per category.

The consensus engine asks one question of every wallet before counting its
vote: "have you made money in THIS kind of market, repeatably?" Answering it
needs a per-category settled record, which does not exist in analyzed.json --
that file knows how much volume a wallet did in Sports, not whether it won.

So this rebuilds the record from the raw trade history: every (market,
outcome) a wallet touched is folded into a round trip, settled against the
market's resolution, and booked to a category. The output is

    data/edge_profiles.json

    { wallet: { pnl90, sharpe, pnlDays, categoryShare, excluded, exclusionReason,
                categories: { Sports: { settledTrades, wins, roi,
                                        cohortWinRate, cohortRoi } } } }

Usage:
  python3 -m pmx.profiles                  # from data/raw (run fetch_data.py first)
  python3 -m pmx.profiles --degraded       # metadata only; no category evidence

Two things this deliberately does NOT do. It does not count open positions as
performance -- Polymarket's PnL series is realized plus mark-to-market, and a
wallet whose profit is all marks has proven nothing yet. And it does not
invent a category record when the trade history is missing: the degraded
profile carries no category evidence at all, and the engine's response to that
is to refuse to size a live order, not to guess.
"""
import argparse
import glob
import json
import math
import os
import statistics as st
import sys
import time
from collections import defaultdict

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pmlib                                       # noqa: E402
from analyze import classify                       # noqa: E402

RAW_DIR = os.path.join(pmlib.BASE, "data", "raw")
OUT_PATH = os.path.join(pmlib.BASE, "data", "edge_profiles.json")

# Archetypes whose flow is inventory management rather than opinion.
NOISE_ARCHETYPES = {"Market maker / HFT", "Crypto scalper"}


# ------------------------------------------------------- wash / MM filters

def exclusion_reason(w, cfg):
    """Why this wallet's fills should not be copied, as (code, detail), or None.

    The code is a stable category for aggregation; the detail carries the
    numbers that triggered it.

    The archetype rules in analyze.py catch makers that quote both sides. They
    miss the other wash-trading shape entirely: a wallet turning over tens of
    millions for a rounding error of profit, one-sided, at hundreds of trades
    a day. In the cohort, `cc9999` does $46.5M of volume for $27.6k of PnL --
    a 1,686x volume-to-profit ratio at 567 trades/day, with a both-sides share
    of exactly 0.00, so every existing filter waves it through. That is a
    rebate farm or a wash loop, and its fills carry no directional opinion.
    """
    if w.get("truncated"):
        return ("truncated-history",
                "trade history hit the pagination cap — record is incomplete")
    if w.get("archetype") in NOISE_ARCHETYPES:
        return ("noise-archetype",
                f"archetype {w['archetype']} — liquidity provision, not opinion")
    if (w.get("bothSidesShare") or 0) >= cfg["max_both_sides"]:
        return ("two-sided-inventory",
                f"buys both outcomes in {w['bothSidesShare']:.0%} of markets — "
                f"hedged inventory, not a stance")
    pnl = w.get("pnl90")
    if pnl is None or pnl <= 0:
        return ("unprofitable", "no positive 90-day PnL")
    vol = w.get("volume90") or 0.0
    ratio = vol / max(abs(pnl), 1.0)
    tpd = w.get("tradesPerActiveDay") or 0
    if ratio >= cfg["max_vol_pnl_ratio"] and tpd >= cfg["wash_trades_per_day"]:
        return ("wash-fingerprint",
                f"${vol:,.0f} volume for ${pnl:,.0f} PnL ({ratio:.0f}x) at "
                f"{tpd:.0f} trades/day — wash/rebate fingerprint")
    if (w.get("winDayRate") or 0) < cfg["min_win_day_rate"]:
        return ("low-win-days",
                f"win-day rate {w.get('winDayRate')} below "
                f"{cfg['min_win_day_rate']:.2f} floor")
    if pnl < cfg["min_pnl"]:
        return ("small-pnl",
                f"90-day PnL ${pnl:,.0f} below ${cfg['min_pnl']:,.0f} floor")
    return None


# ------------------------------------------------------------------ Sharpe

def daily_sharpe(w):
    """Annualized Sharpe of daily PnL deltas, and the sample size behind it.

    This is a dollar-Sharpe (mean over standard deviation of the same units),
    which is scale free, but it is computed on a mark-to-market series, so it
    is optimistic and autocorrelated -- the cohort's p95 is 13.5, a number no
    honest strategy posts. The engine shrinks it by sample size and clamps it
    hard rather than trusting the level; `pnlDays` is returned so the caller
    knows how much to trust.
    """
    series = w.get("pnlDaily") or []
    if len(series) < 3:
        return None, 0
    vals = [p["p"] for p in series]
    deltas = [b - a for a, b in zip(vals, vals[1:])]
    deltas = [d for d in deltas if abs(d) > 1e-9]
    if len(deltas) < 3:
        return None, len(deltas)
    sd = st.pstdev(deltas)
    if sd <= 0:
        return None, len(deltas)
    return (st.mean(deltas) / sd) * math.sqrt(365), len(deltas)


# ------------------------------------------------- per-category settled record

class CachedResolver:
    """Read-only view over a warmed market cache.

    MarketResolver refreshes any open market older than its TTL, which is
    right for live trading and catastrophic here: a profile build touches
    ~16,000 markets, almost all still open and none of them evidence, and
    refreshing each one turns a two-minute job into an hour. Profiles only
    care about settled markets, and those never change once resolved.
    """

    def __init__(self, resolver):
        self.cache = resolver.cache
        self.misses = 0

    def get(self, condition_id):
        hit = self.cache.get(condition_id)
        if hit is None:
            self.misses += 1
        return hit


def round_trips(trades, resolver):
    """Fold a wallet's trades into settled (market, outcome) round trips.

    Returns one record per position with the category, dollars staked, and
    realized PnL. Positions in markets that have not resolved are skipped --
    an open position is not evidence.
    """
    from .feed import resolve_outcome_index

    pos = defaultdict(lambda: {"buyUsd": 0.0, "buyShares": 0.0,
                               "sellUsd": 0.0, "sellShares": 0.0,
                               "cat": None, "last": 0})
    for t in trades:
        cid = t.get("conditionId")
        if not cid:
            continue
        # Repair the outcomeIndex sentinel here too. Left as-is, a 999 is
        # carried into the key, fails `oi < len(prices)` at settlement, and
        # drops that trade from the wallet's category record — silently
        # changing the win rate and ROI that decide whether it may vote.
        oi = resolve_outcome_index(t, ((resolver.get(cid) or {}).get("outcomes")))
        if oi is None:
            continue
        p = pos[(cid, oi)]
        usd = t.get("usdcSize") or 0.0
        sz = t.get("size") or 0.0
        if t.get("side") == "BUY":
            p["buyUsd"] += usd
            p["buyShares"] += sz
        else:
            p["sellUsd"] += usd
            p["sellShares"] += sz
        p["last"] = max(p["last"], t.get("timestamp") or 0)
        if p["cat"] is None:
            p["cat"] = classify(t)

    out = []
    for (cid, oi), p in pos.items():
        if p["buyUsd"] <= 0:
            continue                       # sell-only leg of something older
        m = resolver.get(cid)
        if not m or not m.get("closed"):
            continue
        prices = m.get("outcomePrices") or []
        if oi >= len(prices):
            continue
        final = prices[oi]
        # Only settle at a final price. A market closed but still in UMA
        # dispute shows its last trade price, and booking that as a result
        # would score a coin flip as a win.
        if not (m.get("resolved") or final >= 0.99 or final <= 0.01):
            continue
        residual = max(0.0, p["buyShares"] - p["sellShares"])
        pnl = p["sellUsd"] + residual * final - p["buyUsd"]
        out.append({"category": p["cat"] or "Other", "staked": p["buyUsd"],
                    "pnl": pnl, "won": pnl > 0, "at": p["last"]})
    return out


def category_records(trips):
    by_cat = defaultdict(lambda: {"settledTrades": 0, "wins": 0,
                                  "staked": 0.0, "pnl": 0.0})
    for t in trips:
        c = by_cat[t["category"]]
        c["settledTrades"] += 1
        c["wins"] += 1 if t["won"] else 0
        c["staked"] += t["staked"]
        c["pnl"] += t["pnl"]
    for c in by_cat.values():
        c["roi"] = c["pnl"] / c["staked"] if c["staked"] > 0 else 0.0
        c["staked"] = round(c["staked"], 2)
        c["pnl"] = round(c["pnl"], 2)
        c["roi"] = round(c["roi"], 5)
    return dict(by_cat)


# ------------------------------------------------------------------- build

DEFAULT_FILTERS = {
    "max_both_sides": 0.35,
    "max_vol_pnl_ratio": 250.0,      # cohort p95 of volume/|PnL|
    "wash_trades_per_day": 100.0,
    "min_win_day_rate": 0.50,
    "min_pnl": 25_000.0,
}


def prefetch_markets(condition_ids, resolver, batch=20, verbose=True):
    """Warm the resolver's cache in bulk.

    Gamma accepts repeated `condition_ids` parameters and returns them all in
    one response (verified: 8 requested, 8 returned). Sixty wallets touch
    thousands of distinct markets over 90 days, and resolving those one at a
    time is the difference between a two-minute profile build and an hour.

    Two passes are required, and this is easy to get wrong: a plain
    `condition_ids` query silently omits CLOSED markets. Verified against a
    known-settled market -- 0 rows without `closed=true`, 1 row with it.
    Since settled markets are the only ones that carry a result, a
    single-pass prefetch caches thousands of useless open markets and none of
    the evidence, then falls back to fetching every one individually anyway.
    """
    todo = [c for c in dict.fromkeys(condition_ids)
            if c and c not in resolver.cache]
    if verbose and todo:
        print(f"  resolving {len(todo)} markets in batches of {batch} "
              f"(two passes: open, then closed) ...", flush=True)
    now = time.time()

    def absorb(rows):
        got = set()
        for m in rows or []:
            try:
                prices = [float(p) for p in json.loads(m.get("outcomePrices") or "[]")]
            except (ValueError, TypeError):
                prices = []
            try:
                tokens = json.loads(m.get("clobTokenIds") or "[]")
            except (ValueError, TypeError):
                tokens = []
            cid = m.get("conditionId")
            resolver.cache[cid] = {
                "question": m.get("question"), "slug": m.get("slug"),
                "eventSlug": None,
                "outcomes": json.loads(m.get("outcomes") or "[]") if m.get("outcomes") else [],
                "outcomePrices": prices, "clobTokenIds": tokens,
                "endDate": m.get("endDate"), "closed": bool(m.get("closed")),
                "resolved": m.get("umaResolutionStatus") == "resolved",
                "_at": now,
            }
            got.add(cid)
        return got

    def fetch(chunk, extra):
        params = ([("condition_ids", c) for c in chunk]
                  + [("limit", str(len(chunk)))] + list(extra.items()))
        try:
            r = pmlib._session.get(f"{pmlib.GAMMA_API}/markets", params=params,
                                   timeout=30)
            return r.json() if r.status_code == 200 else []
        except (requests.RequestException, ValueError):
            return []

    done = 0
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        got = absorb(fetch(chunk, {}))
        missing = [c for c in chunk if c not in got]
        if missing:
            absorb(fetch(missing, {"closed": "true"}))
        done += len(chunk)
        if verbose and (i // batch) % 40 == 0 and i:
            print(f"    {done}/{len(todo)}", flush=True)
    resolver.save()


def fetch_trades(wallets, since, verbose=True):
    """Pull each wallet's trades since `since` straight from the data API."""
    import signals as sigmod
    if verbose:
        print(f"  fetching 90d trades for {len(wallets)} wallets ...", flush=True)
    return sigmod.recent_trades_live(list(wallets), since)


def build(analyzed, use_raw=True, filters=None, verbose=True, trades_by_wallet=None):
    filters = {**DEFAULT_FILTERS, **(filters or {})}
    resolver = (CachedResolver(pmlib.MarketResolver())
                if (use_raw or trades_by_wallet) else None)
    profiles, all_trips = {}, defaultdict(list)

    for w in analyzed["wallets"]:
        addr = w["wallet"]
        sharpe, n_days = daily_sharpe(w)
        vol = w.get("volume90") or 0.0
        share = {c: (v / vol if vol else 0.0)
                 for c, v in (w.get("categoryVol") or {}).items()}
        excl = exclusion_reason(w, filters)
        code, reason = excl if excl else (None, None)
        prof = {
            "name": w.get("name"), "archetype": w.get("archetype"),
            "pnl90": w.get("pnl90"), "volume90": vol,
            "sharpe": round(sharpe, 4) if sharpe is not None else None,
            "pnlDays": n_days,
            "medianTradeUsd": w.get("medianTradeUsd") or 100.0,
            "winDayRate": w.get("winDayRate"),
            "categoryShare": {c: round(s, 4) for c, s in share.items()},
            "excluded": code is not None,
            "exclusionCode": code,
            "exclusionReason": reason,
            "categories": {},
        }
        profiles[addr] = prof

        if code is not None or not (use_raw or trades_by_wallet):
            continue
        if trades_by_wallet is not None:
            trades = trades_by_wallet.get(addr)
            if trades is None:
                continue
        else:
            path = os.path.join(RAW_DIR, f"wallet_{addr}.json")
            try:
                with open(path) as f:
                    trades = json.load(f).get("trades") or []
            except (OSError, ValueError):
                continue
        trips = round_trips(trades, resolver)
        all_trips[addr] = trips
        prof["categories"] = category_records(trips)
        prof["settledTrades"] = len(trips)
        if verbose and trips:
            print(f"  {prof['name'][:22]:<24} {len(trips):>5} settled trips "
                  f"across {len(prof['categories'])} categories", flush=True)

    # Cohort base rates per category: the prior every wallet is shrunk toward.
    # Measured on the same settled trips, so "lift over base" is apples to
    # apples -- a category where everyone buys favorites has a high base rate
    # that earns nobody any credit.
    cohort = defaultdict(lambda: {"n": 0, "wins": 0, "staked": 0.0, "pnl": 0.0})
    for trips in all_trips.values():
        for t in trips:
            c = cohort[t["category"]]
            c["n"] += 1
            c["wins"] += 1 if t["won"] else 0
            c["staked"] += t["staked"]
            c["pnl"] += t["pnl"]
    base = {c: {"cohortWinRate": (v["wins"] / v["n"]) if v["n"] else 0.5,
                "cohortRoi": (v["pnl"] / v["staked"]) if v["staked"] > 0 else 0.0,
                "cohortTrades": v["n"]}
            for c, v in cohort.items()}
    for prof in profiles.values():
        for c, rec in prof["categories"].items():
            b = base.get(c, {})
            rec["cohortWinRate"] = round(b.get("cohortWinRate", 0.5), 4)
            rec["cohortRoi"] = round(b.get("cohortRoi", 0.0), 5)

    if resolver is not None and resolver.misses:
        print(f"  note: {resolver.misses} market lookups missed the prefetch "
              f"cache and were skipped as unresolvable", flush=True)
    return {
        "generatedAt": analyzed.get("generatedAt"),
        "windowDays": analyzed.get("windowDays"),
        # Degraded means "no category evidence was gathered at all" — a
        # --fetch build has evidence even though it never touched data/raw.
        "degraded": not (use_raw or trades_by_wallet),
        "filters": filters,
        "cohortBaseRates": {c: {k: round(v, 5) if isinstance(v, float) else v
                                for k, v in b.items()} for c, b in base.items()},
        "profiles": profiles,
    }


def load(path=OUT_PATH):
    with open(path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--degraded", action="store_true",
                    help="skip raw trades: metadata only, no category evidence")
    ap.add_argument("--fetch", action="store_true",
                    help="pull the eligible wallets' 90d trades from the API "
                         "instead of reading data/raw")
    ap.add_argument("--max-wallets", type=int, default=60,
                    help="with --fetch, how many top eligible wallets to pull")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    analyzed = pmlib.load_analyzed()
    have_raw = bool(glob.glob(os.path.join(RAW_DIR, "wallet_*.json")))
    use_raw = have_raw and not (args.degraded or args.fetch)
    trades = None

    if args.fetch:
        # Rank by PnL among wallets that pass the exclusion filters, then pull
        # only those: the full cohort is ~300 MB and the watchlist is 60.
        elig = [w for w in analyzed["wallets"]
                if exclusion_reason(w, DEFAULT_FILTERS) is None]
        elig.sort(key=lambda w: -(w.get("pnl90") or 0))
        picked = [w["wallet"] for w in elig[:args.max_wallets]]
        print(f"{len(elig)} eligible wallets; fetching the top {len(picked)}")
        since = analyzed["cutoff"]
        trades = fetch_trades(picked, since)
        n = sum(len(v) for v in trades.values())
        print(f"  {n:,} trades fetched")
        cids = [t.get("conditionId") for v in trades.values() for t in v]
        prefetch_markets(cids, pmlib.MarketResolver())
    elif not use_raw and not args.degraded:
        print("data/raw is empty — run scripts/fetch_data.py, pass --fetch to "
              "pull the watchlist live, or --degraded for metadata only.",
              file=sys.stderr)
        return 2

    out = build(analyzed, use_raw=use_raw, trades_by_wallet=trades)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)

    profs = out["profiles"]
    live = [p for p in profs.values() if not p["excluded"]]
    with_cats = [p for p in live if p["categories"]]
    print(f"\n{len(profs)} wallets -> {len(live)} eligible, "
          f"{len(with_cats)} with a settled category record")
    if out["degraded"]:
        print("DEGRADED: no category evidence. The engine will refuse to size "
              "live orders from these profiles.")
    reasons = defaultdict(int)
    for p in profs.values():
        if p["excluded"]:
            reasons[p["exclusionCode"]] += 1
    for r, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  excluded {n:>3}: {r}")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
