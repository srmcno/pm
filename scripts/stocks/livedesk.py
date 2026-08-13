#!/usr/bin/env python3
"""Alpaca order executor for the equities desk. Ships disarmed.

Requirements before any order is possible:
  1. An Alpaca brokerage account (US-regulated; alpaca.markets) with API keys
     exported as APCA_API_KEY_ID and APCA_API_SECRET_KEY.
  2. ALPACA_LIVE=1 to target the live endpoint; otherwise all orders go to
     the paper endpoint (real API, simulated money).
  3. Both --live and --i-accept-total-loss flags on the command line.
  4. No STOP file at data/stocks/STOP.

Regulatory constraints on the live path:
  - Pattern day trader rule: a margin account under $25,000 equity is limited
    to 3 day trades per rolling 5 business days. This desk is a day-trading
    strategy; run it live only in an account above the PDT threshold or in a
    cash account sized for settlement, otherwise the broker will restrict it.
  - Short entries require a margin account and borrowable shares. When the
    account cannot short, the desk trades the long side only.
The paper endpoint has none of these limits and is the default.
"""
import json
import os

import requests

from . import stocklib

PAPER_URL = "https://paper-api.alpaca.markets"
LIVE_URL = "https://api.alpaca.markets"
STOP = os.path.join(stocklib.DATA_DIR, "STOP")


class NotArmed(Exception):
    pass


class Alpaca:
    def __init__(self):
        key = os.environ.get("APCA_API_KEY_ID")
        secret = os.environ.get("APCA_API_SECRET_KEY")
        if not (key and secret):
            raise NotArmed("APCA_API_KEY_ID / APCA_API_SECRET_KEY not set")
        self.base = LIVE_URL if os.environ.get("ALPACA_LIVE") == "1" else PAPER_URL
        self.s = requests.Session()
        self.s.headers.update({"APCA-API-KEY-ID": key,
                               "APCA-API-SECRET-KEY": secret})

    def _req(self, method, path, **kw):
        r = self.s.request(method, self.base + path, timeout=20, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"alpaca {r.status_code}: {r.text[:300]}")
        return r.json() if r.text else {}

    def account(self):
        return self._req("GET", "/v2/account")

    def clock(self):
        return self._req("GET", "/v2/clock")

    def positions(self):
        return self._req("GET", "/v2/positions")

    def close_all(self):
        return self._req("DELETE", "/v2/positions?cancel_orders=true")

    def submit(self, symbol, qty, side, limit_price=None, client_order_id=None):
        order = {"symbol": symbol, "qty": str(qty), "side": side,
                 "time_in_force": "day"}
        if client_order_id:
            order["client_order_id"] = client_order_id
        if limit_price:
            order.update({"type": "limit", "limit_price": str(round(limit_price, 2))})
        else:
            order["type"] = "market"
        return self._req("POST", "/v2/orders", data=json.dumps(order))

    def order_by_client_id(self, client_order_id):
        return self._req("GET", "/v2/orders:by_client_order_id",
                         params={"client_order_id": client_order_id})


# Order statuses that will never fill. Everything else — new, accepted,
# pending_new, partially_filled — is still working (or queued for the next
# session) and must be re-checked, not assumed done.
FAILED_STATUSES = {"canceled", "expired", "rejected", "stopped", "suspended"}


def order_state(client, client_order_id):
    """(status, filled_qty) for the order with this client id.

    "not_found" means the venue has no such order — a submission that never
    landed can be safely retried under the same id. (None, 0) means the
    lookup itself failed transiently; callers treat that as still pending
    and re-check, never as confirmation in either direction."""
    try:
        o = client.order_by_client_id(client_order_id)
    except RuntimeError as e:
        if "alpaca 404" in str(e):
            return "not_found", 0.0
        return None, 0.0
    except Exception:                                     # noqa: BLE001
        return None, 0.0
    return o.get("status"), float(o.get("filled_qty") or 0)


def mirror_cid(pos, opening, attempt=0):
    """Deterministic client order id per position, leg, and retry attempt."""
    leg = "o" if opening else "c"
    suffix = f"-a{attempt}" if attempt else ""
    return f"pm-{leg}-{pos['symbol']}-{int(pos['openedAt'])}{suffix}"


def assert_armed(args):
    if os.path.exists(STOP):
        raise NotArmed("data/stocks/STOP exists — trading halted")
    if not (getattr(args, "live", False) and
            getattr(args, "i_accept_total_loss", False)):
        raise NotArmed("execution requires both --live and "
                       "--i-accept-total-loss")


def mirror_position(client: Alpaca, pos, opening, attempt=0):
    """Submit one mirrored order onto the Alpaca account.

    The client order id is deterministic per position, leg, and attempt, so
    retrying an ambiguous submission — the order was accepted but the
    response was lost — reconciles to the already-accepted order instead of
    firing a second one (a duplicated close would reverse the position, not
    flatten it). Submission acceptance is NOT completion: callers confirm the
    terminal order state via order_state() before recording anything done."""
    side = ("buy" if pos["side"] == "long" else "sell") if opening else \
           ("sell" if pos["side"] == "long" else "buy")
    # A close flattens what is actually held live (liveQty), which can be
    # less than the paper size when the opening order only partially filled.
    qty = max(1, int(pos.get("liveQty") or pos["shares"])) if not opening \
        else max(1, int(pos["shares"]))
    cid = mirror_cid(pos, opening, attempt)
    try:
        return client.submit(pos["symbol"], qty, side, client_order_id=cid)
    except Exception as submit_err:
        try:
            return client.order_by_client_id(cid)
        except Exception:
            raise submit_err
