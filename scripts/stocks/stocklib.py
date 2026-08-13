#!/usr/bin/env python3
"""Data access and market clock for the equities desk.

Sources, all verified reachable without credentials:
  - MEXC spot for crypto reference prices (real-time book tickers, 1m klines).
  - Yahoo Finance chart API for equity quotes and intraday bars. Requires a
    browser User-Agent; datacenter IPs are rate-limited aggressively, so all
    calls retry with backoff and cache to disk.
Alpaca (keys required) is used by livedesk.py for execution and, when
configured, replaces Yahoo for quotes.
"""
import json
import os
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
DATA_DIR = os.path.join(BASE, "data", "stocks")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
MEXC = "https://api.mexc.com/api/v3"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart"
ET = ZoneInfo("America/New_York")

_session = requests.Session()
_session.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0 Safari/537.36"),
    "Accept": "application/json,text/plain,*/*",
})


def get_json(url, params=None, retries=4, timeout=20):
    delay = 1.5
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


# ---------------------------------------------------------------- crypto

def crypto_mid(symbol="BTCUSDT"):
    """Current mid price from the MEXC book ticker."""
    d = get_json(f"{MEXC}/ticker/bookTicker", {"symbol": symbol})
    try:
        return (float(d["bidPrice"]) + float(d["askPrice"])) / 2.0
    except (TypeError, KeyError, ValueError):
        return None


def crypto_mids(symbols=("BTCUSDT", "ETHUSDT")):
    out = {}
    rows = get_json(f"{MEXC}/ticker/bookTicker") or []
    want = set(symbols)
    for r in rows if isinstance(rows, list) else []:
        if r.get("symbol") in want:
            try:
                out[r["symbol"]] = (float(r["bidPrice"]) + float(r["askPrice"])) / 2
            except (KeyError, ValueError):
                pass
    return out


def crypto_klines(symbol, interval="1m", start_ms=None, end_ms=None, limit=1000):
    """OHLCV rows: [openTime, open, high, low, close, volume, closeTime, ...]."""
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    if start_ms:
        params["startTime"] = int(start_ms)
    if end_ms:
        params["endTime"] = int(end_ms)
    return get_json(f"{MEXC}/klines", params) or []


def crypto_minutes(symbol, start_ts, end_ts):
    """1m closes covering [start_ts, end_ts]: {minute_ts: close}."""
    out = {}
    cur = int(start_ts) * 1000
    end_ms = int(end_ts) * 1000
    while cur < end_ms:
        rows = crypto_klines(symbol, "1m", start_ms=cur, end_ms=end_ms)
        if not rows:
            break
        for r in rows:
            out[int(r[0]) // 1000] = float(r[4])
        last = int(rows[-1][0])
        if last <= cur:
            break
        cur = last + 60_000
        time.sleep(0.15)
    return out


def crypto_daily_closes(symbol, days=90):
    rows = crypto_klines(symbol, "1d", limit=days)
    return {int(r[0]) // 1000: float(r[4]) for r in rows}


# --------------------------------------------------------------- equities

def chart(symbol, interval="1m", range_="1d", cache_ttl=0):
    """Yahoo chart payload for one symbol; optionally disk-cached."""
    path = os.path.join(CACHE_DIR, f"{symbol}_{interval}_{range_}.json")
    if cache_ttl:
        try:
            if time.time() - os.path.getmtime(path) < cache_ttl:
                with open(path) as f:
                    return json.load(f)
        except OSError:
            pass
    d = get_json(f"{YAHOO}/{symbol}",
                 {"interval": interval, "range": range_,
                  "includePrePost": "false"})
    try:
        result = d["chart"]["result"][0]
    except (TypeError, KeyError, IndexError):
        return None
    if cache_ttl:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(path, "w") as f:
            json.dump(result, f)
    return result


def quote(symbol):
    """Latest price, previous close, and session state for one symbol."""
    r = chart(symbol, "1m", "1d")
    if not r:
        return None
    meta = r.get("meta") or {}
    px = meta.get("regularMarketPrice")
    if px is None:
        closes = (((r.get("indicators") or {}).get("quote") or [{}])[0]
                  .get("close") or [])
        px = next((c for c in reversed(closes) if c is not None), None)
    return {
        "symbol": symbol,
        "price": px,
        "prevClose": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "marketTime": meta.get("regularMarketTime"),
        "exchange": meta.get("exchangeName"),
    }


def minute_bars(symbol, range_="5d"):
    """Regular-session 1m bars: sorted [(ts, open, high, low, close, volume)]."""
    r = chart(symbol, "1m", range_, cache_ttl=300)
    if not r:
        return []
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    opens, highs = q.get("open") or [], q.get("high") or []
    lows, closes, vols = q.get("low") or [], q.get("close") or [], q.get("volume") or []
    out = []
    for i, t in enumerate(ts):
        if i >= len(closes) or closes[i] is None or opens[i] is None:
            continue
        out.append((int(t), float(opens[i]), float(highs[i] or closes[i]),
                    float(lows[i] or closes[i]), float(closes[i]),
                    float(vols[i] or 0)))
    out.sort(key=lambda b: b[0])
    return out


def daily_closes(symbol, range_="3mo"):
    r = chart(symbol, "1d", range_, cache_ttl=3600)
    if not r:
        return {}
    ts = r.get("timestamp") or []
    closes = (((r.get("indicators") or {}).get("quote") or [{}])[0]
              .get("close") or [])
    return {int(t): float(c) for t, c in zip(ts, closes) if c is not None}


# ----------------------------------------------------------------- clock

def now_et():
    return datetime.now(tz=ET)


def market_state(dt=None):
    """'open' | 'premarket' | 'afterhours' | 'closed'. Holidays are treated
    as normal days; a holiday session simply produces no data and no trades."""
    dt = dt or now_et()
    if dt.weekday() >= 5:
        return "closed"
    t = dt.time()
    if t >= datetime.strptime("09:30", "%H:%M").time() and \
       t < datetime.strptime("16:00", "%H:%M").time():
        return "open"
    if t < datetime.strptime("09:30", "%H:%M").time() and \
       t >= datetime.strptime("04:00", "%H:%M").time():
        return "premarket"
    if t >= datetime.strptime("16:00", "%H:%M").time() and \
       t <= datetime.strptime("20:00", "%H:%M").time():
        return "afterhours"
    return "closed"


def minutes_to_close(dt=None):
    dt = dt or now_et()
    if market_state(dt) != "open":
        return 0.0
    close = dt.replace(hour=16, minute=0, second=0, microsecond=0)
    return max(0.0, (close - dt).total_seconds() / 60.0)


def session_open_ts(dt=None):
    dt = dt or now_et()
    o = dt.replace(hour=9, minute=30, second=0, microsecond=0)
    return int(o.timestamp())


# ------------------------------------------------------------------ state

def load_state(name, default):
    try:
        with open(os.path.join(DATA_DIR, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_state(name, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = os.path.join(DATA_DIR, name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, os.path.join(DATA_DIR, name))
