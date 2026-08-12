#!/usr/bin/env python3
"""Analyze fetched Polymarket wallet data into dashboard-ready JSON.

Reads data/raw/, writes data/analyzed.json with per-wallet 90-day metrics,
archetype classification, and cohort-level aggregates.
"""
import glob
import json
import math
import os
import re
from collections import Counter, defaultdict

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "analyzed.json")

# Ordered keyword rules: first match wins. Matched against "slug eventSlug title".
CATEGORY_RULES = [
    ("Crypto", r"\b(btc|eth|sol|xrp|doge|ada|bnb|link|ltc|shib|pepe|bitcoin|ethereum|solana|crypto|updown|memecoin|stablecoin|microstrategy|mstr)\b"),
    ("Sports", r"\b(nba|nfl|mlb|nhl|wnba|epl|laliga|la-liga|ucl|uel|serie-?a|bundesliga|ligue-?1|mls|atp|wta|itf|tennis|ufc|mma|boxing|f1|formula|nascar|pga|golf|cricket|ipl|rugby|ncaa[bf]?|cfb|college-football|college-basketball|fifa|fifwc|world-cup|worldcup|olympics|darts|snooker|table-tennis|volleyball|handball|hockey|khl|shl|liiga|premier-league|champions-league|europa|copa|libertadores|eredivisie|primeira|super-lig|spread|moneyline|both-teams|draw-no-bet|grand-slam|us-open|wimbledon|roland-garros|australian-open|sabalenka|djokovic|alcaraz|sinner)\b"),
    ("Esports", r"\b(cs2|csgo|counter-strike|lol|league-of-legends|dota2?|valorant|overwatch|starcraft|esports|blast|iem|pgl|lck|lcs|lpl)\b"),
    ("Mentions", r"\b(say|says|mention|mentions|tweet|tweets|post on|times)\b"),
    ("Politics", r"\b(trump|biden|harris|vance|election|president|presidential|senate|house|congress|governor|mayor|midterm|primary|impeach|cabinet|nominee|scotus|supreme-court|ukraine|russia|putin|zelensky|gaza|israel|iran|hamas|ceasefire|nato|xi-jinping|taiwan|north-korea|venezuela|maduro|tariff|shutdown|government|parliament|chancellor|prime-minister|pm-|epstein|fbi|doj|deport|immigration|ice-)\b"),
    ("Economics", r"\b(fed|fomc|rate-cut|rate-hike|interest-rate|cpi|inflation|recession|gdp|jobs-report|nfp|nonfarm|unemployment|payrolls|powell|treasury|tariffs|wti|opec|oil-price|ipo|market-cap|s-and-p|sp500|nasdaq|dow)\b"),
    ("Tech & AI", r"\b(openai|gpt|chatgpt|anthropic|claude|gemini|grok|xai|deepseek|llama|ai-model|apple|iphone|tesla|spacex|starship|nvidia|google|microsoft|amazon|meta-|tiktok|twitter|robotaxi|self-driving|agi)\b"),
    ("Weather", r"\b(temp|temperature|hurricane|tropical-storm|rainfall|snow|heat|weather|tornado|earthquake)\b"),
    ("Culture", r"\b(oscars?|grammy|emmy|golden-globe|box-office|movie|album|billboard|spotify|taylor-swift|kanye|drake|mrbeast|gta|game-of-the-year|rotten-tomatoes|netflix|time-person|nobel|eurovision|miss-universe|pope|royal|celebrity|bachelor|survivor|love-island|minecraft|kai-cenat|ishowspeed)\b"),
]
CATEGORY_RE = [(name, re.compile(rx)) for name, rx in CATEGORY_RULES]

# Fallback: fixture-style slugs (league-team-team-YYYY-MM-DD) are sports
# matches even when the league prefix isn't in the keyword list.
MATCH_SLUG_RE = re.compile(r"(^|\s)[a-z0-9]{2,12}(-[a-z0-9]{2,6}){2,3}-\d{4}-\d{2}-\d{2}")


def classify(trade):
    text = " ".join(str(trade.get(k) or "") for k in ("slug", "eventSlug", "title")).lower()
    for name, rx in CATEGORY_RE:
        if rx.search(text):
            return name
    if MATCH_SLUG_RE.search(text):
        return "Sports"
    return "Other"


def pctl(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, int(q * len(sorted_vals)))
    return sorted_vals[idx]


def max_drawdown(series):
    peak, mdd = -math.inf, 0.0
    for v in series:
        peak = max(peak, v)
        mdd = min(mdd, v - peak)
    return mdd


def analyze_wallet(raw, candidate):
    trades = raw["trades"]
    cutoff = raw["cutoff"]

    vol = sum(t["usdcSize"] or 0 for t in trades)
    buys = [t for t in trades if t["side"] == "BUY"]
    sells = [t for t in trades if t["side"] == "SELL"]
    sizes = sorted((t["usdcSize"] or 0) for t in trades)
    events = Counter(t["eventSlug"] for t in trades if t.get("eventSlug"))
    markets = {t["conditionId"] for t in trades if t.get("conditionId")}

    cat_vol = defaultdict(float)
    cat_n = Counter()
    for t in trades:
        c = classify(t)
        cat_vol[c] += t["usdcSize"] or 0
        cat_n[c] += 1

    days = {(t["timestamp"] - cutoff) // 86400 for t in trades}
    hours = Counter((t["timestamp"] // 3600) % 24 for t in trades)

    buy_usdc = sum(t["usdcSize"] or 0 for t in buys)
    vw_buy_price = (sum((t["usdcSize"] or 0) * (t["price"] or 0) for t in buys) / buy_usdc) if buy_usdc else None
    longshot_vol = sum((t["usdcSize"] or 0) for t in buys if (t["price"] or 0) < 0.10)
    fav_vol = sum((t["usdcSize"] or 0) for t in buys if (t["price"] or 0) > 0.90)

    ev_vol = defaultdict(float)
    ev_title = {}
    for t in trades:
        ev = t.get("eventSlug") or t.get("slug") or "?"
        ev_vol[ev] += t["usdcSize"] or 0
        ev_title.setdefault(ev, t.get("title") or ev)
    top_events = sorted(ev_vol.items(), key=lambda kv: -kv[1])[:5]
    top5_share = (sum(v for _, v in top_events) / vol) if vol else 0

    series = raw.get("pnlSeries") or []
    pnl90 = daily = None
    mdd = win_days = None
    if len(series) >= 2:
        vals = [p["p"] for p in series]
        pnl90 = vals[-1] - vals[0]
        daily = [{"t": p["t"], "p": round(p["p"] - vals[0], 2)} for p in series]
        deltas = [b - a for a, b in zip(vals, vals[1:])]
        mdd = max_drawdown([v - vals[0] for v in vals])
        nz = [d for d in deltas if abs(d) > 1]
        win_days = (sum(1 for d in nz if d > 0) / len(nz)) if nz else None

    pos = raw.get("positions") or []
    open_pos = [p for p in pos if (p.get("currentValue") or 0) > 1]
    open_value = sum(p.get("currentValue") or 0 for p in open_pos)
    top_positions = [{
        "title": p.get("title"), "outcome": p.get("outcome"),
        "value": round(p.get("currentValue") or 0, 2),
        "avgPrice": p.get("avgPrice"), "curPrice": p.get("curPrice"),
        "cashPnl": round(p.get("cashPnl") or 0, 2),
    } for p in open_pos[:5]]

    boards = {s["board"]: s["rank"] for s in candidate["sources"]}
    month_pnl = next((s["pnl"] for s in candidate["sources"] if s["board"] == "OVERALL_MONTH_PNL"), None)
    month_vol = next((s["vol"] for s in candidate["sources"] if s["board"] == "OVERALL_MONTH_VOL"), None)

    n = len(trades)
    active_days = len(days)
    cat_share = {c: (v / vol if vol else 0) for c, v in cat_vol.items()}
    top_cat, top_cat_share = (max(cat_share.items(), key=lambda kv: kv[1]) if cat_share else ("Other", 0))

    # Archetype: ordered rules, first match wins.
    buy_share = len(buys) / n if n else 0
    med = pctl(sizes, 0.5)
    avg = vol / n if n else 0
    tpd = n / active_days if active_days else 0
    if raw.get("truncated") or (n >= 8000 and med < 300):
        archetype = "Market maker / HFT"
    elif top_cat == "Crypto" and top_cat_share >= 0.6 and tpd >= 30:
        archetype = "Crypto scalper"
    elif avg >= 4000 and vol >= 2_000_000:
        archetype = "Whale"
    elif top_cat == "Sports" and top_cat_share >= 0.65:
        archetype = "Sports specialist"
    elif top_cat in ("Politics", "Economics", "Mentions") and cat_share.get("Politics", 0) + cat_share.get("Economics", 0) + cat_share.get("Mentions", 0) >= 0.55:
        archetype = "Politics & news trader"
    elif n <= 400 and (pnl90 or 0) >= 50_000:
        archetype = "Low-frequency sniper"
    elif vw_buy_price is not None and vw_buy_price >= 0.75:
        archetype = "Favorite grinder"
    elif vw_buy_price is not None and vw_buy_price <= 0.30:
        archetype = "Longshot hunter"
    else:
        archetype = "Generalist"

    return {
        "wallet": raw["proxyWallet"],
        "name": candidate.get("userName") or raw["proxyWallet"][:10],
        "boards": boards,
        "archetype": archetype,
        "truncated": raw.get("truncated", False),
        "monthPnl": month_pnl, "monthVol": month_vol,
        "pnl90": round(pnl90, 2) if pnl90 is not None else None,
        "maxDrawdown90": round(mdd, 2) if mdd is not None else None,
        "winDayRate": round(win_days, 4) if win_days is not None else None,
        "volume90": round(vol, 2),
        "trades90": n,
        "activeDays": active_days,
        "tradesPerActiveDay": round(tpd, 1),
        "distinctMarkets": len(markets),
        "distinctEvents": len(events),
        "avgTradeUsd": round(avg, 2),
        "medianTradeUsd": round(med, 2),
        "p95TradeUsd": round(pctl(sizes, 0.95), 2),
        "maxTradeUsd": round(sizes[-1], 2) if sizes else 0,
        "buyShare": round(buy_share, 4),
        "vwBuyPrice": round(vw_buy_price, 4) if vw_buy_price is not None else None,
        "longshotShare": round(longshot_vol / buy_usdc, 4) if buy_usdc else None,
        "favoriteShare": round(fav_vol / buy_usdc, 4) if buy_usdc else None,
        "top5EventShare": round(top5_share, 4),
        "categoryVol": {c: round(v, 2) for c, v in sorted(cat_vol.items(), key=lambda kv: -kv[1])},
        "hourHistogram": [hours.get(h, 0) for h in range(24)],
        "portfolioValue": raw.get("portfolioValue"),
        "openPositionsValue": round(open_value, 2),
        "openPositionsCount": len(open_pos),
        "topEvents": [{"event": e, "title": ev_title[e], "vol": round(v, 2)} for e, v in top_events],
        "topPositions": top_positions,
        "pnlDaily": daily,
    }


def main():
    with open(os.path.join(RAW_DIR, "candidates.json")) as f:
        candidates = json.load(f)
    with open(os.path.join(RAW_DIR, "leaderboards.json")) as f:
        lb = json.load(f)

    cohort = []
    for path in glob.glob(os.path.join(RAW_DIR, "wallet_*.json")):
        with open(path) as f:
            raw = json.load(f)
        addr = raw["proxyWallet"]
        if addr not in candidates:
            continue
        cohort.append(analyze_wallet(raw, candidates[addr]))

    cohort.sort(key=lambda w: -(w["pnl90"] if w["pnl90"] is not None else -1e18))

    total_vol = sum(w["volume90"] for w in cohort)
    total_trades = sum(w["trades90"] for w in cohort)
    cat_totals = defaultdict(float)
    hour_totals = [0] * 24
    arch_counts = Counter()
    arch_pnl = defaultdict(float)
    for w in cohort:
        for c, v in w["categoryVol"].items():
            cat_totals[c] += v
        for h in range(24):
            hour_totals[h] += w["hourHistogram"][h]
        arch_counts[w["archetype"]] += 1
        if w["pnl90"] is not None:
            arch_pnl[w["archetype"]] += w["pnl90"]

    out = {
        "generatedAt": lb["fetchedAt"],
        "cutoff": lb["cutoff"],
        "windowDays": 90,
        "walletCount": len(cohort),
        "aggregates": {
            "totalVolume90": round(total_vol, 2),
            "totalTrades90": total_trades,
            "totalPnl90": round(sum(w["pnl90"] or 0 for w in cohort), 2),
            "categoryVolume": {c: round(v, 2) for c, v in sorted(cat_totals.items(), key=lambda kv: -kv[1])},
            "hourHistogram": hour_totals,
            "archetypes": {a: {"count": arch_counts[a], "pnl90": round(arch_pnl[a], 2)} for a in arch_counts},
        },
        "wallets": cohort,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f)
    print(f"Analyzed {len(cohort)} wallets -> {OUT_PATH}")
    print(f"Cohort 90d volume: ${total_vol:,.0f}, trades: {total_trades:,}")


if __name__ == "__main__":
    main()
