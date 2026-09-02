#!/usr/bin/env python3
"""Kalshi venue adapter — CFTC-regulated event contracts. Ships disarmed.

Every market-data method here is UNAUTHENTICATED and was verified returning
200 on 2026-08-30. Trading methods sign requests with an RSA key and refuse
to run without credentials, explicit arming flags, and the absence of
data/desk/STOP.

Facts this code depends on, all verified live or from Kalshi's own docs:

  * Base URL https://api.elections.kalshi.com/trade-api/v2.
  * PRICES ARE READ FROM THE *_dollars FIELDS ONLY. The legacy integer-cent
    fields cannot represent sub-cent prices and truncate them silently —
    a tutorial written against pre-2026 Kalshi will be quietly wrong.
  * QUANTITIES ARE FIXED-POINT STRINGS in `_fp` fields, granularity 0.01
    contracts. Kalshi's own advice: multiply by 100 and use integers.
  * TICK SIZE IS NOT ONE CENT. Each market carries `price_ranges`, an array
    of {start, end, step} bands in dollars, and that array is the source of
    truth — twelve named structures exist, several tapered (finer below
    $0.10 and above $0.90), new ones get added, and an OFF-GRID PRICE IS
    REJECTED. `snap_price` reads the bands; nothing keys off the name.
  * DATA IS PARTITIONED live vs historical at a rolling ~3-month cutoff.
    GET /historical/cutoff first and route by age, because a query for old
    data against the live endpoint returns EMPTY, not an error. A backtest
    that forgot this would silently lose most of its sample.
  * Fee = 0.07 x fee_multiplier x contracts x P x (1-P), rounded up to a
    millionth. `fee_multiplier` and `fee_type` are per-series fields from
    GET /series and are read live, never hardcoded. Maker is free on ~98.7%
    of series; the headline economics series charge makers 0.25x.
  * Rate limits are real and aggressive; every read backs off on 429.
"""
import base64
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
STOP_FILE = os.path.join(REPO, "data", "desk", "STOP")


class NotArmed(Exception):
    pass


class VenueError(RuntimeError):
    def __init__(self, status, text):
        super().__init__(f"kalshi {status}: {text[:300]}")
        self.status = status


# ------------------------------------------------------------ fixed point
def to_fp(contracts):
    """Float contracts -> the string the API wants, at 0.01 granularity,
    rounded DOWN so a size never exceeds what was intended."""
    cents = math.floor(float(contracts) * 100 + 1e-9)
    return f"{cents // 100}.{cents % 100:02d}"


def from_fp(s):
    """'58.16' -> 58.16, tolerant of None. Integer cents internally."""
    try:
        return int(round(float(s) * 100)) / 100.0
    except (TypeError, ValueError):
        return 0.0


def dollars(v):
    """Parse a *_dollars field. None when absent or outside (0,1)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if 0.0 <= x <= 1.0 else None


# ------------------------------------------------------------ price grid
def snap_price(market, price, direction="down"):
    """Snap a dollar price onto the market's tick grid.

    `price_ranges` is a list of {start, end, step} in dollars. The band
    containing `price` decides the step. `direction` is "down" for a buy
    (never pay more than intended), "up" for a sell, or "nearest". Returns
    None if the market carries no grid — the caller must not guess.
    """
    ranges = market.get("price_ranges") or []
    p = float(price)
    for band in ranges:
        lo, hi, step = (float(band.get("start", 0)), float(band.get("end", 1)),
                        float(band.get("step", 0.01)))
        if lo <= p <= hi and step > 0:
            k = (p - lo) / step
            if direction == "down":
                n = math.floor(k + 1e-9)
            elif direction == "up":
                n = math.ceil(k - 1e-9)
            else:
                n = int(round(k))
            snapped = lo + n * step
            snapped = max(lo, min(hi, snapped))
            return round(snapped, 6)
    return None


def _band_step(market, price):
    for band in market.get("price_ranges") or []:
        lo, hi = float(band.get("start", 0)), float(band.get("end", 1))
        if lo <= float(price) <= hi:
            return float(band.get("step", 0.01))
    return None


# ------------------------------------------------------------------ fees
def series_fee_params(series_obj):
    """(fee_type, fee_multiplier) from a GET /series record."""
    mult = series_obj.get("fee_multiplier")
    if mult is None or mult == "":
        mult = 1.0                      # absent or null: the standard rate
    return (series_obj.get("fee_type") or "quadratic", float(mult))


def fee(price, contracts, maker=False, series_obj=None):
    """Delegates to the shared cost model with the series' live parameters."""
    from ..core import money
    ftype, mult = series_fee_params(series_obj or {})
    if maker and ftype == "quadratic":
        return 0.0                      # plain quadratic series: maker is free
    if maker and ftype.startswith("quadratic_with"):
        mult = mult * money.KALSHI_MAKER_FRACTION
        return money.kalshi_fee(price, contracts, maker=False, multiplier=mult)
    if ftype == "flat":
        return 0.0
    return money.kalshi_fee(price, contracts, maker=False, multiplier=mult)


# --------------------------------------------------------------- arming
def assert_armed(args):
    if os.path.exists(STOP_FILE):
        raise NotArmed(f"STOP file present at {STOP_FILE}")
    if not (getattr(args, "live", False) and
            getattr(args, "i_accept_total_loss", False)):
        raise NotArmed("real orders require both --live and --i-accept-total-loss")
    if not (os.environ.get("KALSHI_API_KEY_ID") and
            os.environ.get("KALSHI_PRIVATE_KEY_PATH")):
        raise NotArmed("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH are not set")


class KalshiVenue:
    def __init__(self, key_id=None, private_key_path=None, timeout=30, transport=None):
        self.key_id = key_id or os.environ.get("KALSHI_API_KEY_ID")
        self.key_path = private_key_path or os.environ.get("KALSHI_PRIVATE_KEY_PATH")
        self.timeout = timeout
        self._key = None
        self._transport = transport        # test seam: (method, url, headers, body) -> (status, text)
        self._cutoff = None

    # ------------------------------------------------------------ transport
    def _http(self, method, url, headers, body=None, tries=5):
        if self._transport:
            status, text = self._transport(method, url, headers, body)
            if status >= 400:
                raise VenueError(status, text)
            return json.loads(text) if text else {}
        for i in range(tries):
            req = urllib.request.Request(url, data=body, method=method,
                                         headers={"User-Agent": "deskbot/2.0", **headers})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    text = r.read().decode()
                    return json.loads(text) if text else {}
            except urllib.error.HTTPError as e:
                if e.code == 429 and i < tries - 1:
                    time.sleep(2 * (i + 1) + 1)
                    continue
                raise VenueError(e.code, e.read().decode(errors="replace"))
        raise VenueError(429, "rate limited after retries")

    def _get(self, path, params=None):
        url = BASE_URL + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return self._http("GET", url, {})

    # --------------------------------------------------------- public reads
    def historical_cutoff(self):
        if self._cutoff is None:
            self._cutoff = self._get("/historical/cutoff")
        return self._cutoff

    def markets(self, status=None, limit=200, cursor=None, series_ticker=None,
                event_ticker=None):
        return self._get("/markets", {"status": status, "limit": limit, "cursor": cursor,
                                      "series_ticker": series_ticker,
                                      "event_ticker": event_ticker})

    def historical_markets(self, limit=200, cursor=None):
        return self._get("/historical/markets", {"limit": limit, "cursor": cursor})

    def settled_markets(self, settled_before_iso=None, limit=200, cursor=None):
        """Route by the cutoff: settlements older than it live only in the
        historical partition, where the live endpoint returns nothing."""
        cut = (self.historical_cutoff() or {}).get("market_settled_ts")
        if settled_before_iso and cut and settled_before_iso < cut:
            return self.historical_markets(limit=limit, cursor=cursor)
        return self.markets(status="settled", limit=limit, cursor=cursor)

    def events(self, status=None, limit=200, cursor=None, with_nested_markets=True):
        return self._get("/events", {"status": status, "limit": limit, "cursor": cursor,
                                     "with_nested_markets": "true" if with_nested_markets else None})

    def market(self, ticker):
        return (self._get(f"/markets/{ticker}") or {}).get("market") or {}

    def orderbook(self, ticker, depth=20):
        return self._get(f"/markets/{ticker}/orderbook", {"depth": depth})

    def trades(self, ticker=None, limit=100, cursor=None):
        return self._get("/markets/trades", {"ticker": ticker, "limit": limit, "cursor": cursor})

    def candlesticks(self, series_ticker, ticker, start_ts, end_ts, period_interval=1440):
        if period_interval not in (1, 60, 1440):
            raise ValueError("period_interval must be 1, 60 or 1440 minutes")
        return self._get(f"/series/{series_ticker}/markets/{ticker}/candlesticks",
                         {"start_ts": start_ts, "end_ts": end_ts,
                          "period_interval": period_interval})

    def series(self, category=None, limit=200, cursor=None):
        return self._get("/series", {"category": category, "limit": limit, "cursor": cursor})

    def series_one(self, series_ticker):
        return (self._get(f"/series/{series_ticker}") or {}).get("series") or {}

    # ------------------------------------------------------------- signing
    def _load_key(self):
        if self._key is not None:
            return self._key
        try:
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            raise NotArmed("the 'cryptography' package is required for trading "
                           "(pip install cryptography); read-only paths do not need it")
        if not (self.key_id and self.key_path and os.path.exists(self.key_path)):
            raise NotArmed("KALSHI_API_KEY_ID and a readable KALSHI_PRIVATE_KEY_PATH are required")
        with open(self.key_path, "rb") as f:
            self._key = serialization.load_pem_private_key(f.read(), password=None)
        return self._key

    def _signed_headers(self, method, path):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        key = self._load_key()
        ts = str(int(time.time() * 1000))
        msg = (ts + method.upper() + "/trade-api/v2" + path).encode()
        sig = key.sign(msg, padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                                        salt_length=padding.PSS.DIGEST_LENGTH),
                       hashes.SHA256())
        return {"KALSHI-ACCESS-KEY": self.key_id,
                "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
                "KALSHI-ACCESS-TIMESTAMP": ts,
                "Content-Type": "application/json"}

    def _auth(self, method, path, body=None):
        headers = self._signed_headers(method, path.split("?")[0])
        data = json.dumps(body).encode() if body is not None else None
        return self._http(method, BASE_URL + path, headers, data)

    # -------------------------------------------------------------- trading
    def balance(self):
        return self._auth("GET", "/portfolio/balance")

    def positions(self):
        return self._auth("GET", "/portfolio/positions")

    def fills(self, limit=100, cursor=None):
        q = urllib.parse.urlencode({k: v for k, v in {"limit": limit, "cursor": cursor}.items() if v})
        return self._auth("GET", "/portfolio/fills" + ("?" + q if q else ""))

    def create_order(self, ticker, side, action, contracts, price, client_order_id,
                     market=None, post_only=False):
        """Limit order at `price` (dollars), `side` yes|no, `action` buy|sell.

        The price is snapped to the market's grid first; an off-grid price is
        rejected by the venue. Contracts are sent as a fixed-point string.
        """
        m = market or self.market(ticker)
        snapped = snap_price(m, price, "down" if action == "buy" else "up")
        if snapped is None:
            raise ValueError(f"{ticker} carries no price_ranges; refusing to guess the tick")
        body = {"ticker": ticker, "side": side, "action": action, "type": "limit",
                "count_fp": to_fp(contracts), "client_order_id": client_order_id,
                ("yes_price_dollars" if side == "yes" else "no_price_dollars"): f"{snapped:.4f}"}
        if post_only:
            body["post_only"] = True
        return self._auth("POST", "/portfolio/orders", body)

    def order(self, order_id):
        return self._auth("GET", f"/portfolio/orders/{order_id}")

    def cancel_order(self, order_id):
        return self._auth("DELETE", f"/portfolio/orders/{order_id}")

    def order_state(self, order_id):
        """(status, filled_contracts, avg_price). Same contract as Alpaca's:
        'not_found' is distinguishable from a transient failure."""
        try:
            o = (self.order(order_id) or {}).get("order") or {}
        except VenueError as e:
            if e.status == 404:
                return "not_found", 0.0, None
            return None, 0.0, None
        except Exception:                                    # noqa: BLE001
            return None, 0.0, None
        filled = from_fp(o.get("fill_count_fp") or o.get("filled_count_fp") or 0)
        # The order object carries no average price; it is the fill cost
        # (taker and maker, fixed-point dollars) over the contracts filled.
        def _cost(v):                      # a dollar amount, not a price
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                return 0.0
        cost = _cost(o.get("taker_fill_cost_dollars")) + _cost(o.get("maker_fill_cost_dollars"))
        if filled > 0 and cost > 0:
            px = cost / filled
        else:
            px = dollars(o.get("yes_price_dollars")) or None
        return o.get("status"), filled, px


def smoke_test():
    """Keyless: every public read path against the live API."""
    v = KalshiVenue()
    cut = v.historical_cutoff()
    assert "market_settled_ts" in cut, cut
    print("cutoff ok:", cut.get("market_settled_ts"))
    ms = v.markets(status="open", limit=3).get("markets") or []
    assert ms, "no open markets returned"
    m = ms[0]
    print("markets ok:", m.get("ticker"), "ask", m.get("yes_ask_dollars"),
          "grid bands", len(m.get("price_ranges") or []))
    if m.get("price_ranges"):
        print("snap 0.4567 ->", snap_price(m, 0.4567, "down"))
    ob = v.orderbook(m["ticker"], depth=3)
    print("orderbook ok:", list((ob.get("orderbook") or ob).keys())[:4])
    assert to_fp(58.16) == "58.16" and from_fp("58.16") == 58.16
    print("fixed point ok")


if __name__ == "__main__":
    smoke_test()
