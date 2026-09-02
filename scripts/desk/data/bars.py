#!/usr/bin/env python3
"""Historical bars from keyless US-reachable sources, with a disk cache.

One loader for every desk, so a backtest and the live desk are never reading
different histories. Sources, all verified reachable 2026-08-30:

  yahoo     equities/ETFs, daily back ~decades, 1m only ~30d in 7d chunks
  coinbase  crypto candles, 300 per request, paged backwards, US venue
  kraken    crypto OHLC, ~720 bars per interval, US venue
  alpaca    crypto quotes/bars — the crypto endpoints answer WITHOUT auth

Everything is cached to data/cache/bars/ keyed by source+symbol+interval so
a sweep does not re-hammer an exchange, and so a rerun of the same backtest
reads identical bytes. Cache entries carry a fetched-at stamp and expire on
a per-interval schedule.
"""
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
CACHE_DIR = os.path.join(BASE, "data", "cache", "bars")
UA = {"User-Agent": "Mozilla/5.0 (compatible; deskbot/2.0)"}

# How long a cached series stays usable, by bar size.
TTL = {"1m": 900, "5m": 1800, "15m": 3600, "1h": 7200, "1d": 43200}


class Bar:
    """One OHLCV bar. `t` is the bar's OPEN time, epoch seconds, UTC.

    Which instant a timestamp names is the kind of detail that silently
    shifts a backtest by one bar, so it is stated here and enforced by the
    loaders rather than left to each caller's assumption.
    """
    __slots__ = ("t", "o", "h", "l", "c", "v")

    def __init__(self, t, o, h, l, c, v=0.0):
        self.t, self.o, self.h, self.l, self.c, self.v = (
            int(t), float(o), float(h), float(l), float(c), float(v or 0.0))

    def __repr__(self):
        return f"Bar({datetime.fromtimestamp(self.t, timezone.utc):%Y-%m-%d %H:%M} c={self.c})"

    def as_list(self):
        return [self.t, self.o, self.h, self.l, self.c, self.v]

    @classmethod
    def from_list(cls, r):
        return cls(*r)


def _get(url, timeout=45, tries=4, headers=None):
    """GET JSON with backoff. Returns None rather than raising, so one bad
    symbol cannot kill a sweep — callers check for None."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                if i < tries - 1:
                    time.sleep(2 ** i)
                continue
            return None
        except Exception as e:                              # noqa: BLE001
            last = e
            if i < tries - 1:
                time.sleep(1.5 ** i)
    return None


# ------------------------------------------------------------------- cache
def _cache_path(source, symbol, interval):
    safe = symbol.replace("/", "_").replace(":", "_")
    return os.path.join(CACHE_DIR, f"{source}_{safe}_{interval}.json")


def _read_cache(source, symbol, interval, max_age=None, need_days=0):
    """Cached bars, but only if they COVER the requested span.

    The span matters as much as the age. A five-year pull cached under the
    same key as a ten-year request would silently hand back half the
    history, and a cross-sectional backtest intersecting that against full
    series quietly loses most of its sample — a shrunken backtest that still
    reports a confident number. So the covered span is stored and checked.
    """
    path = _cache_path(source, symbol, interval)
    try:
        with open(path) as f:
            blob = json.load(f)
    except (OSError, ValueError):
        return None
    age = time.time() - blob.get("fetchedAt", 0)
    if age > (max_age if max_age is not None else TTL.get(interval, 3600)):
        return None
    if need_days and blob.get("lookbackDays", 0) < need_days * 0.95:
        return None
    return [Bar.from_list(r) for r in blob.get("bars", [])]


def _write_cache(source, symbol, interval, bars, lookback_days=0):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(source, symbol, interval)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"fetchedAt": int(time.time()), "source": source,
                   "symbol": symbol, "interval": interval,
                   "lookbackDays": lookback_days,
                   "bars": [b.as_list() for b in bars]}, f, separators=(",", ":"))
    os.replace(tmp, path)


# ------------------------------------------------------------------- yahoo
_Y_INTERVAL = {"1m": "1m", "2m": "2m", "5m": "5m", "15m": "15m", "30m": "30m",
               "1h": "60m", "1d": "1d", "1wk": "1wk"}


def yahoo_bars(symbol, interval="1d", lookback_days=3650):
    """Equity/ETF bars. Yahoo caps intraday history hard: 1m is ~30 days and
    only ~7 days per request, so minute data is chunked and stitched."""
    iv = _Y_INTERVAL.get(interval, interval)
    out = {}
    if iv in ("1m", "2m", "5m", "15m", "30m", "60m"):
        chunk = 7 if iv in ("1m", "2m") else 55
        span = min(lookback_days, 30 if iv in ("1m", "2m") else 730)
        end = datetime.now(timezone.utc)
        while span > 0:
            start = end - timedelta(days=min(chunk, span))
            url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
                   f"?period1={int(start.timestamp())}&period2={int(end.timestamp())}"
                   f"&interval={iv}&includePrePost=false")
            _absorb_yahoo(_get(url), out)
            span -= chunk
            end = start
            time.sleep(0.3)
    else:
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
               f"?range={_yahoo_range(lookback_days)}&interval={iv}"
               f"&includePrePost=false")
        _absorb_yahoo(_get(url), out)
    return [out[t] for t in sorted(out)]


def _yahoo_range(days):
    for lim, tag in ((5, "5d"), (30, "1mo"), (90, "3mo"), (180, "6mo"),
                     (365, "1y"), (730, "2y"), (1825, "5y"), (3650, "10y")):
        if days <= lim:
            return tag
    return "max"


def _absorb_yahoo(payload, out):
    try:
        res = payload["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        vols = q.get("volume") or []
        for i, t in enumerate(res["timestamp"]):
            o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
            if None in (o, h, l, c) or c <= 0:
                continue
            v = vols[i] if i < len(vols) and vols[i] is not None else 0
            out[int(t)] = Bar(t, o, h, l, c, v)
    except (KeyError, IndexError, TypeError):
        return


# ---------------------------------------------------------------- coinbase
_CB_GRAN = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400}


def coinbase_bars(product, interval="1d", lookback_days=1500):
    """Coinbase Exchange candles. Hard cap of 300 candles per request, so
    the window is paged backwards until the requested span is covered."""
    gran = _CB_GRAN.get(interval)
    if not gran:
        return []
    out = {}
    end = datetime.now(timezone.utc)
    floor = end - timedelta(days=lookback_days)
    per_req = timedelta(seconds=gran * 290)
    while end > floor:
        start = max(floor, end - per_req)
        url = (f"https://api.exchange.coinbase.com/products/{product}/candles"
               f"?granularity={gran}&start={start.isoformat()}&end={end.isoformat()}")
        rows = _get(url)
        if not rows:
            break
        for row in rows:
            try:
                t, lo, hi, op, cl, vol = row
                out[int(t)] = Bar(t, op, hi, lo, cl, vol)
            except (TypeError, ValueError):
                continue
        end = start
        time.sleep(0.35)
    return [out[t] for t in sorted(out)]


# ------------------------------------------------------------------ kraken
_KR_MIN = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440}


def kraken_bars(pair, interval="1d", lookback_days=1500):
    """Kraken OHLC. Returns at most ~720 bars per call regardless of `since`,
    so this is a shallow source for minute data and a fine one for daily."""
    mins = _KR_MIN.get(interval)
    if not mins:
        return []
    since = int(time.time() - lookback_days * 86400)
    url = (f"https://api.kraken.com/0/public/OHLC?pair={pair}"
           f"&interval={mins}&since={since}")
    d = _get(url)
    if not d or d.get("error"):
        return []
    result = d.get("result") or {}
    rows = next((v for k, v in result.items() if k != "last"), [])
    out = []
    for r in rows:
        try:
            t, o, h, l, c, _vwap, vol, _n = r
            out.append(Bar(t, o, h, l, c, vol))
        except (TypeError, ValueError):
            continue
    return out


# ------------------------------------------------------------------ alpaca
def alpaca_crypto_bars(symbol, interval="1d", lookback_days=1500):
    """Alpaca's crypto market data needs NO API key — verified live. That
    makes it the one source giving equities-shaped and crypto-shaped data
    from a single US venue we also execute on."""
    tf = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour",
          "1d": "1Day"}.get(interval)
    if not tf:
        return []
    start = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    out, page = {}, None
    for _ in range(40):
        q = {"symbols": symbol, "timeframe": tf, "start": start, "limit": "10000"}
        if page:
            q["page_token"] = page
        url = "https://data.alpaca.markets/v1beta3/crypto/us/bars?" + urllib.parse.urlencode(q)
        d = _get(url)
        if not d:
            break
        for row in (d.get("bars") or {}).get(symbol, []):
            try:
                t = int(datetime.fromisoformat(row["t"].replace("Z", "+00:00")).timestamp())
                out[t] = Bar(t, row["o"], row["h"], row["l"], row["c"], row.get("v", 0))
            except (KeyError, ValueError):
                continue
        page = d.get("next_page_token")
        if not page:
            break
        time.sleep(0.25)
    return [out[t] for t in sorted(out)]


# ---------------------------------------------------------------- dispatch
SOURCES = {
    "yahoo": yahoo_bars,
    "coinbase": coinbase_bars,
    "kraken": kraken_bars,
    "alpaca": alpaca_crypto_bars,
}


def load(symbol, interval="1d", source="yahoo", lookback_days=3650,
         use_cache=True, max_age=None):
    """Bars for one symbol, cached. Returns [] on failure — never raises,
    never silently returns a partial series pretending to be complete."""
    if use_cache:
        hit = _read_cache(source, symbol, interval, max_age, need_days=lookback_days)
        if hit:
            return hit
    fn = SOURCES.get(source)
    if not fn:
        raise ValueError(f"unknown bar source {source!r}")
    bars = fn(symbol, interval, lookback_days)
    if bars:
        _write_cache(source, symbol, interval, bars, lookback_days)
    return bars


def load_many(symbols, interval="1d", source="yahoo", lookback_days=3650,
              use_cache=True):
    """{symbol: [Bar]} for a universe, skipping symbols that return nothing."""
    out = {}
    for s in symbols:
        b = load(s, interval, source, lookback_days, use_cache)
        if b:
            out[s] = b
    return out


def align(series_map, min_coverage=0.0):
    """Restrict a {symbol: [Bar]} map to timestamps present for EVERY symbol.

    Cross-sectional desks must compare like with like: ranking six assets
    where one is missing today's bar silently ranks yesterday against today.

    `min_coverage` guards against one young symbol destroying the sample.
    An ETF that listed in 2024 intersected against ten years of SPY leaves
    660 usable bars, and a desk judged on 660 bars when 2500 were available
    is being judged on a bull market. Symbols covering less than this
    fraction of the longest series are DROPPED (and named in the return)
    rather than silently truncating everyone else.
    """
    if not series_map:
        return [], {}, []
    longest = max(len(v) for v in series_map.values())
    kept, dropped = {}, []
    for sym, bars in series_map.items():
        if longest and len(bars) / longest < min_coverage:
            dropped.append(sym)
        else:
            kept[sym] = bars
    if not kept:
        return [], {}, dropped

    common, indexed = None, {}
    for sym, bars in kept.items():
        idx = {b.t: b for b in bars}
        indexed[sym] = idx
        common = set(idx) if common is None else (common & set(idx))
    ts = sorted(common or [])
    return ts, {s: [indexed[s][t] for t in ts] for s in kept}, dropped


def returns(bars, field="c"):
    """Simple returns between consecutive bars of one series."""
    vals = [getattr(b, field) for b in bars]
    return [vals[i + 1] / vals[i] - 1 for i in range(len(vals) - 1)
            if vals[i] > 0]


def sma(values, n):
    """Trailing simple moving average; entry i uses values[i-n+1..i]."""
    if n <= 0 or len(values) < n:
        return []
    out, run = [], sum(values[:n])
    out.append(run / n)
    for i in range(n, len(values)):
        run += values[i] - values[i - n]
        out.append(run / n)
    return out


def realized_vol(rets, n, periods_per_year=365):
    """Trailing annualized volatility over the last n returns."""
    if len(rets) < n or n < 2:
        return None
    w = rets[-n:]
    m = sum(w) / n
    var = sum((r - m) ** 2 for r in w) / (n - 1)
    return math.sqrt(var * periods_per_year)
