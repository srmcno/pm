#!/usr/bin/env python3
"""Live order executor for the smart-money signal strategy. USE AT YOUR OWN RISK.

This is the only tool in this repo that can touch real money, and it ships
disarmed: the default command is `plan`, which computes exactly what it would
buy and writes it to a journal without needing keys. Arming it requires keys
in the environment AND two explicit flags, and even then hard limits apply.

Commands:
  plan      dry run — size orders from the latest signals, print & journal them
  execute   place real limit orders on the CLOB (requires keys + both flags)
  status    show the funded account's balance and open positions
  halt      create the STOP file — every future run refuses to trade

Arming checklist (nothing here works until YOU do these):
  1. Fund a Polymarket account and export its key:
       PM_PRIVATE_KEY   Polygon private key that controls the account
       PM_PROXY_ADDRESS your Polymarket proxy wallet (profile address)
       PM_SIGNATURE_TYPE 1 (email/magic login) or 2 (browser wallet)
  2. pip install py-clob-client
  3. Run: python3 livetrade.py execute --live --i-accept-total-loss

Hard rails (data/live/config.json, edit deliberately):
  bankroll_cap        max capital deployed in open positions (default $20)
  max_stake_per_trade per-order ceiling                      (default $2)
  max_daily_stake     per-24h ceiling                        (default $8)
  max_open            max simultaneous positions             (default 8)
  min_score           minimum signal score                   (default 3.0)
  max_spread          skip books wider than this bid/ask gap (default 8¢)
  A file at data/live/STOP halts all trading until you delete it.

Each execute run starts by cancelling any resting unfilled orders from the
previous cycle and reconciling recorded positions against the exchange, so
the rails always measure real exposure — not orders we merely posted.

Winnings must be redeemed on polymarket.com (positions marked redeemable).
Nothing in this file is financial advice. Expect to lose the bankroll.
"""
import argparse
import json
import os
import sys
import time

import pmlib

LIVE_DIR = os.path.join(pmlib.BASE, "data", "live")
CONFIG = os.path.join(LIVE_DIR, "config.json")
JOURNAL = os.path.join(LIVE_DIR, "journal.jsonl")
POSITIONS = os.path.join(LIVE_DIR, "positions.json")
STOP = os.path.join(LIVE_DIR, "STOP")

DEFAULT_CONFIG = {
    "bankroll_cap": 20.0,
    "max_stake_per_trade": 2.0,
    "max_daily_stake": 8.0,
    "max_open": 8,
    "min_score": 3.0,
    "price_buffer": 0.02,
    "max_price": 0.90,
    "min_price": 0.05,
    "max_spread": 0.08,
}


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    os.makedirs(LIVE_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)


def journal(event):
    os.makedirs(LIVE_DIR, exist_ok=True)
    event = {"t": int(time.time()), **event}
    with open(JOURNAL, "a") as f:
        f.write(json.dumps(event) + "\n")


def load_config():
    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG, {})}
    save_json(CONFIG, cfg)
    return cfg


def o_desc(s):
    return f"{(s.get('question') or '?')[:48]} -> {s.get('outcome')}"


def plan_orders(cfg, state=None):
    """Turn the latest signals into concrete orders under the hard rails."""
    payload = load_json(os.path.join(pmlib.BASE, "data", "signals", "latest.json"), None)
    if not payload:
        raise SystemExit("no signals — run signals.py --live first")
    age_h = (time.time() - payload["meta"]["generatedAt"]) / 3600
    if age_h > 12:
        raise SystemExit(f"signals are {age_h:.0f}h old — run signals.py --live first")

    if state is None:
        state = load_json(POSITIONS, {"open": [], "dailySpend": [], "totalDeployed": 0.0})
    day_ago = time.time() - 86400
    spent_today = sum(s["usd"] for s in state["dailySpend"] if s["t"] >= day_ago)
    held = {(p["conditionId"], p["outcomeIndex"]) for p in state["open"]}

    orders, budget_day = [], cfg["max_daily_stake"] - spent_today
    budget_total = cfg["bankroll_cap"] - state["totalDeployed"]
    for s in payload["signals"]:
        if s["score"] < cfg["min_score"]:
            continue
        if (s["conditionId"], s["outcomeIndex"]) in held:
            continue
        if len(state["open"]) + len(orders) >= cfg["max_open"]:
            break
        px = pmlib.midpoint(s["tokenId"]) or s["currentPrice"]
        bid = pmlib.best_price(s["tokenId"], "sell")
        ask = pmlib.best_price(s["tokenId"], "buy")
        if ask is None:
            print(f"  skip (no ask in the book): {o_desc(s)}")
            continue
        if bid is not None and ask - bid > cfg.get("max_spread", 0.08):
            # A wide book makes the midpoint fiction; a "2¢ buffer" on a
            # 40¢ spread is how a $4 order overpays by dimes.
            print(f"  skip (spread {ask - bid:.2f} too wide): {o_desc(s)}")
            continue
        limit = round(min(px + cfg["price_buffer"], ask + 0.005, 0.99), 3)
        if not (cfg["min_price"] <= limit <= cfg["max_price"]):
            continue
        stake = round(min(cfg["max_stake_per_trade"], budget_day, budget_total), 2)
        if stake < 1.0:
            break
        shares = max(5.0, round(stake / limit, 2))  # CLOB minimum 5 shares
        cost = round(shares * limit, 2)
        if cost > cfg["max_stake_per_trade"] * 1.01:
            # the 5-share exchange minimum would bust the per-trade cap
            print(f"  skip (5-share min = ${cost:.2f} > per-trade cap): "
                  f"{o_desc(s)}")
            continue
        if cost > budget_day or cost > budget_total:
            continue
        budget_day -= cost
        budget_total -= cost
        orders.append({"tokenId": s["tokenId"], "conditionId": s["conditionId"],
                       "outcomeIndex": s["outcomeIndex"], "question": s["question"],
                       "outcome": s["outcome"], "limit": limit, "shares": shares,
                       "cost": cost, "score": s["score"]})
    return orders, state


def cmd_plan(args, cfg):
    orders, _ = plan_orders(cfg)
    if not orders:
        print("Nothing to do — no qualifying signals inside the rails.")
    for o in orders:
        print(f"WOULD BUY {o['shares']:.0f} × {o['question'][:52]} -> {o['outcome']}"
              f" @ ≤{o['limit']:.2f} (${o['cost']:.2f}, score {o['score']:.1f})")
        journal({"action": "PLAN", **o})
    print(f"\n{len(orders)} orders planned. This was a dry run — nothing was placed."
          f"\nTo arm: see the checklist in this file's docstring.")


def make_client():
    key = os.environ.get("PM_PRIVATE_KEY")
    funder = os.environ.get("PM_PROXY_ADDRESS")
    sig = os.environ.get("PM_SIGNATURE_TYPE")
    if not (key and funder and sig):
        raise SystemExit("missing PM_PRIVATE_KEY / PM_PROXY_ADDRESS / PM_SIGNATURE_TYPE")
    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        raise SystemExit("pip install py-clob-client")
    client = ClobClient("https://clob.polymarket.com", key=key, chain_id=137,
                        signature_type=int(sig), funder=funder)
    client.set_api_creds(client.create_or_derive_api_creds())
    return client


def reconcile_state(state):
    """Replace the recorded open set with what the exchange actually holds.

    A posted GTC order is not a fill: without this step an unfilled order
    counts as deployed capital forever, phantom positions clog max_open,
    and resolved winners never release their slice of the bankroll cap.
    """
    funder = os.environ.get("PM_PROXY_ADDRESS")
    if not funder:
        return state
    pos = pmlib.get_json(f"{pmlib.DATA_API}/positions",
                         {"user": funder, "limit": 100,
                          "sortBy": "CURRENT", "sortDirection": "DESC"})
    if pos is None:
        return state  # API hiccup — keep the local view rather than zeroing it
    open_now = []
    for p in pos:
        if (p.get("size") or 0) <= 0 or p.get("redeemable"):
            continue
        open_now.append({
            "conditionId": p.get("conditionId"),
            "outcomeIndex": p.get("outcomeIndex"),
            "question": p.get("title"), "outcome": p.get("outcome"),
            "cost": round(p.get("initialValue") or 0, 2),
            "currentValue": round(p.get("currentValue") or 0, 2)})
    state["open"] = open_now
    state["totalDeployed"] = round(sum(o["cost"] for o in open_now), 2)
    journal({"action": "RECONCILE", "openPositions": len(open_now),
             "totalDeployed": state["totalDeployed"]})
    return state


def cmd_execute(args, cfg):
    if os.path.exists(STOP):
        raise SystemExit("STOP file present (data/live/STOP) — trading halted. "
                         "Delete it only if you mean it.")
    if not (args.live and args.i_accept_total_loss):
        raise SystemExit("execute requires BOTH --live and --i-accept-total-loss. "
                         "Run `plan` to see what it would do first.")
    from py_clob_client.clob_types import OrderArgs, OrderType
    from py_clob_client.order_builder.constants import BUY

    client = make_client()
    try:
        client.cancel_all()  # stale resting orders die before we re-plan
    except Exception as e:  # noqa: BLE001
        journal({"action": "CANCEL_ALL_ERROR", "error": str(e)})
    state = reconcile_state(load_json(
        POSITIONS, {"open": [], "dailySpend": [], "totalDeployed": 0.0}))
    save_json(POSITIONS, state)
    orders, state = plan_orders(cfg, state)
    if not orders:
        print("Nothing to do — no qualifying signals inside the rails.")
        return
    placed = 0
    for o in orders:
        try:
            oa = OrderArgs(price=o["limit"], size=o["shares"], side=BUY,
                           token_id=o["tokenId"])
            resp = client.post_order(client.create_order(oa), OrderType.GTC)
        except Exception as e:  # noqa: BLE001 — surface, journal, keep going
            journal({"action": "ERROR", "question": o["question"], "error": str(e)})
            print(f"FAILED {o['question'][:52]}: {e}")
            continue
        if isinstance(resp, dict):
            if not resp.get("success", True):
                journal({"action": "REJECTED", **o, "response": str(resp)[:400]})
                print(f"REJECTED {o['question'][:52]}: {resp.get('errorMsg')}")
                continue
            o["orderId"] = resp.get("orderID")
        journal({"action": "ORDER", **o, "response": str(resp)[:400]})
        # Count the order as deployed now (conservative); the next cycle's
        # reconcile trues this up against actual fills on the exchange.
        state["open"].append(o)
        state["dailySpend"].append({"t": int(time.time()), "usd": o["cost"]})
        state["totalDeployed"] = round(state["totalDeployed"] + o["cost"], 2)
        placed += 1
        print(f"PLACED {o['shares']:.0f} × {o['question'][:52]} @ ≤{o['limit']:.2f}")
    save_json(POSITIONS, state)
    print(f"\n{placed}/{len(orders)} orders placed · total deployed "
          f"${state['totalDeployed']:.2f} of ${cfg['bankroll_cap']:.2f} cap")


def cmd_status(args, cfg):
    funder = os.environ.get("PM_PROXY_ADDRESS")
    if not funder:
        raise SystemExit("set PM_PROXY_ADDRESS to check an account")
    val = pmlib.get_json(f"{pmlib.DATA_API}/value", {"user": funder}) or []
    pos = pmlib.get_json(f"{pmlib.DATA_API}/positions",
                         {"user": funder, "limit": 50, "sortBy": "CURRENT",
                          "sortDirection": "DESC"}) or []
    print(f"Portfolio value: ${val[0]['value']:.2f}" if val else "Portfolio value: ?")
    for p in pos:
        if (p.get("currentValue") or 0) > 0.5:
            tag = " [REDEEMABLE]" if p.get("redeemable") else ""
            print(f"  {p['title'][:56]} -> {p.get('outcome')}: "
                  f"${p['currentValue']:.2f} (pnl {p.get('cashPnl', 0):+.2f}){tag}")


def cmd_halt(args, cfg):
    os.makedirs(LIVE_DIR, exist_ok=True)
    with open(STOP, "w") as f:
        f.write("halted at " + time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()))
    journal({"action": "HALT"})
    print("STOP file created — all future execute runs refuse to trade.")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan").set_defaults(fn=cmd_plan)
    p = sub.add_parser("execute")
    p.add_argument("--live", action="store_true")
    p.add_argument("--i-accept-total-loss", action="store_true")
    p.set_defaults(fn=cmd_execute)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("halt").set_defaults(fn=cmd_halt)
    args = ap.parse_args()
    args.fn(args, load_config())


if __name__ == "__main__":
    main()
