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
from concurrent.futures import ThreadPoolExecutor

import pmlib

MEXC = "https://api.mexc.com/api/v3"
GATE_TICKERS = "https://api.gateio.ws/api/v4/spot/tickers"
ARB_DIR = os.path.join(pmlib.BASE, "data", "arb")
STATE = os.path.join(ARB_DIR, "state.json")
DASH = os.path.join(pmlib.BASE, "dashboard", "data", "arb.json")
REPORT = os.path.join(pmlib.BASE, "reports", "arb-latest.md")

BRIDGES = ("USDC", "USD1", "BTC", "ETH", "USDE", "EUR")
GATE_TAKER = 0.002          # Gate.io spot default taker
SIZES = (5.0, 10.0, 20.0)   # candidate start sizes in USDT
HIST_DIR = os.path.join(ARB_DIR, "history")
HIST_KEEP_DAYS = 7


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
    """All 3-cycles through USDT the listed pairs allow, in BOTH directions.

    A leg is (symbol, action): action 'buy' crosses the ask (quote -> base),
    'sell' crosses the bid (base -> quote). Crossing the book makes at most
    one direction of a cycle profitable at a time, so the mirror
    (USDT -> bridge -> A -> USDT) must be enumerated too — without it,
    half of all capturable edges are structurally invisible.
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
            if (a, b) in pair:      # cross pair is A/B
                cross = pair[(a, b)]
                tris.append(((sym, "buy"), (cross, "sell"), (leg3, "sell"), a, b))
                tris.append(((leg3, "buy"), (cross, "buy"), (sym, "sell"), b, a))
            elif (b, a) in pair:    # cross pair is B/A
                cross = pair[(b, a)]
                tris.append(((sym, "buy"), (cross, "buy"), (leg3, "sell"), a, b))
                tris.append(((leg3, "buy"), (cross, "sell"), (sym, "sell"), b, a))
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
    viable = {}
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
        if profit > 0.005:
            viable[size] = round(profit, 4)
            if best is None or profit > best["profitUsd"]:
                best = {"sizeUsd": size, "profitUsd": round(profit, 4),
                        "verifiedBps": round(bps, 1)}
    if best:
        best["viable"] = viable
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
        # Same virtual stake as the Polymarket paper bot, for a fair race.
        st = {"bankrollStart": 20.0, "cash": 20.0, "createdAt": int(time.time()),
              "trades": [], "equityCurve": [], "decay": {"checked": 0, "survived": 0},
              "cooldown": {}}
    st.setdefault("tradeCountAll", len(st.get("trades") or []))
    return st


def save_state(st):
    os.makedirs(ARB_DIR, exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f, indent=1)


def paper_execute(st, opps, now):
    """Round-trip verified cycles at the largest depth-verified size that
    fits the bankroll. A persisting edge is re-struck every 60 s — each
    strike is re-verified against freshly fetched depth, which is exactly
    how a live bot keeps taking an edge until the book drains."""
    done = 0
    for o in opps:
        if done >= 3:
            break
        key = o["path"] + "|" + "|".join(s for s, _ in map(tuple, o["legs"]))
        if now - st["cooldown"].get(key, 0) < 30:
            continue
        cap = st["cash"] * 0.75
        picks = [(s, p) for s, p in (o.get("viable") or {}).items() if s <= cap]
        if not picks:
            continue  # nothing depth-verified fits — never assume linear fills
        size, profit = max(picks, key=lambda x: x[1])
        st["cooldown"][key] = now
        st["cash"] = round(st["cash"] + profit, 4)
        st["trades"].append({"t": now, "path": o["path"], "sizeUsd": size,
                             "profitUsd": profit,
                             "bps": round(profit / size * 10_000, 1)})
        st["tradeCountAll"] = st.get("tradeCountAll", 0) + 1
        done += 1
    st["cooldown"] = {k: v for k, v in st["cooldown"].items() if now - v < 3600}
    st["equityCurve"].append({"t": now, "equity": st["cash"]})
    st["equityCurve"] = st["equityCurve"][-500:]
    st["trades"] = st["trades"][-200:]
    return done


# ------------------------------------------------------------- tick history

_prev_leg_syms = set()


def record_history(now, verified, watching, book):
    """Append this scan's edges and the leg quotes to a daily JSONL file.

    Public APIs archive candles, not books — and triangle edges live in the
    book. So the desk records its own tick history and earns a backtest the
    honest way: by accumulating one. Files rotate daily, kept ~a week.
    The previous scan's verified legs are always included in `tops`, so the
    replay can price a dead edge's next-scan fill instead of losing it.
    """
    global _prev_leg_syms
    os.makedirs(HIST_DIR, exist_ok=True)
    syms = set(_prev_leg_syms)
    for o in verified + watching:
        for sym, _ in o["legs"]:
            syms.add(sym)
    _prev_leg_syms = {sym for o in verified for sym, _ in o["legs"]}
    line = {
        "t": now,
        "verified": [{k: o[k] for k in
                      ("path", "legs", "screenBps", "verifiedBps", "sizeUsd",
                       "profitUsd") if k in o} for o in verified],
        "watch": [{"path": o["path"], "legs": o["legs"],
                   "screenBps": o["screenBps"]} for o in watching[:5]],
        "tops": {s: [book[s][0], book[s][2]] for s in syms if s in book},
    }
    day = time.strftime("%Y%m%d", time.gmtime(now))
    with open(os.path.join(HIST_DIR, f"{day}.jsonl"), "a") as f:
        f.write(json.dumps(line) + "\n")


def prune_history():
    try:
        names = sorted(os.listdir(HIST_DIR))
    except OSError:
        return
    for n in names[:-HIST_KEEP_DAYS]:
        try:
            os.remove(os.path.join(HIST_DIR, n))
        except OSError:
            pass


def replay_backtest(info):
    """Replay recorded history with one scan of latency.

    The paper ledger assumes the bot fires the instant it verifies an edge.
    This replay asks the harder question: had it acted one scan (~25 s)
    later, at the NEXT scan's recorded top-of-book, what survives? The gap
    between atomic and delayed PnL is the measured cost of latency — the
    same lesson the Polymarket backtest taught, earned from our own ticks.
    Top-of-book only (depth is not recorded), so the delayed figure is
    itself optimistic at size; the CAPTURE RATIO is the honest headline.
    """
    lines = []
    try:
        for name in sorted(os.listdir(HIST_DIR)):
            with open(os.path.join(HIST_DIR, name)) as f:
                for row in f:
                    try:
                        lines.append(json.loads(row))
                    except ValueError:
                        continue
    except OSError:
        pass
    if len(lines) < 2:
        return None
    atomic = delayed = 0.0
    edges = filled = 0
    for cur, nxt in zip(lines, lines[1:]):
        if not (0 < nxt["t"] - cur["t"] <= 180):
            continue  # shift boundary or gap — not a fair next-scan fill
        for o in cur.get("verified", []):
            if "profitUsd" not in o:
                continue
            edges += 1
            atomic += o["profitUsd"]
            amt = o.get("sizeUsd", 0)
            start = amt
            ok = True
            for sym, act in o["legs"]:
                top = nxt.get("tops", {}).get(sym)
                fee = (info.get(sym) or {}).get("taker", 0.0005)
                if not top:
                    ok = False
                    break
                bid, ask = top
                if act == "buy":
                    if ask <= 0:
                        ok = False
                        break
                    amt = amt / ask * (1 - fee)
                else:
                    amt = amt * bid * (1 - fee)
            if ok:
                filled += 1
                delayed += amt - start
    if not edges:
        return None
    return {"edges": edges, "refillable": filled,
            "atomicUsd": round(atomic, 4), "delayedUsd": round(delayed, 4),
            "captureRatio": round(delayed / atomic, 3) if atomic > 0 else None,
            "scansReplayed": len(lines)}


# ---------------------------------------------------------------- publishing

def publish(st, meta, opps, watching, micro, gaps, now):
    payload = {
        "updatedAt": now, "meta": meta,
        "opportunities": opps, "watching": watching,
        "micro": micro, "gaps": gaps,
        "paper": {"bankrollStart": st["bankrollStart"], "equity": st["cash"],
                  "trades": st["trades"][-25:][::-1],
                  "tradeCount": st.get("tradeCountAll", len(st["trades"])),
                  "equityCurve": st["equityCurve"][-300:]},
        "decay": st["decay"],
        "replay": st.get("replay"),
        "notes": ("Paper only — no keys, no orders. Triangles are filled "
                  "atomically at snapshot depth net of real taker fees; live "
                  "legs race the book, so treat results as an upper bound — "
                  "the latency replay measures how much survives one scan of "
                  "delay on the desk's own recorded ticks. Cross-venue gaps "
                  "need funded accounts on both exchanges."),
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
    r = st.get("replay")
    if r:
        lines += ["", "## Latency replay (own recorded ticks)", "",
                  f"- Edges replayed: {r['edges']} across {r['scansReplayed']} scans",
                  f"- Atomic PnL ${r['atomicUsd']} → one-scan-delay PnL "
                  f"${r['delayedUsd']} (capture ratio "
                  f"{r['captureRatio'] if r['captureRatio'] is not None else '—'})"]
    with open(REPORT, "w") as f:
        f.write("\n".join(lines) + "\n")


# Slow-lane cache: at 2s scan cadence the fast path is one bulk call plus
# CPU; Gate, 24h volumes, and the tape-heavy microstructure board refresh
# on their own timer so they never sit between an edge and its execution.
_slow = {"at": 0.0, "gaps": [], "micro": []}
_last_hist = 0.0
_scan_n = 0


def scan_once(st, prev_keys, execute=False):
    global _last_hist, _scan_n
    now = int(time.time())
    info = exchange_info()
    book = book_tickers()
    if len(info) < 500 or len(book) < 500:
        # A transient outage must not masquerade as a real empty universe:
        # publishing it would show a zero-pair scan on the site and record
        # every previous edge as decayed. Skip the cycle instead.
        raise RuntimeError(f"incomplete snapshot (info {len(info)}, book {len(book)})")
    tris = build_triangles(info)
    # A wide screen (anything above -15 bps) keeps a "watching" list of
    # near-misses so the page shows the engine breathing between real edges.
    screened = screen_triangles(tris, book, info, min_bps=-15.0)
    live = [o for o in screened if o["screenBps"] >= 1.0]
    books_cache = {}
    if live:
        # Depth for every candidate leg in parallel — the verify path is
        # the race, and sequential fetches were most of its latency.
        syms = list({sym for o in live[:12] for sym, _ in o["legs"]})
        with ThreadPoolExecutor(max_workers=6) as ex:
            for sym, d in zip(syms, ex.map(depth, syms)):
                books_cache[sym] = d
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
    fired = 0
    if execute and verified:
        import arblive
        fired = arblive.execute_opps(verified, info)
    if time.time() - _slow["at"] > 60:
        _slow["at"] = time.time()
        _slow["gaps"] = cross_venue_gaps(book, info)
        micro_syms = [o["legs"][0][0] for o in verified]
        micro_syms += [o["legs"][0][0] for o in watching[:4]]
        micro_syms += [g["symbol"] for g in _slow["gaps"][:3]]
        seen, micro = set(), []
        for sym in micro_syms:
            if sym in seen or len(micro) >= 8:
                continue
            seen.add(sym)
            micro.append(microstructure(sym, info, books_cache))
        _slow["micro"] = micro
    if verified or time.time() - _last_hist >= 15:
        _last_hist = time.time()
        record_history(now, verified, watching, book)
    meta = {"pairs": len(book), "triangles": len(tris),
            "screened": len(live), "verified": len(verified)}
    publish(st, meta, verified, watching, _slow["micro"], _slow["gaps"], now)
    save_state(st)
    _scan_n += 1
    if verified or executed or fired or _scan_n % 30 == 1:
        print(f"{time.strftime('%H:%M:%S')} pairs {len(book)} · cycles {len(tris)} "
              f"· live {len(live)} · verified {len(verified)} · paper {executed} "
              f"· live-fired {fired} · equity ${st['cash']:.2f}", flush=True)
    return cur_keys, executed or fired


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    sub.add_parser("backtest")
    w = sub.add_parser("watch")
    w.add_argument("--duration-minutes", type=float, default=113)
    w.add_argument("--scan-seconds", type=float, default=2,
                   help="full-universe screen cadence; the fast lane is one "
                        "bulk call plus CPU, so 2s is sustainable")
    w.add_argument("--publish-minutes", type=float, default=10,
                   help="commit+deploy at least this often")
    w.add_argument("--execute", action="store_true",
                   help="fire REAL MEXC orders on verified edges (needs "
                        "MEXC_API_KEY/SECRET; see arblive.py's checklist)")
    args = ap.parse_args()

    st = load_state()
    if args.cmd == "scan":
        scan_once(st, None)
        return
    if args.cmd == "backtest":
        r = replay_backtest(exchange_info())
        if not r:
            print("Not enough recorded history yet — run some watch shifts first.")
            return
        st["replay"] = r
        save_state(st)
        print(f"Replayed {r['edges']} edges over {r['scansReplayed']} scans: "
              f"atomic ${r['atomicUsd']} -> delayed ${r['delayedUsd']} "
              f"(capture {r['captureRatio']})")
        return
    prune_history()
    deadline = time.time() + args.duration_minutes * 60
    # Never START a scan near the deadline of a real shift: a degraded-
    # network scan can run long past it and blow the workflow timeout
    # before the final commit step, losing unpushed paper state.
    head_start = 240 if args.duration_minutes > 10 else 0
    prev, last_pub, last_replay = None, 0.0, 0.0
    while time.time() < deadline - head_start:
        t0 = time.time()
        if time.time() - last_replay > 1800:
            last_replay = time.time()
            try:
                st["replay"] = replay_backtest(exchange_info()) or st.get("replay")
            except Exception as e:  # noqa: BLE001
                print(f"replay error: {e}", flush=True)
        try:
            prev, executed = scan_once(st, prev, execute=args.execute)
        except Exception as e:  # noqa: BLE001 — a bad scan must not kill the shift
            print(f"scan error: {e}", flush=True)
            executed = 0
        # Publish on activity but never more than ~per-90s; heartbeat at
        # publish-minutes regardless, so the site pill stays honest.
        since = time.time() - last_pub
        if (executed and since > 90) or since > args.publish_minutes * 60:
            if pmlib.publish_repo(["data/arb", "dashboard/data", "reports"],
                                  "auto: arb desk scan"):
                last_pub = time.time()
        time.sleep(max(0.2, args.scan_seconds - (time.time() - t0)))
    print("Shift over — exiting cleanly.", flush=True)


if __name__ == "__main__":
    main()
