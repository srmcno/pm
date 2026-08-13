#!/usr/bin/env python3
"""Live executor for the MEXC arb desk. USE AT YOUR OWN RISK — ships disarmed.

The paper desk assumes atomic fills; real triangles are three racing IOC
orders against bots that are faster than a REST scanner. Before arming,
read the latency-capture ratio on the arb page: it measures, from our own
recorded ticks, how much edge survives one scan of delay. If that number
is small, real money here is a donation to faster bots.

Arming checklist (nothing trades until ALL of these):
  1. Create a MEXC API key: SPOT TRADE permission ONLY — never withdrawal.
     IP allowlisting won't work from GitHub runners (dynamic IPs); that is
     a real tradeoff you accept by arming CI trading.
  2. Repo secrets: MEXC_API_KEY and MEXC_API_SECRET.
  3. The shift must run with --execute, and data/arb/STOP must not exist.

Hard rails (data/arb/live-config.json):
  bankroll_cap        max USDT ever deployed per day-window   (default $20)
  max_stake_per_cycle per-triangle ceiling                    (default $10)
  max_daily_stake     per-24h ceiling                         (default $40)
  min_edge_bps        verified edge required to fire          (default 10)
  A file at data/arb/STOP halts everything until you delete it.

Execution: each leg is an IMMEDIATE_OR_CANCEL limit at the walked price.
If leg 1 doesn't fill, nothing happened. If a later leg fails, the bot
UNWINDS immediately — it market-sells whatever it is holding back to USDT
via that asset's USDT pair and journals the round trip as a loss. Stranded
inventory is the real risk of live triangles; unwind-first is the rule.

  python3 arblive.py plan      # keyless dry summary of what would fire
  python3 arblive.py status    # signed: balances + today's spend
  python3 arblive.py halt      # create the STOP file
Execution itself only runs inside `arb.py watch --execute`.
"""
import hashlib
import hmac
import json
import os
import time
import urllib.parse

import pmlib

MEXC = "https://api.mexc.com"
LIVE_CFG = os.path.join(pmlib.BASE, "data", "arb", "live-config.json")
JOURNAL = os.path.join(pmlib.BASE, "data", "arb", "live-journal.jsonl")
STOP = os.path.join(pmlib.BASE, "data", "arb", "STOP")

DEFAULT_CFG = {
    "bankroll_cap": 20.0,
    "max_stake_per_cycle": 10.0,
    "max_daily_stake": 40.0,
    "min_edge_bps": 10.0,
}


def load_cfg():
    try:
        with open(LIVE_CFG) as f:
            cfg = {**DEFAULT_CFG, **json.load(f)}
    except (OSError, ValueError):
        cfg = dict(DEFAULT_CFG)
    os.makedirs(os.path.dirname(LIVE_CFG), exist_ok=True)
    with open(LIVE_CFG, "w") as f:
        json.dump(cfg, f, indent=1)
    return cfg


def journal(event):
    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    with open(JOURNAL, "a") as f:
        f.write(json.dumps({"t": int(time.time()), **event}) + "\n")


def keys():
    return os.environ.get("MEXC_API_KEY"), os.environ.get("MEXC_API_SECRET")


def signed(method, path, params):
    """Signed MEXC v3 request; returns parsed JSON or None."""
    key, secret = keys()
    if not (key and secret):
        return None
    params = {**params, "timestamp": int(time.time() * 1000),
              "recvWindow": 10_000}
    qs = urllib.parse.urlencode(params)
    sig = hmac.new(secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
    url = f"{MEXC}{path}?{qs}&signature={sig}"
    try:
        r = pmlib._session.request(method, url, timeout=10,
                                   headers={"X-MEXC-APIKEY": key})
        return r.json()
    except Exception as e:  # noqa: BLE001
        journal({"action": "HTTP_ERROR", "path": path, "error": str(e)})
        return None


def ioc_limit(symbol, side, price, qty=None, quote_qty=None):
    """Place an IOC limit; return (executedBase, spentQuote) from the fill."""
    p = {"symbol": symbol, "side": side, "type": "IMMEDIATE_OR_CANCEL",
         "price": f"{price:.10f}".rstrip("0").rstrip(".")}
    if qty is not None:
        p["quantity"] = f"{qty:.8f}".rstrip("0").rstrip(".")
    else:
        p["quoteOrderQty"] = f"{quote_qty:.4f}"
    resp = signed("POST", "/api/v3/order", p) or {}
    oid = resp.get("orderId")
    journal({"action": "ORDER", "symbol": symbol, "side": side,
             "price": price, "resp": str(resp)[:300]})
    if not oid:
        return 0.0, 0.0
    time.sleep(0.35)  # IOC settles immediately; give the query a beat
    o = signed("GET", "/api/v3/order", {"symbol": symbol, "orderId": oid}) or {}
    try:
        return float(o.get("executedQty") or 0), float(o.get("cummulativeQuoteQty") or 0)
    except (TypeError, ValueError):
        return 0.0, 0.0


def unwind(asset, qty, info):
    """Emergency exit: market-sell a stranded asset back to USDT."""
    sym = f"{asset}USDT"
    if sym not in info or qty <= 0:
        journal({"action": "UNWIND_IMPOSSIBLE", "asset": asset, "qty": qty})
        return
    bid = pmlib.book_price(sym, "bid") or 0
    if bid <= 0:
        journal({"action": "UNWIND_NO_BID", "asset": asset, "qty": qty})
        return
    got, quote = ioc_limit(sym, "SELL", bid * 0.98, qty=qty)
    journal({"action": "UNWIND", "asset": asset, "qty": qty,
             "recoveredUsd": quote, "filled": got})


def spent_today():
    day_ago = time.time() - 86400
    total = 0.0
    try:
        with open(JOURNAL) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("action") == "CYCLE" and e.get("t", 0) >= day_ago:
                    total += e.get("sizeUsd", 0)
    except OSError:
        pass
    return total


def execute_opps(opps, info):
    """Fire verified triangles under the rails. Called from arb.py --execute."""
    if os.path.exists(STOP):
        print("  live: STOP file present — not trading", flush=True)
        return 0
    key, secret = keys()
    if not (key and secret):
        return 0
    cfg = load_cfg()
    budget = min(cfg["max_daily_stake"], cfg["bankroll_cap"]) - spent_today()
    fired = 0
    for o in opps:
        if budget < 1.0:
            break
        if (o.get("verifiedBps") or 0) < cfg["min_edge_bps"]:
            continue
        size = min(o.get("sizeUsd") or 0, cfg["max_stake_per_cycle"], budget)
        if size < 1.0 or size < (o.get("sizeUsd") or 0):
            continue  # only fire at the exact depth-verified size
        legs = o["legs"]
        # Leg 1: USDT -> A
        s1, _ = legs[0]
        ask1 = pmlib.book_price(s1, "ask")
        if not ask1:
            continue
        got_a, spent1 = ioc_limit(s1, "BUY", ask1 * 1.001, quote_qty=size)
        if got_a <= 0:
            journal({"action": "CYCLE_ABORT", "path": o["path"], "leg": 1})
            continue  # nothing filled, nothing at risk
        # Leg 2: A -> bridge (direction depends on the cross pair's base)
        s2, act2 = legs[1]
        base2 = info[s2]["base"]
        if act2 == "sell":     # cross is A/bridge: sell A
            bid2 = pmlib.book_price(s2, "bid") or 0
            got_b, _ = (ioc_limit(s2, "SELL", bid2 * 0.999, qty=got_a)
                        if bid2 else (0.0, 0.0))
            got_b = got_b * bid2 if got_b else 0.0  # proceeds in bridge units
        else:                  # cross is bridge/A: buy bridge with A
            ask2 = pmlib.book_price(s2, "ask") or 0
            got_b, _ = (ioc_limit(s2, "BUY", ask2 * 1.001, quote_qty=got_a)
                        if ask2 else (0.0, 0.0))
        if got_b <= 0:
            unwind(info[legs[0][0]]["base"], got_a, info)
            journal({"action": "CYCLE_ABORT", "path": o["path"], "leg": 2})
            continue
        # Leg 3: bridge -> USDT
        s3, _ = legs[2]
        bid3 = pmlib.book_price(s3, "bid") or 0
        _, quote3 = (ioc_limit(s3, "SELL", bid3 * 0.999, qty=got_b)
                     if bid3 else (0.0, 0.0))
        if quote3 <= 0:
            unwind(base2 if act2 == "buy" else info[s3]["base"], got_b, info)
            journal({"action": "CYCLE_ABORT", "path": o["path"], "leg": 3})
            continue
        pnl = round(quote3 - spent1, 4)
        budget -= size
        fired += 1
        journal({"action": "CYCLE", "path": o["path"], "sizeUsd": size,
                 "spentUsd": spent1, "gotUsd": quote3, "pnlUsd": pnl})
        print(f"  LIVE CYCLE {o['path']} ${spent1:.2f} -> ${quote3:.2f} "
              f"({pnl:+.4f})", flush=True)
    return fired


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan")
    sub.add_parser("status")
    sub.add_parser("halt")
    args = ap.parse_args()
    cfg = load_cfg()
    if args.cmd == "halt":
        with open(STOP, "w") as f:
            f.write(time.strftime("halted %Y-%m-%d %H:%M UTC", time.gmtime()))
        journal({"action": "HALT"})
        print("STOP file created — live arb trading refuses to run.")
        return
    if args.cmd == "status":
        acct = signed("GET", "/api/v3/account", {})
        if not acct:
            raise SystemExit("no MEXC_API_KEY / MEXC_API_SECRET in env")
        for b in acct.get("balances", []):
            free = float(b.get("free") or 0)
            if free > 0.01:
                print(f"  {b['asset']}: {free}")
        print(f"Spent in last 24h: ${spent_today():.2f} of "
              f"${cfg['max_daily_stake']:.2f} cap")
        return
    # plan: keyless summary
    try:
        with open(os.path.join(pmlib.BASE, "dashboard", "data", "arb.json")) as f:
            payload = json.load(f)
    except (OSError, ValueError):
        raise SystemExit("no arb scan data yet")
    opps = [o for o in payload.get("opportunities", [])
            if (o.get("verifiedBps") or 0) >= cfg["min_edge_bps"]]
    print(f"{len(opps)} verified edges clear the {cfg['min_edge_bps']} bps "
          f"live floor right now (paper floor is lower on purpose).")
    for o in opps:
        print(f"  WOULD FIRE {o['path']} ${o['sizeUsd']} at "
              f"{o['verifiedBps']} bps")
    if not (os.environ.get("MEXC_API_KEY") and os.environ.get("MEXC_API_SECRET")):
        print("Disarmed: no MEXC keys in env. See the arming checklist in "
              "this file's docstring.")


if __name__ == "__main__":
    main()
