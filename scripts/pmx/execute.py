#!/usr/bin/env python3
"""CLOB execution: bounded-slippage entries, maker-first exits, hard rejections.

Order types available on the venue (verified against py-clob-client): GTC,
GTD, FOK, FAK, plus a `post_only` flag on post_order.

  FOK  all or nothing at the limit. The honest default for a copy entry: a
       partial fill at a worse average is precisely the edge decay this
       redesign exists to remove.
  FAK  take what is there, cancel the rest. Used when a partial position is
       genuinely better than none -- exits, mostly.
  GTC + post_only  guarantees maker status or rejection.

That last one is worth real money here. Polymarket charges takers
feeRate*p*(1-p) per share and makers nothing, so crossing the spread on a
Sports market at 50c costs 1.25c per share -- 2.5% of notional -- while the
same fill obtained passively costs zero. Entries still cross by default,
because a copy signal decays faster than the fee saves; exits post passively,
because a take-profit at 96c has no deadline and no reason to pay 2.5% to
skip a queue.

Nothing here places an order unless armed exactly as the existing
livetrade.py requires: keys in the environment, both explicit flags, and no
data/live/STOP file. `dry_run=True` is the default and produces the full
plan, including the depth-walked fill and the fee, without touching a venue.
"""
import os
import time

from . import fees
from .book import Book, round_to_tick
from .consensus import drift_check, net_edge


class Rejected(Exception):
    """An order that must not be sent, with the reason the journal records."""


class ExecutionClient:
    def __init__(self, cfg, dry_run=True, client=None, journal=None):
        self.cfg = cfg
        self.dry_run = dry_run
        self._client = client
        self._journal = journal or (lambda **kw: None)
        self._tick_cache = {}

    # ---------------------------------------------------------------- venue
    @property
    def client(self):
        if self._client is None:
            self._client = _make_client()
        return self._client

    def fetch_book(self, token_id):
        """One call returns depth, tick size, min size and neg_risk together."""
        raw = self.client.get_order_book(token_id)
        book = Book.parse(raw, token_id)
        self._tick_cache[token_id] = (book.tick_size, book.neg_risk)
        return book

    # ------------------------------------------------------------ preflight
    def check_entry(self, signal, book: Book, w, stake_usd, *, category=None,
                    now=None):
        """Every reason not to send this order, computed before sizing commits.

        Returns a plan dict. Raises Rejected with a specific reason otherwise,
        so the caller never has to guess which rail stopped a trade.
        """
        x = self.cfg.execution
        now = now or time.time()

        age = now - (signal.get("detectedAt") or signal.get("generatedAt") or now)
        if age > x.max_signal_age_s:
            raise Rejected(f"signal is {age:.0f}s old (limit "
                           f"{x.max_signal_age_s:.0f}s) — the fill it was "
                           f"sized against no longer exists")

        if book.is_crossed():
            raise Rejected("book is crossed or locked — stale snapshot")
        ask = book.best_ask
        if ask is None:
            raise Rejected("no resting ask to buy")
        if book.spread is not None and book.spread > x.max_spread:
            raise Rejected(f"spread {book.spread:.3f} > {x.max_spread:.3f}")
        if not (x.min_price <= ask <= x.max_price):
            raise Rejected(f"ask {ask:.3f} outside the tradable band "
                           f"[{x.min_price:.2f}, {x.max_price:.2f}]")

        ok, drift = drift_check(ask, signal.get("backersAvgEntry"), x)
        if not ok:
            raise Rejected(f"price drift {drift['drift']:+.3f} "
                           f"({drift['driftLogit']:+.3f} log-odds) past the "
                           f"backers' entry — copying now is chasing")

        limit = round_to_tick(min(ask + x.max_slippage, x.max_price),
                              book.tick_size, "down")
        walk = book.walk(stake_usd, limit_price=limit, side="buy")
        if not walk["complete"]:
            raise Rejected(f"only ${walk['filled']:.2f} of ${stake_usd:.2f} "
                           f"available at or under {limit:.3f}")
        fill = walk["avgPrice"]
        slip = fill - ask
        if slip > x.max_slippage:
            raise Rejected(f"depth-walked slippage {slip:.4f} > "
                           f"{x.max_slippage:.4f}")

        rate = fees.taker_rate(category, x)
        entry_fee = fees.fee_per_share(fill, rate)
        ev = net_edge(w, fill, entry_fee)
        if ev <= 0:
            raise Rejected(f"net EV {ev*100:+.2f}c/share after a "
                           f"{entry_fee*100:.2f}c fee — the fee eats the edge")

        return {
            "tokenId": signal.get("tokenId"),
            "conditionId": signal.get("conditionId"),
            "outcomeIndex": signal.get("outcomeIndex"),
            "question": signal.get("question"),
            "outcome": signal.get("outcome"),
            "side": "BUY",
            "limit": limit,
            "expectedFill": round(fill, 5),
            "shares": round(walk["shares"], 2),
            "stake": round(stake_usd, 2),
            "slippage": round(slip, 5),
            "feePerShare": round(entry_fee, 6),
            "feeRate": rate,
            "netEdge": round(ev, 5),
            "netEdgeUsd": round(ev * walk["shares"], 4),
            "drift": drift,
            "tickSize": book.tick_size,
            "negRisk": book.neg_risk,
            "signalAgeS": round(age, 1),
        }

    # --------------------------------------------------------------- submit
    def submit_entry(self, plan, order_type=None):
        """Send the entry. Dry run returns the plan annotated, unsent."""
        order_type = order_type or self.cfg.execution.order_type
        if plan["shares"] < 5.0:
            raise Rejected(f"{plan['shares']:.2f} shares below the exchange "
                           f"minimum of 5")
        if self.dry_run:
            self._journal(action="PLAN_ENTRY", orderType=order_type, **plan)
            return {"status": "dry-run", "orderType": order_type, **plan}
        _assert_armed()
        return self._post(plan, order_type, post_only=False)

    def submit_exit(self, plan, patient=True):
        """Exits post passively by default: a maker fill pays no fee at all.

        A take-profit has no deadline, so paying the taker fee to jump the
        queue on it is a pure loss. An urgent exit -- stop-loss or consensus
        reversal -- crosses instead, because being wrong for longer costs
        more than the fee.
        """
        if self.dry_run:
            self._journal(action="PLAN_EXIT", patient=patient, **plan)
            return {"status": "dry-run", "patient": patient, **plan}
        _assert_armed()
        if patient:
            return self._post(plan, "GTC", post_only=True)
        return self._post(plan, "FAK", post_only=False)

    def _post(self, plan, order_type, post_only):
        from py_clob_client.clob_types import (OrderArgs, OrderType,
                                               PartialCreateOrderOptions)
        args = OrderArgs(token_id=plan["tokenId"], price=plan["limit"],
                         size=plan["shares"], side=plan["side"])
        opts = PartialCreateOrderOptions(neg_risk=bool(plan.get("negRisk")))
        try:
            order = self.client.create_order(args, opts)
            resp = self.client.post_order(order, getattr(OrderType, order_type),
                                          post_only=post_only)
        except Exception as e:                            # noqa: BLE001
            self._journal(action="ORDER_ERROR", error=str(e), **plan)
            raise Rejected(f"venue rejected the order: {e}") from e
        ok = not (isinstance(resp, dict) and resp.get("success") is False)
        self._journal(action="ORDER" if ok else "ORDER_REJECTED",
                      orderType=order_type, postOnly=post_only,
                      response=str(resp)[:400], **plan)
        if not ok:
            raise Rejected(f"venue rejected: {resp.get('errorMsg')}")
        return {"status": "sent", "orderType": order_type,
                "postOnly": post_only, "orderId": (resp or {}).get("orderID"),
                "response": resp, **plan}

    def cancel_all(self):
        if self.dry_run:
            return {"status": "dry-run"}
        return self.client.cancel_all()


# ------------------------------------------------------------------ arming

STOP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "..", "..", "data", "live", "STOP")


def _assert_armed():
    if os.path.exists(STOP_FILE):
        raise Rejected("data/live/STOP exists — trading halted")
    if os.environ.get("PMX_ARMED") != "yes-i-accept-total-loss":
        raise Rejected("not armed: set PMX_ARMED=yes-i-accept-total-loss and "
                       "run with --live --i-accept-total-loss")


def _make_client():
    key = os.environ.get("PM_PRIVATE_KEY")
    funder = os.environ.get("PM_PROXY_ADDRESS")
    sig = os.environ.get("PM_SIGNATURE_TYPE")
    if not (key and funder and sig):
        raise Rejected("missing PM_PRIVATE_KEY / PM_PROXY_ADDRESS / "
                       "PM_SIGNATURE_TYPE")
    try:
        from py_clob_client.client import ClobClient
    except ImportError as e:
        raise Rejected("pip install py-clob-client") from e
    c = ClobClient("https://clob.polymarket.com", key=key, chain_id=137,
                   signature_type=int(sig), funder=funder)
    c.set_api_creds(c.create_or_derive_api_creds())
    return c
