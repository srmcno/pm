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

    def submit(self, symbol, qty, side, limit_price=None):
        order = {"symbol": symbol, "qty": str(qty), "side": side,
                 "time_in_force": "day"}
        if limit_price:
            order.update({"type": "limit", "limit_price": str(round(limit_price, 2))})
        else:
            order["type"] = "market"
        return self._req("POST", "/v2/orders", data=json.dumps(order))


def assert_armed(args):
    if os.path.exists(STOP):
        raise NotArmed("data/stocks/STOP exists — trading halted")
    if not (getattr(args, "live", False) and
            getattr(args, "i_accept_total_loss", False)):
        raise NotArmed("execution requires both --live and "
                       "--i-accept-total-loss")


def mirror_position(client: Alpaca, pos, opening):
    """Mirror one paper decision onto the Alpaca account."""
    side = ("buy" if pos["side"] == "long" else "sell") if opening else \
           ("sell" if pos["side"] == "long" else "buy")
    qty = max(1, int(pos["shares"]))
    return client.submit(pos["symbol"], qty, side)
