#!/usr/bin/env python3
"""Command line for the consensus engine.

  python3 -m pmx.cli preflight            # config sanity + what will block trades
  python3 -m pmx.cli scan                 # one-shot: detect -> score -> size -> plan
  python3 -m pmx.cli watch --minutes 30   # continuous dual-feed loop
  python3 -m pmx.cli explain <wallet>     # why a wallet's vote weighs what it does

`scan` and `watch` are dry runs. Placing real orders needs the same arming as
the rest of this repo -- keys in the environment, PMX_ARMED, both flags, and
no data/live/STOP -- and even then every rail in data/live/engine.json applies.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pmlib                                             # noqa: E402

from . import profiles as profmod                        # noqa: E402
from .book import Book                                   # noqa: E402
from .config import CONFIG_PATH, EngineConfig            # noqa: E402
from .consensus import vote_weight                       # noqa: E402
from .engine import ConsensusEngine                      # noqa: E402
from .execute import ExecutionClient, Rejected           # noqa: E402
from .feed import DualFeed                               # noqa: E402
from .sizing import Portfolio                            # noqa: E402

JOURNAL = os.path.join(pmlib.BASE, "data", "live", "engine-journal.jsonl")


def journal(**event):
    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    with open(JOURNAL, "a") as f:
        f.write(json.dumps({"t": int(time.time()), **event}, default=str) + "\n")


def load_profiles(path=None):
    path = path or profmod.OUT_PATH
    try:
        return profmod.load(path)
    except (OSError, ValueError):
        raise SystemExit(
            f"no edge profiles at {path}.\n"
            f"  python3 -m pmx.profiles              (needs data/raw)\n"
            f"  python3 -m pmx.profiles --degraded   (metadata only)")


def watchlist_from(profiles, limit):
    live = [(a, p) for a, p in profiles["profiles"].items() if not p["excluded"]]
    live.sort(key=lambda kv: -(kv[1].get("pnl90") or 0))
    return dict(live[:limit])


# ------------------------------------------------------------------ commands

def cmd_preflight(args):
    cfg = EngineConfig.load()
    try:
        cfg.validate()
        print("config: valid")
    except ValueError as e:
        print(e)
        return 1
    profiles = load_profiles(args.profiles)
    eng = ConsensusEngine(cfg, profiles)
    wl = watchlist_from(profiles, args.max_wallets)
    n_cat = sum(1 for p in wl.values() if p.get("categories"))
    print(f"profiles: {len(profiles['profiles'])} wallets, "
          f"{sum(1 for p in profiles['profiles'].values() if not p['excluded'])} eligible, "
          f"watchlist {len(wl)}")
    print(f"category evidence: {n_cat}/{len(wl)} watchlist wallets have a "
          f"settled per-category record"
          + ("  [DEGRADED — no wallet can vote]" if profiles.get("degraded") else ""))
    for w in eng.preflight():
        print(f"\nWARNING: {w}")
    return 0


def _seed_window(eng, watch, hours):
    """Backfill the rolling window from REST history so a fresh process has
    context instead of waiting `hours` for the live feed to rebuild it."""
    import signals as sigmod

    from .feed import Fill, resolve_outcome_index
    since = int(time.time()) - hours * 3600
    raw = sigmod.recent_trades_live(list(watch), since)
    now = time.time()
    fills, total = [], 0
    for wallet, trades in raw.items():
        for t in trades:
            m = eng.resolver.get(t.get("conditionId")) if t.get("conditionId") else None
            oi = resolve_outcome_index(t, (m or {}).get("outcomes"))
            if oi is None:
                continue
            fills.append(Fill(
                wallet=wallet, timestamp=t.get("timestamp") or 0,
                token_id="", side=t.get("side") or "BUY",
                price=t.get("price") or 0.0, shares=t.get("size") or 0.0,
                usdc=t.get("usdcSize") or 0.0, source="rest",
                tx=t.get("transactionHash") or "",
                condition_id=t.get("conditionId") or "", outcome_index=oi,
                title=t.get("title") or "", slug=t.get("slug") or "",
                event_slug=t.get("eventSlug") or "", detected_at=now))
            total += 1
    eng.ingest(fills)
    return total


def cmd_scan(args):
    cfg = EngineConfig.load().validate()
    profiles = load_profiles(args.profiles)
    eng = ConsensusEngine(cfg, profiles)
    for w in eng.preflight():
        print(f"WARNING: {w}\n")

    watch = watchlist_from(profiles, args.max_wallets)
    print(f"Seeding {len(watch)} wallets over {args.hours}h ...", flush=True)
    n = _seed_window(eng, watch, args.hours)
    print(f"  {n} fills ingested across {len(eng.window)} wallets")

    cands = eng.score()
    fired = [c for c in cands if not c.rejected]
    print(f"\n{len(cands)} markets with any weighted backing; "
          f"{len(fired)} clear Sigma >= {cfg.consensus.theta_trigger} "
          f"and N_eff >= {cfg.consensus.min_effective_backers}")
    if eng.rejections:
        print("  rejections:")
        for r, k in sorted(eng.rejections.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    {k:>4}  {r}")

    signals = eng.enrich(fired, max_days=args.max_days)
    print(f"\n{len(signals)} survive enrichment (open, in band, not chased)")

    # Full bankroll: size_position() subtracts the cash reserve itself, so
    # pre-deducting it here would apply the floor twice and shrink the 5%
    # position cap below what preflight reports as tradable.
    portfolio = Portfolio(cash=cfg.sizing.bankroll, positions=[])
    ex = ExecutionClient(cfg, dry_run=True, journal=journal)
    for c in signals[:args.top]:
        d = c.detail
        book = None
        if d.get("tokenId"):
            try:
                raw = pmlib.get_json(f"{pmlib.CLOB_API}/book",
                                     {"token_id": d["tokenId"]})
                if raw:
                    book = Book.parse(raw, d["tokenId"])
            except Exception:                              # noqa: BLE001
                book = None
        decision, econ = eng.size(c, portfolio, book)
        # Journal every fired signal, traded or not: `settle` reads these to
        # build the calibration set, and a signal we declined still carries a
        # valid (price, Sigma, outcome) observation.
        journal(action="SIGNAL", sigma=c.sigma, nEff=c.n_eff,
                conditionId=c.condition_id, outcomeIndex=c.outcome_index,
                category=c.category, **d)
        print(f"\n  {d.get('question','?')[:66]}")
        print(f"    -> {d.get('outcome')} @ {d['currentPrice']:.3f} "
              f"| Sigma {c.sigma:.2f} N_eff {c.n_eff:.2f} "
              f"| {len(c.backers)} backers | {c.category}")
        print(f"    w={econ['w']:.4f} ({'fitted' if econ['calibrated'] else 'UNCALIBRATED'})"
              f"  net edge {econ['netEdge']*100:+.2f}c/share"
              f"  breakeven fee {econ['breakevenEdge']*100:.2f}c")
        if book:
            print(f"    book: bid {book.best_bid} ask {book.best_ask} "
                  f"spread {book.spread:.3f} depth@1c ${econ['depthNotional'] or 0:,.0f}")
        print(f"    stake ${decision.stake:.2f} ({decision.shares:.2f} shares) "
              f"— binding rail: {decision.binding}")
        for b in c.backers[:4]:
            print(f"      {(b['name'] or b['wallet'][:10])[:18]:<20} W={b['weight']:.3f} "
                  f"v={b['value']:.3f} ${b['netUsd']:>8,.0f} @ "
                  f"{b['avgPrice'] if b['avgPrice'] else '—'} "
                  f"conv {b['conviction']}x  {b['ageH']:.1f}h ago")
        if decision.ok:
            try:
                plan = ex.check_entry({**d, "detectedAt": time.time()}, book,
                                      econ["w"], decision.stake,
                                      category=c.category)
                print(f"    ORDER (dry run): {plan['shares']} @ <= {plan['limit']} "
                      f"FOK, expected fill {plan['expectedFill']:.4f}, "
                      f"fee {plan['feePerShare']*100:.3f}c/share")
                ex.submit_entry(plan)
            except Rejected as e:
                print(f"    execution rejected: {e}")
    return 0


def cmd_watch(args):
    cfg = EngineConfig.load().validate()
    profiles = load_profiles(args.profiles)
    eng = ConsensusEngine(cfg, profiles)
    watch = watchlist_from(profiles, args.max_wallets)
    feed = DualFeed(set(watch), rpc_url=args.rpc or cfg.feed.polygon_ws_url or None)
    print(f"Watching {len(watch)} wallets "
          f"({'chain + REST' if feed.chain else 'REST only — pass --rpc for sub-second'})",
          flush=True)
    _seed_window(eng, watch, args.hours)
    deadline = time.time() + args.minutes * 60 if args.minutes else None
    seen = set()
    while not deadline or time.time() < deadline:
        fills = feed.poll()
        if fills:
            eng.ingest(fills)
            eng.prune(time.time())
            for c in eng.enrich([c for c in eng.score() if not c.rejected],
                                max_days=args.max_days):
                k = (c.condition_id, c.outcome_index)
                if k in seen:
                    continue
                seen.add(k)
                d = c.detail
                print(f"  SIGNAL Sigma={c.sigma:.2f} N_eff={c.n_eff:.2f} "
                      f"{d.get('question','?')[:52]} -> {d.get('outcome')} "
                      f"@ {d['currentPrice']:.3f}", flush=True)
                journal(action="SIGNAL", sigma=c.sigma, nEff=c.n_eff,
                        conditionId=c.condition_id,
                        outcomeIndex=c.outcome_index, category=c.category, **d)
        time.sleep(cfg.feed.data_api_poll_s)
    print(json.dumps(feed.summary(), indent=1))
    return 0


def cmd_settle(args):
    """Turn resolved signals into calibration observations.

    This is the step that closes the loop. Signals are journaled when they
    fire; nothing else revisits them, so without this pass observations.jsonl
    stays empty, lambda stays 0, and the engine can never graduate from flat
    bootstrap stakes to Kelly no matter how long it runs.

    Idempotent: each (market, outcome, signal time) is recorded once.
    """
    from . import calibrate as calmod
    resolver = pmlib.MarketResolver()
    seen_path = os.path.join(pmlib.BASE, "data", "live", "settled.json")
    seen = set(tuple(k) for k in (json.load(open(seen_path))
                                  if os.path.exists(seen_path) else []))
    fired, added, pending = [], 0, 0
    try:
        with open(JOURNAL) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("action") == "SIGNAL":
                    fired.append(r)
    except OSError:
        raise SystemExit(f"no journal at {JOURNAL} — run scan or watch first")

    for r in fired:
        key = (r.get("conditionId"), r.get("outcomeIndex"), r.get("t"))
        if key in seen or key[0] is None:
            continue
        m = resolver.get(r["conditionId"])
        oi = r.get("outcomeIndex") or 0
        prices = (m or {}).get("outcomePrices") or []
        if not m or not m.get("closed") or oi >= len(prices):
            pending += 1
            continue
        final = prices[oi]
        if not (m.get("resolved") or final >= 0.99 or final <= 0.01):
            pending += 1
            continue                       # closed but still in dispute
        calmod.record_observation(price=r.get("currentPrice"),
                                  sigma=r.get("sigma"), won=final >= 0.5,
                                  t=r.get("t"))
        seen.add(key)
        added += 1
    resolver.save()
    os.makedirs(os.path.dirname(seen_path), exist_ok=True)
    with open(seen_path, "w") as f:
        json.dump([list(k) for k in seen], f)

    total = len(calmod.load_observations())
    need = EngineConfig.load().probability.min_calibration_samples
    print(f"{len(fired)} signals journaled · {added} newly settled · "
          f"{pending} still open")
    print(f"observations: {total}/{need} needed before lambda can be fitted"
          + ("  — run `python3 -m pmx.calibrate`" if total >= need else ""))
    return 0


def cmd_explain(args):
    cfg = EngineConfig.load()
    profiles = load_profiles(args.profiles)
    prof = profiles["profiles"].get(args.wallet.lower())
    if not prof:
        raise SystemExit(f"no profile for {args.wallet}")
    prof = dict(prof, _specialty_min_share=cfg.consensus.specialty_min_share)
    print(f"{prof['name']}  ({args.wallet})")
    print(f"  archetype {prof['archetype']}  90d PnL ${prof['pnl90'] or 0:,.0f}  "
          f"Sharpe {prof['sharpe']} over {prof['pnlDays']}d")
    if prof["excluded"]:
        print(f"  EXCLUDED [{prof['exclusionCode']}]: {prof['exclusionReason']}")
        return 0
    from .consensus import _consistency_term, _scale_term, _skill_term
    print(f"  scale term      {_scale_term(prof, cfg.weights):.4f}")
    print(f"  consistency     {_consistency_term(prof, cfg.weights):.4f}")
    print(f"  {'category':<14}{'vol share':>10}{'skill':>8}{'W_i':>8}")
    for cat, share in sorted(prof["categoryShare"].items(),
                             key=lambda kv: -kv[1])[:8]:
        skill = _skill_term(prof, cat, cfg.weights)
        W = vote_weight(prof, cat, cfg.weights)
        print(f"  {cat:<14}{share:>10.2%}"
              f"{'—' if skill is None else format(skill, '.4f'):>8}"
              f"{'—' if W is None else format(W, '.4f'):>8}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profiles", default=None)
    ap.add_argument("--max-wallets", type=int, default=60)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("preflight").set_defaults(fn=cmd_preflight)

    p = sub.add_parser("scan")
    p.add_argument("--hours", type=int, default=24)
    p.add_argument("--max-days", type=float, default=7.0)
    p.add_argument("--top", type=int, default=10)
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("watch")
    p.add_argument("--hours", type=int, default=24)
    p.add_argument("--minutes", type=float, default=0)
    p.add_argument("--max-days", type=float, default=7.0)
    p.add_argument("--rpc", default=None, help="Polygon RPC for the chain feed")
    p.set_defaults(fn=cmd_watch)

    sub.add_parser("settle").set_defaults(fn=cmd_settle)

    p = sub.add_parser("explain")
    p.add_argument("wallet")
    p.set_defaults(fn=cmd_explain)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
