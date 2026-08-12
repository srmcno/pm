#!/usr/bin/env python3
"""Fetch top Polymarket wallets and their last-90-day trading data.

Data sources (all public, no auth):
  - https://data-api.polymarket.com/v1/leaderboard  (trader rankings)
  - https://data-api.polymarket.com/activity        (per-wallet trade history)
  - https://data-api.polymarket.com/positions       (per-wallet open/closed positions)
  - https://data-api.polymarket.com/value           (per-wallet portfolio value)
  - https://user-pnl-api.polymarket.com/user-pnl    (per-wallet daily PnL series)

Output: data/raw/ JSON files, one per wallet, plus leaderboards.json.
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

DATA_API = "https://data-api.polymarket.com"
PNL_API = "https://user-pnl-api.polymarket.com"

WINDOW_DAYS = 90
NOW = int(time.time())
CUTOFF = NOW - WINDOW_DAYS * 86400

# Per-wallet trade pagination cap. 500 trades/page.  The API caps offset
# pagination at 5,000, so we cursor on the `end` timestamp instead.  Wallets
# that exceed the page cap get truncated=True.
MAX_ACTIVITY_PAGES = 400

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")

CATEGORIES = ["OVERALL", "POLITICS", "SPORTS", "ESPORTS", "CRYPTO", "CULTURE",
              "MENTIONS", "WEATHER", "ECONOMICS", "TECH", "FINANCE"]

session_local = {}


def get_session():
    tid = os.getpid(), id(sys)
    s = requests.Session()
    s.headers.update({"User-Agent": "pm-wallet-research/1.0"})
    return s


SESSION = get_session()


def get_json(url, params=None, retries=4):
    delay = 1.0
    for attempt in range(retries):
        try:
            r = SESSION.get(url, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(delay)
                delay *= 2
                continue
            return None
        except (requests.RequestException, ValueError):
            time.sleep(delay)
            delay *= 2
    return None


def fetch_leaderboards():
    """Union of top-50 across time periods and rank types, plus per-category."""
    boards = {}
    combos = []
    for tp in ("WEEK", "MONTH", "ALL"):
        for ob in ("PNL", "VOL"):
            combos.append(("OVERALL", tp, ob))
    for cat in CATEGORIES[1:]:
        combos.append((cat, "MONTH", "PNL"))

    for cat, tp, ob in combos:
        rows = get_json(f"{DATA_API}/v1/leaderboard", {
            "category": cat, "timePeriod": tp, "orderBy": ob, "limit": 50})
        key = f"{cat}_{tp}_{ob}"
        boards[key] = rows or []
        print(f"  leaderboard {key}: {len(boards[key])} rows")
        time.sleep(0.2)
    return boards


def candidate_wallets(boards):
    """Candidates for deep 90d analysis: overall boards + category leaders."""
    wallets = {}
    for key, rows in boards.items():
        cat, tp, ob = key.split("_")
        # Category boards contribute their top 10 only; overall boards top 50.
        keep = 50 if cat == "OVERALL" else 10
        for row in rows[:keep]:
            w = row["proxyWallet"].lower()
            entry = wallets.setdefault(w, {"proxyWallet": w,
                                           "userName": row.get("userName", ""),
                                           "sources": []})
            entry["sources"].append({"board": key, "rank": int(row["rank"]),
                                     "pnl": row.get("pnl"), "vol": row.get("vol")})
    return wallets


def fetch_wallet(addr):
    """Fetch 90d trades, positions, value, and PnL series for one wallet."""
    trades = []
    truncated = False
    seen = set()
    cursor = None  # walk backwards via `end` (offset pagination caps at 5000)
    for _page in range(MAX_ACTIVITY_PAGES):
        params = {"user": addr, "type": "TRADE", "limit": 500,
                  "sortBy": "TIMESTAMP", "sortDirection": "DESC"}
        if cursor is not None:
            params["end"] = cursor
        rows = get_json(f"{DATA_API}/activity", params)
        if not rows:
            break
        stop = False
        for t in rows:
            ts = t.get("timestamp", 0)
            if ts < CUTOFF:
                stop = True
                break
            key = (t.get("transactionHash"), t.get("asset"), t.get("size"),
                   t.get("side"), ts)
            if key in seen:
                continue
            seen.add(key)
            trades.append({k: t.get(k) for k in (
                "timestamp", "conditionId", "size", "usdcSize", "price",
                "side", "outcome", "outcomeIndex", "title", "slug",
                "eventSlug")})
        if stop or len(rows) < 500:
            break
        oldest = rows[-1]["timestamp"]
        # `end` is inclusive; step inside the same second only if we'd stall.
        cursor = oldest if cursor is None or oldest < cursor else cursor - 1
    else:
        truncated = True

    positions = get_json(f"{DATA_API}/positions", {
        "user": addr, "limit": 500, "sortBy": "CURRENT",
        "sortDirection": "DESC"}) or []
    positions = [{k: p.get(k) for k in (
        "conditionId", "size", "avgPrice", "initialValue", "currentValue",
        "cashPnl", "realizedPnl", "curPrice", "redeemable", "title", "slug",
        "eventSlug", "outcome")} for p in positions]

    value_rows = get_json(f"{DATA_API}/value", {"user": addr}) or []
    value = value_rows[0].get("value") if value_rows else None

    pnl_series = get_json(f"{PNL_API}/user-pnl", {
        "user_address": addr, "interval": "all", "fidelity": "1d"}) or []
    pnl_series = [p for p in pnl_series if p.get("t", 0) >= CUTOFF - 86400]

    return {"proxyWallet": addr, "fetchedAt": NOW, "cutoff": CUTOFF,
            "truncated": truncated, "trades": trades, "positions": positions,
            "portfolioValue": value, "pnlSeries": pnl_series}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Fetching leaderboards...")
    boards = fetch_leaderboards()
    with open(os.path.join(OUT_DIR, "leaderboards.json"), "w") as f:
        json.dump({"fetchedAt": NOW, "cutoff": CUTOFF, "boards": boards}, f)

    wallets = candidate_wallets(boards)
    print(f"Candidate wallets: {len(wallets)}")
    with open(os.path.join(OUT_DIR, "candidates.json"), "w") as f:
        json.dump(wallets, f, indent=1)

    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(fetch_wallet, w): w for w in wallets}
        for fut in as_completed(futs):
            addr = futs[fut]
            try:
                data = fut.result()
            except Exception as e:  # noqa: BLE001 - log and continue the sweep
                print(f"  FAIL {addr}: {e}")
                continue
            with open(os.path.join(OUT_DIR, f"wallet_{addr}.json"), "w") as f:
                json.dump(data, f)
            done += 1
            if done % 10 == 0:
                print(f"  {done}/{len(wallets)} wallets fetched")
    print(f"Done: {done}/{len(wallets)} wallets")


if __name__ == "__main__":
    main()
