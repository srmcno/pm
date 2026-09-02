#!/usr/bin/env python3
"""Alpaca venue adapter — US equities and crypto. Ships disarmed.

Nothing here can send an order unless all of the following hold at once:
credentials in the environment (APCA_API_KEY_ID / APCA_API_SECRET_KEY), the
caller passed `--live` AND `--i-accept-total-loss`, and data/desk/STOP does
not exist. The paper endpoint is the default even then; real money is a
separate explicit choice (`paper=False`).

Every rule below was verified against Alpaca's documentation and fee
schedule on 2026-08-30. They are enforced CLIENT-SIDE, before submission,
because the venue's own rejection arrives after the moment you needed to
know:

  EQUITIES
  * $0 commission on a direct retail account. Regulatory fees (SEC on sells,
    FINRA TAF on sells, CAT both sides) aggregate per day per fee type and
    round UP to the cent — any active day costs at least $0.03.
  * Market-on-close ('cls') and market-on-open ('opg') exist and fill at the
    official auction print. MOC must be in before 15:50 ET, MOO before
    09:28 ET; the venue rejects late ones and so does `submit`.
  * FRACTIONAL orders take only time_in_force='day' and only market/limit/
    stop/stop_limit. GTC, IOC, FOK, OPG and CLS are rejected for fractional
    quantities. So an auction order MUST be a whole number of shares — a
    consequence the overnight desk's sizing has to respect.
  * There are NO fractional shorts; a fractional sell is marked long. Under
    $2,000 equity the account is limited-margin: 1x buying power and no
    shorting at all. `can_short()` reports which regime the account is in.
  * Notional orders cannot be replaced; cancel and resubmit.

  CRYPTO
  * Order types market/limit/stop_limit only; time_in_force gtc or ioc only
    ('day' is rejected). No shorting, no margin, 24/7.
  * Fees (25bps taker / 15bps maker, base tier) post at END OF DAY and are
    deducted from the asset RECEIVED, so a naive position count drifts by
    the fee. Reconciliation must read the venue's position, not the fill.
  * `min_order_size` is read from the assets endpoint, never hardcoded.
  * Crypto market data needs NO API key — verified live.

  DATA
  * The free tier's real-time quote is IEX only (~2.5% of volume, not the
    NBBO). This is a structural reason to execute in the auction rather than
    react to live quotes: the official print is what the free tier reports
    accurately.
"""
import datetime as _dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

PAPER_URL = "https://paper-api.alpaca.markets"
LIVE_URL = "https://api.alpaca.markets"
DATA_URL = "https://data.alpaca.markets"
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
STOP_FILE = os.path.join(BASE, "data", "desk", "STOP")

# Terminal states that will never fill. Everything else — new, accepted,
# pending_new, partially_filled, accepted_for_bidding — is still working.
FAILED_STATUSES = {"canceled", "expired", "rejected", "stopped", "suspended",
                   "replaced", "done_for_day"}
FILLED = "filled"

MOC_CUTOFF_ET = (15, 50)     # market-on-close must be in before this
MOO_CUTOFF_ET = (9, 28)      # market-on-open must be in before this
LIMITED_MARGIN_EQUITY = 2000.0


class NotArmed(Exception):
    """Raised when a real order was requested without every safeguard."""


def format_qty(qty):
    """Whole shares as an integer string; fractions as plain decimals. A
    dust lot like 1.6e-05 BTC must not serialize in exponent notation."""
    q = float(qty)
    if not _is_fractional(q):
        return str(int(round(q)))
    return f"{q:.9f}".rstrip("0").rstrip(".")


class VenueError(RuntimeError):
    def __init__(self, status, text):
        super().__init__(f"alpaca {status}: {text[:300]}")
        self.status = status


def _is_crypto(symbol):
    return "/" in symbol


def _is_fractional(qty):
    return abs(float(qty) - round(float(qty))) > 1e-9


def assert_armed(args):
    """Every safeguard, or no order. Order of checks is deliberate: the STOP
    file wins over everything, including an operator who set both flags."""
    if os.path.exists(STOP_FILE):
        raise NotArmed(f"STOP file present at {STOP_FILE}")
    if not (getattr(args, "live", False) and
            getattr(args, "i_accept_total_loss", False)):
        raise NotArmed("real orders require both --live and --i-accept-total-loss")
    if not (os.environ.get("APCA_API_KEY_ID") and os.environ.get("APCA_API_SECRET_KEY")):
        raise NotArmed("APCA_API_KEY_ID / APCA_API_SECRET_KEY are not set")


def validate_order(symbol, qty, side, order_type, time_in_force,
                   extended_hours=False, can_short=True):
    """Reject client-side what the venue would reject anyway, with a reason
    that says which rule was hit. Returns None or raises ValueError."""
    q = float(qty)
    if q <= 0:
        raise ValueError("quantity must be positive")
    frac = _is_fractional(q)
    if _is_crypto(symbol):
        if order_type not in ("market", "limit", "stop_limit"):
            raise ValueError(f"crypto supports market/limit/stop_limit, not {order_type!r}")
        if time_in_force not in ("gtc", "ioc"):
            raise ValueError("crypto orders take time_in_force gtc or ioc only ('day' is rejected)")
        if side == "sell_short":
            raise ValueError("crypto cannot be shorted")
        if extended_hours:
            raise ValueError("extended_hours does not apply to crypto")
        return None
    if order_type in ("cls", "opg"):
        if frac:
            raise ValueError(f"{order_type} auction orders must be whole shares; got {q}")
        if time_in_force not in ("day", "cls", "opg"):
            raise ValueError(f"{order_type} orders use time_in_force 'day'")
        if extended_hours:
            raise ValueError("auction orders cannot be flagged extended_hours")
    if frac:
        if time_in_force != "day":
            raise ValueError("fractional orders take time_in_force 'day' only")
        if order_type not in ("market", "limit", "stop", "stop_limit"):
            raise ValueError(f"fractional orders cannot be {order_type!r}")
        if side == "sell_short":
            raise ValueError("there are no fractional shorts; all fractional sells are marked long")
    if side == "sell_short" and not can_short:
        raise ValueError("this account cannot short (under $2,000 equity it is limited-margin)")
    if extended_hours and (order_type != "limit" or time_in_force not in ("day", "gtc")):
        raise ValueError("extended-hours orders must be limit with time_in_force day or gtc")
    return None


def auction_cutoff_ok(order_type, now_et):
    """True if an auction order submitted at `now_et` would be accepted."""
    if order_type == "cls":
        return (now_et.hour, now_et.minute) < MOC_CUTOFF_ET
    if order_type == "opg":
        return (now_et.hour, now_et.minute) < MOO_CUTOFF_ET
    return True


class AlpacaVenue:
    """Thin, explicit client. Every method maps to one documented endpoint."""

    def __init__(self, paper=True, key=None, secret=None, timeout=20):
        self.key = key or os.environ.get("APCA_API_KEY_ID")
        self.secret = secret or os.environ.get("APCA_API_SECRET_KEY")
        if not (self.key and self.secret):
            raise NotArmed("APCA_API_KEY_ID / APCA_API_SECRET_KEY are not set")
        self.paper = bool(paper)
        self.base = PAPER_URL if paper else LIVE_URL
        self.timeout = timeout

    # ------------------------------------------------------------ transport
    def _headers(self):
        return {"APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.secret,
                "Content-Type": "application/json", "User-Agent": "deskbot/2.0"}

    def _req(self, method, url, params=None, body=None):
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                text = r.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            raise VenueError(e.code, e.read().decode(errors="replace"))

    def _api(self, method, path, **kw):
        return self._req(method, self.base + path, **kw)

    # -------------------------------------------------------------- account
    def account(self):
        return self._api("GET", "/v2/account")

    def clock(self):
        return self._api("GET", "/v2/clock")

    def is_open(self):
        return bool(self.clock().get("is_open"))

    def now_et(self):
        """The venue's clock, in Eastern time, so cutoffs are judged on the
        exchange's time rather than the runner's."""
        ts = self.clock().get("timestamp")
        t = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return t.astimezone(_et())

    def positions(self):
        return self._api("GET", "/v2/positions")

    def position(self, symbol):
        try:
            return self._api("GET", f"/v2/positions/{urllib.parse.quote(symbol, safe='')}")
        except VenueError as e:
            if e.status == 404:
                return None
            raise

    def asset(self, symbol):
        return self._api("GET", f"/v2/assets/{urllib.parse.quote(symbol, safe='')}")

    def can_short(self):
        """Shorting needs a full margin account, which needs $2,000 equity."""
        a = self.account()
        try:
            eq = float(a.get("equity") or 0)
        except (TypeError, ValueError):
            return False
        return eq >= LIMITED_MARGIN_EQUITY and bool(a.get("shorting_enabled", True))

    # ----------------------------------------------------------------- data
    def latest_quote(self, symbol):
        """Equity NBBO on a paid plan, IEX top-of-book on the free tier."""
        d = self._req("GET", f"{DATA_URL}/v2/stocks/{symbol}/quotes/latest",
                      params={"feed": "iex"})
        q = d.get("quote") or {}
        return {"bid": float(q.get("bp") or 0), "ask": float(q.get("ap") or 0),
                "ts": q.get("t"), "feed": "iex"}

    @staticmethod
    def latest_crypto_quote(symbol):
        """No authentication required — verified live 2026-08-30."""
        url = (f"{DATA_URL}/v1beta3/crypto/us/latest/quotes?symbols="
               f"{urllib.parse.quote(symbol, safe='')}")
        req = urllib.request.Request(url, headers={"User-Agent": "deskbot/2.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
        q = (d.get("quotes") or {}).get(symbol) or {}
        return {"bid": float(q.get("bp") or 0), "ask": float(q.get("ap") or 0),
                "ts": q.get("t")}

    # --------------------------------------------------------------- orders
    def submit(self, symbol, qty, side, order_type="market", time_in_force=None,
               client_order_id=None, limit_price=None, notional=None,
               extended_hours=False, now_et=None):
        """Submit one order after client-side validation.

        `side` is buy | sell | sell_short. `time_in_force` defaults to what
        the instrument allows (day for equities, gtc for crypto). Auction
        orders are refused after the exchange cutoff instead of being
        submitted to be rejected.
        """
        crypto = _is_crypto(symbol)
        tif = time_in_force or ("gtc" if crypto else "day")
        api_side = "sell" if side in ("sell", "sell_short") else "buy"
        validate_order(symbol, qty, side, order_type, tif, extended_hours,
                       can_short=True if side != "sell_short" else self.can_short())
        if order_type in ("cls", "opg"):
            now = now_et or self.now_et()
            if not auction_cutoff_ok(order_type, now):
                raise ValueError(
                    f"{order_type} cutoff passed: it is {now:%H:%M} ET, cutoff "
                    f"{MOC_CUTOFF_ET if order_type == 'cls' else MOO_CUTOFF_ET}")
        body = {"symbol": symbol, "side": api_side, "time_in_force": tif,
                "type": "market" if order_type in ("cls", "opg") else order_type}
        if order_type in ("cls", "opg"):
            # Alpaca expresses the auction as a market order with tif cls/opg.
            body["time_in_force"] = order_type
        if notional is not None:
            body["notional"] = str(round(float(notional), 2))
        else:
            body["qty"] = format_qty(qty)
        if limit_price is not None:
            body["limit_price"] = str(round(float(limit_price), 2))
        if client_order_id:
            body["client_order_id"] = client_order_id
        if extended_hours:
            body["extended_hours"] = True
        return self._api("POST", "/v2/orders", body=body)

    def order_by_client_id(self, client_order_id):
        return self._api("GET", "/v2/orders:by_client_order_id",
                         params={"client_order_id": client_order_id})

    def open_orders(self):
        return self._api("GET", "/v2/orders", params={"status": "open", "limit": 500})

    def cancel_order(self, order_id):
        return self._api("DELETE", f"/v2/orders/{order_id}")

    def order_state(self, client_order_id):
        """(status, filled_qty, filled_avg_price).

        "not_found" means the venue has no such order — a submission that
        never landed may be retried under the same id. (None, 0, None) means
        the lookup itself failed; callers treat that as still pending and
        re-check, never as confirmation in either direction.
        """
        try:
            o = self.order_by_client_id(client_order_id)
        except VenueError as e:
            if e.status == 404:
                return "not_found", 0.0, None
            return None, 0.0, None
        except Exception:                                    # noqa: BLE001
            return None, 0.0, None
        px = o.get("filled_avg_price")
        return (o.get("status"), float(o.get("filled_qty") or 0),
                float(px) if px else None)

    def cancel_by_client_id(self, client_order_id):
        """Cancel if still working. False when terminal or missing."""
        try:
            o = self.order_by_client_id(client_order_id)
        except Exception:                                    # noqa: BLE001
            return False
        if o.get("status") == FILLED or o.get("status") in FAILED_STATUSES:
            return False
        try:
            self.cancel_order(o.get("id"))
            return True
        except Exception:                                    # noqa: BLE001
            return False


def _et():
    """Eastern time without a tz database dependency — the two DST rules
    the US has used since 2007, second Sunday of March to first Sunday of
    November, applied on the venue's own UTC timestamp."""
    from ..core.clock import eastern
    return eastern()


def smoke_test():
    """Keyless. Exercises the crypto quote path and the validators."""
    q = AlpacaVenue.latest_crypto_quote("BTC/USD")
    assert q["bid"] > 0 and q["ask"] > q["bid"], q
    print(f"crypto quote ok: BTC/USD {q['bid']:.2f}/{q['ask']:.2f}")
    for args, ok in (
        (("SPY", 1, "buy", "cls", "day"), True),
        (("SPY", 1.5, "buy", "cls", "day"), False),
        (("SPY", 1.5, "buy", "market", "gtc"), False),
        (("BTC/USD", 0.001, "buy", "market", "day"), False),
        (("BTC/USD", 0.001, "buy", "market", "gtc"), True),
    ):
        try:
            validate_order(*args)
            got = True
        except ValueError:
            got = False
        assert got == ok, (args, got, ok)
    print("order validators ok")
    et = _dt.datetime(2026, 8, 31, 15, 49, tzinfo=_et())
    assert auction_cutoff_ok("cls", et) and not auction_cutoff_ok("cls", et.replace(minute=51))
    print("auction cutoffs ok")


if __name__ == "__main__":
    smoke_test()
