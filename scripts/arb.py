#!/usr/bin/env python3
"""Micro-cap arbitrage desk for MEXC spot — scanner + paper bot.

Every ~25 seconds, across all ~2,100 MEXC spot pairs:

  1. Triangular arbitrage. Three-leg cycles (USDT -> A -> bridge -> USDT,
     bridges: USDC / USD1 / BTC / ETH) priced by CROSSING the book — bids
     and asks, never mids — net of each symbol's real taker fee. Survivors
     are re-verified by walking fresh order-book depth to find the largest
     size that keeps the edge positive. This is where micro-caps differ
     from majors: thin, lazy books misprice the same asset across routes.
  2. Microstructure tells on the legs involved: book imbalance, spread,
     taker aggression, print sizes — signals that never appear on a chart.
  3. Cross-venue gaps vs Gate.io on overlapping USDT pairs. Display-only:
     capturing one needs funded accounts on both venues plus a transfer,
     so it is intel, not a trade.

A virtual $100 paper account "executes" each verified triangle at the
depth-walked prices minus fees. Honesty: the simulation fills all three
legs atomically at snapshot depth; real legs race the book and other
bots, so the paper record is an UPPER BOUND on this exact strategy. Edge
persistence is measured every scan (how many edges survive to the next
scan) so the decay is data, not vibes.

  python3 arb.py scan                            # one scan, print + publish
  python3 arb.py watch --duration-minutes 113    # loop for a CI shift

State: data/arb/state.json · site payload: dashboard/data/arb.json
"""
import argparse
import json
import os
import time
from collections import defaultdict

import pmlib

MEXC = "https://api.mexc.com/api/v3"
GATE_TICKERS = "https://api.gateio.ws/api/v4/spot/tickers"
ARB_DIR = os.path.join(pmlib.BASE, "data", "arb")
STATE = os.path.join(ARB_DIR, "state.json")
DASH = os.path.join(pmlib.BASE, "dashboard", "data", "arb.json")
REPORT = os.path.join(pmlib.BASE, "reports", "arb-latest.md")

BRIDGES = ("USDC", "USD1", "BTC", "ETH")
GATE_TAKER = 0.002          # Gate.io spot default taker
SIZES = (5.0, 20.0, 50.0)   # candidate start sizes in USDT (paper caps at 50)


# ---------------------------------------------------------------- universe

def exchange_info():
    """MEXC symbol map, cached six hours — fees and listings move slowly."""
    os.makedirs(pmlib.CACHE_DIR, exist_ok=True)
    path = os.path.join(pmlib.CACHE_DIR, "mexc_info.json")
    try:
        st = os.stat(path)
        if time.time() - st.st_mtime < 6 * 3600:
            with open(path) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    raw = pmlib.get_json(f"{MEXC}/exchangeInfo") or {}
    out = {}
    for s in raw.get("symbols", []):
        if s.get("status") != "1" or not s.get("isSpotTradingAllowed"):
            continue
        out[s["symbol"]] = {
            "base": s["baseAsset"], "quote": s["quoteAsset"],
            "taker": float(s.get("takerCommission") or 0.0005),
        }
    if out:
        with open(path, "w") as f:
            json.dump(out, f)
    return out


def book_tickers():
    """All best bid/asks in one call: {symbol: (bid, bidQty, ask, askQty)}."""
    rows = pmlib.get_json(f"{MEXC}/ticker/bookTicker") or []
    out = {}
    for r in rows:
        try:
            bid, ask = float(r["bidPrice"]), float(r["askPrice"])
            if bid > 0 and ask > 0:
                out[r["symbol"]] = (bid, float(r["bidQty"]), ask, float(r["askQty"]))
        except (KeyError, TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------- triangles

def build_triangles(info):
    """All USDT -> A -> bridge -> USDT cycles the listed pairs allow.

    A leg is (symbol, action): action 'buy' crosses the ask (quote -> base),
    'sell' crosses the bid (base -> quote).
    """
    pair = {}
    for sym, s in info.items():
        pair[(s["base"], s["quote"])] = sym
    tris = []
    for sym, s in info.items():
        if s["quote"] != "USDT" or s["base"] in BRIDGES:
            continue
        a = s["base"]
        for b in BRIDGES:
            leg3 = pair.get((b, "USDT"))
            if not leg3:
                continue
            if (a, b) in pair:      # sell A into B
                tris.append(((sym, "buy"), (pair[(a, b)], "sell"), (leg3, "sell"), a, b))
            elif (b, a) in pair:    # buy B with A
                tris.append(((sym, "buy"), (pair[(b, a)], "buy"), (leg3, "sell"), a, b))
    return tris


def leg_rate(book, info, sym, action):
    """Top-of-book conversion rate for one leg, net of that symbol's fee."""
    q = book.get(sym)
    if not q:
        return None
    bid, _, ask, _ = q
    fee = info[sym]["taker"]
    return bid * (1 - fee) if action == "sell" else (1 / ask) * (1 - fee)


def screen_triangles(tris, book, info, min_bps=1.0):
    """Multiply the three crossed-book rates; keep cycles that net > min_bps."""
    out = []
    for legs in tris:
        (s1, a1), (s2, a2), (s3, a3), a, b = legs
        m = 1.0
        for sym, act in ((s1, a1), (s2, a2), (s3, a3)):
            r = leg_rate(book, info, sym, act)
            if r is None:
                m = 0
                break
            m *= r
        if m > 1 + min_bps / 10_000:
            out.append({"legs": [[s1, a1], [s2, a2], [s3, a3]],
                        "path": f"USDT→{a}→{b}→USDT",
                        "screenBps": round((m - 1) * 10_000, 1)})
    out.sort(key=lambda o: -o["screenBps"])
    return out


# ---------------------------------------------------------------- depth math

def depth(sym, limit=20):
    d = pmlib.get_json(f"{MEXC}/depth", {"symbol": sym, "limit": limit}) or {}
    try:
        return ([(float(p), float(q)) for p, q in d.get("bids", [])],
                [(float(p), float(q)) for p, q in d.get("asks", [])])
    except (TypeError, ValueError):
        return [], []


def walk_buy(asks, quote_amt, fee):
    """Spend quote_amt crossing the asks; return base received (after fee)."""
    got = 0.0
    left = quote_amt
    for px, qty in asks:
        take = min(left / px, qty)
        got += take
        left -= take * px
        if left <= 1e-12:
            return got * (1 - fee)
    return None  # book too thin for this size


def walk_sell(bids, base_amt, fee):
    """Sell base_amt crossing the bids; return quote received (after fee)."""
    got = 0.0
    left = base_amt
    for px, qty in bids:
        take = min(left, qty)
        got += take * px
        left -= take
        if left <= 1e-12:
            return got * (1 - fee)
    return None


def verify_triangle(opp, info, books_cache):
    """Re-price the cycle by walking fresh depth; find the best viable size."""
    legs = opp["legs"]
    for sym, _ in legs:
        if sym not in books_cache:
            books_cache[sym] = depth(sym)
    best = None
    for size in SIZES:
        amt = size
        ok = True
        for sym, act in legs:
            bids, asks = books_cache[sym]
            fee = info[sym]["taker"]
            amt = (walk_buy(asks, amt, fee) if act == "buy"
                   else walk_sell(bids, amt, fee))
            if amt is None:
                ok = False
                break
        if not ok:
            break  # thinner books won't fit bigger sizes either
        profit = amt - size
        bps = profit / size * 10_000
        if profit > 0.005 and (best is None or profit > best["profitUsd"]):
            best = {"sizeUsd": size, "profitUsd": round(profit, 4),
                    "verifiedBps": round(bps, 1)}
    if best:
        opp.update(best)
    return best is not None


# ---------------------------------------------------------------- micro/gaps

def microstructure(sym, info, books_cache):
    """Book + tape tells for one symbol — the stuff candles cannot show."""
    bids, asks = books_cache.get(sym) or depth(sym)
    books_cache[sym] = (bids, asks)
    out = {"symbol": sym}
    if bids and asks:
        mid = (bids[0][0] + asks[0][0]) / 2
        out["spreadBps"] = round((asks[0][0] - bids[0][0]) / mid * 10_000, 1)
        band = 0.01
        bn = sum(p * q for p, q in bids if p >= mid * (1 - band))
        an = sum(p * q for p, q in asks if p <= mid * (1 + band))
        out["bidShare"] = round(bn / (bn + an), 3) if bn + an else None
        out["depthUsd1pct"] = round(bn + an, 0)
    trades = pmlib.get_json(f"{MEXC}/trades", {"symbol": sym, "limit": 100}) or []
    if trades:
        taker_buys = sum(1 for t in trades if t.get("isBuyerMaker") is False)
        out["takerBuyShare"] = round(taker_buys / len(trades), 3)
        notionals = sorted(float(t.get("quoteQty") or 0) for t in trades)
        out["maxPrintUsd"] = round(notionals[-1], 0)
        span = (trades[0].get("time", 0) - trades[-1].get("time", 0)) / 1000
        out["printsPerMin"] = round(len(trades) / max(span / 60, 0.1), 1)
    return out


_vol_cache = {"at": 0.0, "vols": {}}


def mexc_volumes():
    """24h quote volume per symbol, refreshed every ten minutes."""
    if time.time() - _vol_cache["at"] > 600:
        rows = pmlib.get_json(f"{MEXC}/ticker/24hr") or []
        vols = {}
        for r in rows:
            try:
                vols[r["symbol"]] = float(r.get("quoteVolume") or 0)
            except (KeyError, TypeError, ValueError):
                continue
        if vols:
            _vol_cache.update({"at": time.time(), "vols": vols})
    return _vol_cache["vols"]


def cross_venue_gaps(book, info, min_bps=30.0, max_bps=800.0, min_vol=20_000):
    """MEXC vs Gate.io on shared USDT pairs, net of both taker fees.

    Micro-cap trap this must survive: the same ticker is often a DIFFERENT
    token on each venue. A price ratio far from 1 or an implausibly huge
    "edge" means a name collision or a dead book, not free money — those
    are dropped, and both venues must show real 24h volume. Real capture
    still needs funded accounts on both sides (or a transfer whose fee and
    delay eat the gap) — published as intel, never paper-traded.
    """
    rows = pmlib.get_json(GATE_TICKERS) or []
    vols = mexc_volumes()
    gate = {}
    for r in rows:
        cp = r.get("currency_pair", "")
        if not cp.endswith("_USDT"):
            continue
        try:
            bid, ask = float(r.get("highest_bid") or 0), float(r.get("lowest_ask") or 0)
            vol = float(r.get("quote_volume") or 0)
        except (TypeError, ValueError):
            continue
        if bid > 0 and ask > 0 and vol >= min_vol:
            gate[cp[:-5] + "USDT"] = (bid, ask, vol)
    gaps = []
    for sym, (gbid, gask, gvol) in gate.items():
        q = book.get(sym)
        if not q or info.get(sym) is None or vols.get(sym, 0) < min_vol:
            continue
        mbid, _, mask, _ = q
        ratio = ((gbid + gask) / 2) / ((mbid + mask) / 2)
        if not 0.5 < ratio < 2.0:
            continue  # near-certainly two different tokens sharing a ticker
        mfee = info[sym]["taker"]
        # buy on MEXC at ask, sell on Gate at bid (and the reverse)
        for direction, edge in (
                ("MEXC→Gate", (gbid / mask) * (1 - mfee) * (1 - GATE_TAKER) - 1),
                ("Gate→MEXC", (mbid / gask) * (1 - mfee) * (1 - GATE_TAKER) - 1)):
            bps = edge * 10_000
            if min_bps <= bps <= max_bps:
                gaps.append({"symbol": sym, "direction": direction,
                             "netBps": round(bps, 1),
                             "gateVol24hUsd": round(gvol, 0),
                             "mexcVol24hUsd": round(vols.get(sym, 0), 0)})
    gaps.sort(key=lambda g: -g["netBps"])
    return gaps[:12]


# ---------------------------------------------------------------- paper bot

def load_state():
    st = None
    try:
        with open(STATE) as f:
            st = json.load(f)
    except (OSError, ValueError):
        pass
    if not st:
        st = {"bankrollStart": 100.0, "cash": 100.0, "createdAt": int(time.time()),
              "trades": [], "equityCurve": [], "decay": {"checked": 0, "survived": 0},
              "cooldown": {}}
    return st


def save_state(st):
    os.makedirs(ARB_DIR, exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f, indent=1)


def paper_execute(st, opps, now):
    """Round-trip each verified cycle once per cooldown window."""
    done = 0
    for o in opps:
        if done >= 3:
            break
        key = o["path"] + "|" + "|".join(s for s, _ in map(tuple, o["legs"]))
        if now - st["cooldown"].get(key, 0) < 120:
            continue
        size = min(o["sizeUsd"], st["cash"] * 0.5, 50.0)
        if size < o["sizeUsd"]:      # depth was walked at sizeUsd; stay honest
            continue                 # and skip rather than assume linear fills
        st["cooldown"][key] = now
        st["cash"] = round(st["cash"] + o["profitUsd"], 4)
        st["trades"].append({"t": now, "path": o["path"], "sizeUsd": o["sizeUsd"],
                             "profitUsd": o["profitUsd"], "bps": o["verifiedBps"]})
        done += 1
    st["cooldown"] = {k: v for k, v in st["cooldown"].items() if now - v < 3600}
    st["equityCurve"].append({"t": now, "equity": st["cash"]})
    st["equityCurve"] = st["equityCurve"][-500:]
    st["trades"] = st["trades"][-200:]
    return done


# ---------------------------------------------------------------- publishing

def publish(st, meta, opps, watching, micro, gaps, now):
    payload = {
        "updatedAt": now, "meta": meta,
        "opportunities": opps, "watching": watching,
        "micro": micro, "gaps": gaps,
        "paper": {"bankrollStart": st["bankrollStart"], "equity": st["cash"],
                  "trades": st["trades"][-25:][::-1],
                  "tradeCount": len(st["trades"]),
                  "equityCurve": st["equityCurve"][-300:]},
        "decay": st["decay"],
        "notes": ("Paper only — no keys, no orders. Triangles are filled "
                  "atomically at snapshot depth net of real taker fees; live "
                  "legs race the book, so treat results as an upper bound. "
                  "Cross-venue gaps need funded accounts on both exchanges."),
    }
    os.makedirs(os.path.dirname(DASH), exist_ok=True)
    with open(DASH, "w") as f:
        json.dump(payload, f)
    lines = ["# Arb desk — latest scan", "",
             time.strftime("Scanned %Y-%m-%d %H:%M UTC", time.gmtime(now)) +
             f" · {meta['pairs']} pairs · {meta['triangles']} cycles · "
             f"{len(opps)} verified edges",
             "", "| cycle | screen bps | verified bps | size | profit |",
             "|---|---|---|---|---|"]
    for o in opps:
        lines.append(f"| {o['path']} | {o['screenBps']} | {o.get('verifiedBps','—')} "
                     f"| ${o.get('sizeUsd','—')} | ${o.get('profitUsd','—')} |")
    with open(REPORT, "w") as f:
        f.write("\n".join(lines) + "\n")


def scan_once(st, prev_keys):
    now = int(time.time())
    info = exchange_info()
    book = book_tickers()
    tris = build_triangles(info)
    # A wide screen (anything above -15 bps) keeps a "watching" list of
    # near-misses so the page shows the engine breathing between real edges.
    screened = screen_triangles(tris, book, info, min_bps=-15.0)
    live = [o for o in screened if o["screenBps"] >= 1.0]
    books_cache = {}
    verified = []
    for o in live[:12]:
        if verify_triangle(o, info, books_cache):
            verified.append(o)
    watching = [o for o in screened if o not in verified][:8]
    # edge persistence: how many of last scan's edges survived to this one
    cur_keys = {o["path"] for o in verified}
    if prev_keys is not None:
        st["decay"]["checked"] += len(prev_keys)
        st["decay"]["survived"] += len(prev_keys & cur_keys)
    executed = paper_execute(st, verified, now)
    micro_syms = [o["legs"][0][0] for o in verified]
    micro_syms += [o["legs"][0][0] for o in watching[:4]]
    gaps = cross_venue_gaps(book, info)
    micro_syms += [g["symbol"] for g in gaps[:3]]
    seen, micro = set(), []
    for sym in micro_syms:
        if sym in seen or len(micro) >= 8:
            continue
        seen.add(sym)
        micro.append(microstructure(sym, info, books_cache))
    meta = {"pairs": len(book), "triangles": len(tris),
            "screened": len(live), "verified": len(verified)}
    publish(st, meta, verified, watching, micro, gaps, now)
    save_state(st)
    print(f"{time.strftime('%H:%M:%S')} pairs {len(book)} · cycles {len(tris)} "
          f"· live {len(live)} · verified {len(verified)} · "
          f"executed {executed} · equity ${st['cash']:.2f}", flush=True)
    return cur_keys, executed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    w = sub.add_parser("watch")
    w.add_argument("--duration-minutes", type=float, default=113)
    w.add_argument("--scan-seconds", type=int, default=25)
    w.add_argument("--publish-minutes", type=float, default=10,
                   help="commit+deploy at least this often")
    args = ap.parse_args()

    st = load_state()
    if args.cmd == "scan":
        scan_once(st, None)
        return
    deadline = time.time() + args.duration_minutes * 60
    prev, last_pub = None, 0.0
    while time.time() < deadline:
        t0 = time.time()
        try:
            prev, executed = scan_once(st, prev)
        except Exception as e:  # noqa: BLE001 — a bad scan must not kill the shift
            print(f"scan error: {e}", flush=True)
            executed = 0
        if executed or time.time() - last_pub > args.publish_minutes * 60:
            if pmlib.publish_repo(["data/arb", "dashboard/data", "reports"],
                                  "auto: arb desk scan"):
                last_pub = time.time()
        time.sleep(max(1.0, args.scan_seconds - (time.time() - t0)))
    print("Shift over — exiting cleanly.", flush=True)


if __name__ == "__main__":
    main()
