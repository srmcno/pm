#!/usr/bin/env python3
"""Shared helpers for the Polymarket wallet-intelligence toolkit.

HTTP with retries, market metadata resolution (gamma), CLOB price history,
and watchlist construction from the analyzed cohort. All caches live under
data/cache/ and are safe to delete.
"""
import json
import os
import time

import requests

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
CACHE_DIR = os.path.join(BASE, "data", "cache")

_session = requests.Session()
_session.headers.update({"User-Agent": "pm-wallet-research/1.0"})


def get_json(url, params=None, retries=4, timeout=30):
    delay = 1.0
    for _ in range(retries):
        try:
            r = _session.get(url, params=params, timeout=timeout)
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


def load_analyzed():
    with open(os.path.join(BASE, "data", "analyzed.json")) as f:
        return json.load(f)


# ---------------------------------------------------------------- markets

class MarketResolver:
    """conditionId -> market metadata, with a persistent JSON cache.

    Resolved (closed) markets never change, so they cache forever; open
    markets re-fetch when older than `open_ttl` seconds.
    """

    def __init__(self, open_ttl=900):
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.path = os.path.join(CACHE_DIR, "markets.json")
        self.open_ttl = open_ttl
        try:
            with open(self.path) as f:
                self.cache = json.load(f)
        except (OSError, ValueError):
            self.cache = {}

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.cache, f)

    def get(self, condition_id):
        now = time.time()
        hit = self.cache.get(condition_id)
        if hit:
            prices = hit.get("outcomePrices") or []
            settled = hit.get("resolved") or (
                prices and not any(0.01 < p < 0.99 for p in prices))
            if hit.get("closed") and settled:
                return hit  # final — never changes again
            # Open markets refresh on open_ttl; closed-but-unresolved ones
            # refresh hourly so the resolution eventually lands.
            ttl = 3600 if hit.get("closed") else self.open_ttl
            if now - hit.get("_at", 0) < ttl:
                return hit
        m = None
        for extra in ({}, {"closed": "true"}):
            rows = get_json(f"{GAMMA_API}/markets",
                            {"condition_ids": condition_id, **extra})
            if rows:
                m = rows[0]
                break
        if m is None:
            return hit  # keep stale data over nothing
        try:
            prices = [float(p) for p in json.loads(m.get("outcomePrices") or "[]")]
        except (ValueError, TypeError):
            prices = []
        try:
            tokens = json.loads(m.get("clobTokenIds") or "[]")
        except (ValueError, TypeError):
            tokens = []
        entry = {
            "question": m.get("question"),
            "slug": m.get("slug"),
            "eventSlug": (m.get("events") or [{}])[0].get("slug") if m.get("events") else None,
            "outcomes": json.loads(m.get("outcomes") or "[]") if m.get("outcomes") else [],
            "outcomePrices": prices,
            "clobTokenIds": tokens,
            "endDate": m.get("endDate"),
            "closed": bool(m.get("closed")),
            "resolved": m.get("umaResolutionStatus") == "resolved",
            "_at": now,
        }
        self.cache[condition_id] = entry
        return entry


def price_history(token_id, start_ts, end_ts, fidelity=60):
    """CLOB price history for a token, cached per (token, day-bucket)."""
    os.makedirs(os.path.join(CACHE_DIR, "prices"), exist_ok=True)
    key = f"{token_id}_{start_ts//86400}_{end_ts//86400}_{fidelity}"
    path = os.path.join(CACHE_DIR, "prices", key + ".json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    data = get_json(f"{CLOB_API}/prices-history", {
        "market": token_id, "startTs": start_ts, "endTs": end_ts,
        "fidelity": fidelity})
    hist = (data or {}).get("history") or []
    with open(path, "w") as f:
        json.dump(hist, f)
    return hist


def price_at(token_id, ts, window=6 * 3600):
    """First traded price at-or-after ts (within `window` seconds)."""
    hist = price_history(token_id, ts - 600, ts + window)
    for p in hist:
        if p["t"] >= ts:
            return p["p"], p["t"]
    return (hist[-1]["p"], hist[-1]["t"]) if hist else (None, None)


def midpoint(token_id):
    d = get_json(f"{CLOB_API}/midpoint", {"token_id": token_id})
    try:
        return float(d["mid"])
    except (TypeError, KeyError, ValueError):
        return None


def book_price(token_id, side):
    """Best price on one side of the book: side='bid' or 'ask'.

    The CLOB /price endpoint labels sides by the resting orders it reads:
    side=BUY returns the best bid, side=SELL the best ask (verified against
    /book). A buyer therefore pays the 'ask'; a seller receives the 'bid'.
    """
    api_side = {"bid": "BUY", "ask": "SELL"}[side]
    d = get_json(f"{CLOB_API}/price", {"token_id": token_id, "side": api_side})
    try:
        return float(d["price"])
    except (TypeError, KeyError, ValueError):
        return None


# ---------------------------------------------------------------- watchlist

# Archetypes whose order flow is inventory management, not opinion.
NOISE_ARCHETYPES = {"Market maker / HFT", "Crypto scalper"}


def build_watchlist(analyzed, min_pnl=100_000, max_wallets=60,
                    require_win_rate=0.5, pnl_key="pnl90", categories=None):
    """Qualified wallets whose buys plausibly carry information.

    Quality score in (0, 1]: rank-normalized PnL blended with win-day rate.
    With `categories`, only wallets that do most of their volume there
    qualify — a specialist desk follows proven specialists, not tourists.
    """
    def specialist(w):
        if not categories:
            return True
        vol = w.get("volume90") or 0
        if not vol:
            return False
        share = sum((w.get("categoryVol") or {}).get(c, 0) for c in categories)
        return share / vol >= 0.5

    ranked = [w for w in analyzed["wallets"]
              if (w.get(pnl_key) or 0) >= min_pnl
              and w["archetype"] not in NOISE_ARCHETYPES
              and not w.get("truncated")
              and (w.get("winDayRate") or 0) >= require_win_rate
              and specialist(w)]
    ranked.sort(key=lambda w: -(w.get(pnl_key) or 0))
    ranked = ranked[:max_wallets]
    n = len(ranked)
    out = {}
    for i, w in enumerate(ranked):
        rank_score = 1.0 - i / max(1, n)          # 1.0 best, ->0 worst
        win = min(1.0, (w.get("winDayRate") or 0.5) / 0.8)
        out[w["wallet"]] = {
            "name": w["name"],
            "archetype": w["archetype"],
            "pnl": w.get(pnl_key),
            "quality": round(0.6 * rank_score + 0.4 * win, 4),
            "medianTrade": w.get("medianTradeUsd") or 100.0,
        }
    return out
