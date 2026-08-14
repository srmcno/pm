#!/usr/bin/env python3
"""Kraken viability trial for the triangle scanner. Paper only, by design.

The MEXC arb desk works because taker fees there are near zero and the
micro-cap books are lazy. Kraken is the closest US-legal analog, but its
base-tier taker fee applies to every leg of a three-leg cycle, so the
round-trip hurdle is roughly three times the per-pair fee — on the order
of a hundred basis points. This module points the same scanner at Kraken
to answer one question with data instead of opinion: does any triangular
edge on a US venue survive that hurdle at retail fee tiers?

Same honesty rules as the MEXC desk:
  - Cycles are priced by CROSSING the book (bids and asks, never mids),
    net of each pair's actual base-tier taker fee from the exchange's own
    fee schedule.
  - Survivors are re-verified by walking fresh order-book depth, with
    Kraken's per-pair minimum order volume and minimum cost enforced on
    every leg — a $5 leg that the venue would reject is not an edge.
  - A virtual $40 paper account (the intended live test stake) executes
    verified cycles at walked-depth prices. Atomic fills are assumed, so
    the record is an upper bound; recorded tick history feeds the same
    one-scan-delay replay the MEXC desk uses.

There is deliberately NO live execution path in this module. If the trial
shows an edge, that conversation happens with data on the table.

  python3 krakenarb.py scan                          # one scan, print + publish
  python3 krakenarb.py watch --duration-minutes 113  # loop for a CI shift
  python3 krakenarb.py backtest                      # one-scan-delay replay

State: data/krakenarb/state.json · payload: dashboard/data/krakenarb.json
"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from itertools import pairwise

import pmlib
from arb import walk_buy, walk_sell

KRAKEN = "https://api.kraken.com/0/public"
K_DIR = os.path.join(pmlib.BASE, "data", "krakenarb")
STATE = os.path.join(K_DIR, "state.json")
DASH = os.path.join(pmlib.BASE, "dashboard", "data", "krakenarb.json")
REPORT = os.path.join(pmlib.BASE, "reports", "krakenarb-latest.md")
HIST_DIR = os.path.join(K_DIR, "history")
HIST_KEEP_DAYS = 7

HOME = "USD"                 # a US account holds dollars; cycles start and end here
BRIDGES = ("USDT", "USDC", "EUR", "XBT", "ETH")
SIZES = (5.0, 10.0, 20.0, 40.0)   # candidate start sizes in USD
DEFAULT_TAKER = 0.004        # Kraken base-tier taker if a pair omits its schedule


def _kraken(path, params=None):
    """Kraken wraps every response in {error: [...], result: {...}}."""
    raw = pmlib.get_json(f"{KRAKEN}/{path}", params) or {}
    if raw.get("error"):
        return None
    return raw.get("result")


# ---------------------------------------------------------------- universe

def parse_pairs(raw):
    """AssetPairs payload -> {key: {base, quote, taker, orderMin, costMin}}.

    Kraken's internal asset codes carry X/Z prefixes (XXBTZUSD), so base and
    quote are taken from wsname ("XBT/USD"), which is stable and readable.
    The taker fee is the first (base) tier of the pair's own fee schedule —
    percent in the API, converted to a fraction here. orderMin is the venue's
    minimum order volume in base units, costMin the minimum order cost in
    quote units; both are enforced per leg during verification because an
    order the venue would reject is not a fill.
    """
    out = {}
    for key, s in (raw or {}).items():
        if s.get("status", "online") != "online":
            continue
        ws = s.get("wsname") or ""
        if "/" not in ws:
            continue
        base, quote = ws.split("/", 1)
        fees = s.get("fees") or []
        try:
            taker = float(fees[0][1]) / 100.0 if fees else DEFAULT_TAKER
        except (TypeError, ValueError, IndexError):
            taker = DEFAULT_TAKER
        def _f(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0
        out[key] = {"base": base, "quote": quote, "taker": taker,
                    "orderMin": _f(s.get("ordermin")),
                    "costMin": _f(s.get("costmin"))}
    return out


def exchange_info():
    """Kraken pair map, cached six hours — fees and listings move slowly."""
    os.makedirs(pmlib.CACHE_DIR, exist_ok=True)
    path = os.path.join(pmlib.CACHE_DIR, "kraken_info.json")
    try:
        st = os.stat(path)
        if time.time() - st.st_mtime < 6 * 3600:
            with open(path) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    out = parse_pairs(_kraken("AssetPairs"))
    if out:
        with open(path, "w") as f:
            json.dump(out, f)
    return out


def book_tickers():
    """All best bid/asks in one call: {key: (bid, bidQty, ask, askQty)}."""
    rows = _kraken("Ticker") or {}
    out = {}
    for key, r in rows.items():
        try:
            ask, bid = float(r["a"][0]), float(r["b"][0])
            if bid > 0 and ask > 0:
                out[key] = (bid, float(r["b"][2]), ask, float(r["a"][2]))
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------- cycles

def build_cycles(info):
    """All 3-cycles through USD the listed pairs allow, in BOTH directions.

    Same structure as the MEXC builder: a leg is (key, action), 'buy'
    crosses the ask (quote -> base), 'sell' crosses the bid (base ->
    quote). Crossing the book makes at most one direction profitable at a
    time, so the mirror cycle is enumerated too.
    """
    pair = {}
    for key, s in info.items():
        pair[(s["base"], s["quote"])] = key
    cycles = []
    for key, s in info.items():
        if s["quote"] != HOME or s["base"] in BRIDGES:
            continue
        a = s["base"]
        for b in BRIDGES:
            leg3 = pair.get((b, HOME))
            if not leg3:
                continue
            if (a, b) in pair:      # cross pair is A/B
                cross = pair[(a, b)]
                cycles.append(((key, "buy"), (cross, "sell"), (leg3, "sell"), a, b))
                cycles.append(((leg3, "buy"), (cross, "buy"), (key, "sell"), b, a))
            elif (b, a) in pair:    # cross pair is B/A
                cross = pair[(b, a)]
                cycles.append(((key, "buy"), (cross, "buy"), (leg3, "sell"), a, b))
                cycles.append(((leg3, "buy"), (cross, "sell"), (key, "sell"), b, a))
    return cycles


def leg_rate(book, info, key, action):
    """Top-of-book conversion rate for one leg, net of that pair's fee."""
    q = book.get(key)
    if not q:
        return None
    bid, _, ask, _ = q
    fee = info[key]["taker"]
    return bid * (1 - fee) if action == "sell" else (1 / ask) * (1 - fee)


def cycle_fee_bps(info, legs):
    """Round-trip fee drag of one cycle in bps — the hurdle an edge must clear."""
    m = 1.0
    for key, _ in legs:
        m *= 1 - info[key]["taker"]
    return (1 - m) * 10_000


def screen_cycles(cycles, book, info, min_bps=1.0):
    """Multiply the three crossed-book rates; keep cycles that net > min_bps."""
    out = []
    for legs in cycles:
        (s1, a1), (s2, a2), (s3, a3), a, b = legs
        m = 1.0
        for key, act in ((s1, a1), (s2, a2), (s3, a3)):
            r = leg_rate(book, info, key, act)
            if r is None:
                m = 0
                break
            m *= r
        if m > 1 + min_bps / 10_000:
            leg_list = [[s1, a1], [s2, a2], [s3, a3]]
            out.append({"legs": leg_list,
                        "path": f"{HOME}→{a}→{b}→{HOME}",
                        "screenBps": round((m - 1) * 10_000, 1),
                        "feeBps": round(cycle_fee_bps(info, leg_list), 1)})
    out.sort(key=lambda o: -o["screenBps"])
    return out


# ---------------------------------------------------------------- depth math

def depth(key, limit=25):
    d = (_kraken("Depth", {"pair": key, "count": limit}) or {})
    rows = next(iter(d.values()), {}) if d else {}
    try:
        return ([(float(p), float(q)) for p, q, *_ in rows.get("bids", [])],
                [(float(p), float(q)) for p, q, *_ in rows.get("asks", [])])
    except (TypeError, ValueError):
        return [], []


class TooSmall(Exception):
    """A leg below the venue's minimum order volume or cost.

    Distinct from a thin-book failure on purpose: a larger STARTING size
    may clear the minimums, whereas nothing clears an exhausted book."""


def leg_fill(bids, asks, meta, amt, action):
    """One depth-walked leg with Kraken's per-pair minimums enforced.

    A buy spends `amt` of the pair's quote currency; a sell disposes `amt`
    of its base. The venue rejects orders below its minimum volume (base
    units) or minimum cost (quote units) — that raises TooSmall, a
    rejection a bigger start size can outgrow. A book too thin for the
    size returns None, which no bigger size can fix.
    """
    fee = meta["taker"]
    if action == "buy":
        if amt < meta["costMin"]:
            raise TooSmall
        got = walk_buy(asks, amt, fee)
        if got is None:
            return None
        if got < meta["orderMin"]:
            raise TooSmall
        return got
    if amt < meta["orderMin"]:
        raise TooSmall
    got = walk_sell(bids, amt, fee)
    if got is None:
        return None
    if got < meta["costMin"]:
        raise TooSmall
    return got


def verify_cycle(opp, info, books_cache):
    """Re-price the cycle by walking fresh depth; find the best viable size."""
    legs = opp["legs"]
    for key, _ in legs:
        if key not in books_cache:
            books_cache[key] = depth(key)
    best = None
    viable = {}
    for size in SIZES:
        amt = size
        exhausted = False
        try:
            for key, act in legs:
                bids, asks = books_cache[key]
                amt = leg_fill(bids, asks, info[key], amt, act)
                if amt is None:
                    exhausted = True
                    break
        except TooSmall:
            continue  # a larger start size may clear the venue minimums
        if exhausted:
            break  # a book too thin for this size is too thin for bigger
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


# ---------------------------------------------------------------- paper bot

def load_state():
    st = None
    try:
        with open(STATE) as f:
            st = json.load(f)
    except (OSError, ValueError):
        pass
    if not st:
        # The stake the operator intends for a real US test run.
        st = {"bankrollStart": 40.0, "cash": 40.0, "createdAt": int(time.time()),
              "trades": [], "equityCurve": [], "decay": {"checked": 0, "survived": 0},
              "cooldown": {}}
    st.setdefault("tradeCountAll", len(st.get("trades") or []))
    return st


def save_state(st):
    os.makedirs(K_DIR, exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f, indent=1)


def paper_execute(st, opps, now):
    """Round-trip verified cycles at the largest depth-verified size that
    fits the bankroll, with a per-cycle cooldown — same rules as MEXC."""
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
    """Append this scan's edges and leg quotes to a daily JSONL file, so the
    trial earns its own latency replay the same way the MEXC desk did."""
    global _prev_leg_syms
    os.makedirs(HIST_DIR, exist_ok=True)
    syms = set(_prev_leg_syms)
    for o in verified + watching:
        for key, _ in o["legs"]:
            syms.add(key)
    _prev_leg_syms = {key for o in verified for key, _ in o["legs"]}
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
    """Replay recorded history with one scan of latency (top-of-book only;
    the capture ratio, not the dollar figure, is the honest headline)."""
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
    for cur, nxt in pairwise(lines):
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
            for key, act in o["legs"]:
                top = nxt.get("tops", {}).get(key)
                fee = (info.get(key) or {}).get("taker", DEFAULT_TAKER)
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

def publish(st, meta, opps, watching, now):
    payload = {
        "updatedAt": now, "meta": meta,
        "opportunities": opps, "watching": watching,
        "paper": {"bankrollStart": st["bankrollStart"], "equity": st["cash"],
                  "trades": st["trades"][-25:][::-1],
                  "tradeCount": st.get("tradeCountAll", len(st["trades"])),
                  "equityCurve": st["equityCurve"][-300:]},
        "decay": st["decay"],
        "replay": st.get("replay"),
        "notes": ("Viability trial — paper only, no keys, no orders, and no "
                  "live path in the code. Cycles run through USD at Kraken's "
                  "base-tier taker fee on every leg; the fee hurdle column is "
                  "what a cycle must beat before profit exists. Per-pair "
                  "minimum order size and cost are enforced on every leg."),
    }
    os.makedirs(os.path.dirname(DASH), exist_ok=True)
    with open(DASH, "w") as f:
        json.dump(payload, f)
    lines = ["# Kraken viability trial — latest scan", "",
             time.strftime("Scanned %Y-%m-%d %H:%M UTC", time.gmtime(now)) +
             f" · {meta['pairs']} pairs · {meta['triangles']} cycles · "
             f"{len(opps)} verified edges · median fee hurdle "
             f"{meta['feeHurdleBps']} bps",
             "", "| cycle | screen bps | fee hurdle bps | verified bps | size | profit |",
             "|---|---|---|---|---|---|"]
    for o in opps:
        lines.append(f"| {o['path']} | {o['screenBps']} | {o.get('feeBps','—')} "
                     f"| {o.get('verifiedBps','—')} | ${o.get('sizeUsd','—')} "
                     f"| ${o.get('profitUsd','—')} |")
    if not opps:
        lines.append("| — | — | — | — | — | — |")
        top = watching[0] if watching else None
        if top:
            lines += ["", f"Closest approach: {top['path']} at {top['screenBps']} "
                          f"bps against a {top.get('feeBps','—')} bps fee hurdle."]
    r = st.get("replay")
    if r:
        lines += ["", "## Latency replay (own recorded ticks)", "",
                  f"- Edges replayed: {r['edges']} across {r['scansReplayed']} scans",
                  f"- Atomic PnL ${r['atomicUsd']} → one-scan-delay PnL "
                  f"${r['delayedUsd']} (capture ratio "
                  f"{r['captureRatio'] if r['captureRatio'] is not None else '—'})"]
    with open(REPORT, "w") as f:
        f.write("\n".join(lines) + "\n")


_last_hist = 0.0
_scan_n = 0


def scan_once(st, prev_keys):
    global _last_hist, _scan_n
    now = int(time.time())
    info = exchange_info()
    book = book_tickers()
    if len(info) < 300 or len(book) < 300:
        # A transient outage must not masquerade as an empty universe.
        raise RuntimeError(f"incomplete snapshot (info {len(info)}, book {len(book)})")
    cycles = build_cycles(info)
    screened = screen_cycles(cycles, book, info, min_bps=-200.0)
    live = [o for o in screened if o["screenBps"] >= 1.0]
    books_cache = {}
    if live:
        keys = list({key for o in live[:12] for key, _ in o["legs"]})
        # Kraken's public rate limit is stricter than MEXC's — fetch depth
        # with modest parallelism and let a failed fetch read as unverified.
        with ThreadPoolExecutor(max_workers=3) as ex:
            for key, d in zip(keys, ex.map(depth, keys), strict=True):
                books_cache[key] = d
    verified = []
    for o in live[:12]:
        if verify_cycle(o, info, books_cache):
            verified.append(o)
    watching = [o for o in screened if o not in verified][:8]
    cur_keys = {o["path"] for o in verified}
    if prev_keys is not None:
        st["decay"]["checked"] += len(prev_keys)
        st["decay"]["survived"] += len(prev_keys & cur_keys)
    executed = paper_execute(st, verified, now)
    if verified or time.time() - _last_hist >= 30:
        _last_hist = time.time()
        record_history(now, verified, watching, book)
    # Median over the FULL cycle universe, so the hurdle describes the same
    # population as the cycle count published beside it.
    hurdles = sorted(cycle_fee_bps(info, c[:3]) for c in cycles) or [0.0]
    meta = {"pairs": len(book), "triangles": len(cycles),
            "screened": len(live), "verified": len(verified),
            "feeHurdleBps": round(hurdles[len(hurdles) // 2], 1),
            "bestNetBps": screened[0]["screenBps"] if screened else None}
    publish(st, meta, verified, watching, now)
    save_state(st)
    _scan_n += 1
    if verified or executed or _scan_n % 30 == 1:
        print(f"{time.strftime('%H:%M:%S')} pairs {len(book)} · cycles {len(cycles)} "
              f"· live {len(live)} · verified {len(verified)} · paper {executed} "
              f"· equity ${st['cash']:.2f}", flush=True)
    return cur_keys, executed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    sub.add_parser("backtest")
    w = sub.add_parser("watch")
    w.add_argument("--duration-minutes", type=float, default=113)
    w.add_argument("--scan-seconds", type=float, default=10,
                   help="Kraken's public API is rate-limited well below "
                        "MEXC's; 10s keeps a full-universe screen sustainable")
    w.add_argument("--publish-minutes", type=float, default=10)
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
            prev, executed = scan_once(st, prev)
        except Exception as e:  # noqa: BLE001 — a bad scan must not kill the shift
            print(f"scan error: {e}", flush=True)
            executed = 0
        since = time.time() - last_pub
        if (executed and since > 90) or since > args.publish_minutes * 60:
            if pmlib.publish_repo(["data/krakenarb", "dashboard/data", "reports"],
                                  "auto: kraken trial scan"):
                last_pub = time.time()
        time.sleep(max(0.5, args.scan_seconds - (time.time() - t0)))
    print("Shift over — exiting cleanly.", flush=True)


if __name__ == "__main__":
    main()
