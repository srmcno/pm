#!/usr/bin/env python3
"""The pipeline: Ingestion -> Signal Scoring -> Sizing -> Execution -> Exits.

Each stage is a pure-ish function over the previous stage's output, so any of
them can be run alone in a test or a backtest without a venue, a key, or a
socket. The orchestration below is deliberately thin -- the judgement lives in
consensus.py, sizing.py and exits.py, and this file only sequences it and
records why each candidate died.

    fills          -> ingest()   rolling per-wallet stance window
    stances        -> score()    W_i, Sigma, N_eff, dominance -> candidates
    candidates     -> enrich()   market metadata, live book, drift guard
    signals        -> size()     fractional Kelly under every exposure rail
    orders         -> execute()  bounded-slippage FOK, or a dry-run plan
    positions      -> manage()   take-profit, reversal, stop, time rails

A candidate that dies carries the reason with it. Signal engines that discard
silently are impossible to debug at 3am, and this one refuses far more than it
accepts by design -- knowing which rail did the refusing is the difference
between tuning and guessing.
"""
import time
from collections import defaultdict
from dataclasses import dataclass, field

import pmlib
from analyze import classify

from . import fees
from .config import EngineConfig
from .consensus import (drift_check, effective_backers, implied_win_probability,
                        net_edge, passes_consensus, vote_value, vote_weight)
from .exits import consensus_reversal, exit_order, take_profit
from .sizing import Portfolio, size_position, tradable_price_ceiling


@dataclass
class Candidate:
    condition_id: str
    outcome_index: int
    category: str
    title: str
    sigma: float
    n_eff: float
    backers: list = field(default_factory=list)
    opposing_sigma: float = 0.0
    rejected: str = None
    detail: dict = field(default_factory=dict)


class ConsensusEngine:
    def __init__(self, cfg: EngineConfig, profiles, resolver=None):
        self.cfg = cfg
        self.profiles = profiles.get("profiles", profiles)
        self.resolver = resolver or pmlib.MarketResolver()
        # wallet -> (conditionId, outcomeIndex) -> stance
        self.window = defaultdict(lambda: defaultdict(
            lambda: {"net": 0.0, "bought": 0.0, "shares": 0.0, "last": 0,
                     "category": None, "title": ""}))
        self.rejections = defaultdict(int)

    # ------------------------------------------------------------- ingest
    def ingest(self, fills):
        """Fold fills into each wallet's running stance per market outcome."""
        n = 0
        for f in fills:
            if not f.condition_id or f.outcome_index is None:
                self.rejections["fill: unresolved market/outcome"] += 1
                continue
            if f.wallet.lower() not in self.profiles:
                continue
            s = self.window[f.wallet.lower()][(f.condition_id, f.outcome_index)]
            if f.side == "BUY":
                s["net"] += f.usdc
                s["bought"] += f.usdc
                s["shares"] += f.shares
            else:
                s["net"] -= f.usdc
            s["last"] = max(s["last"], f.timestamp)
            if s["category"] is None:
                # classify() matches against "slug eventSlug title" — the
                # slug carries the league and fixture tokens most of the
                # Sports rules key on, so a title-only call misroutes a large
                # share of flow into "Other" and silences the specialty gate.
                s["category"] = classify({"title": f.title, "slug": f.slug,
                                          "eventSlug": f.event_slug})
                s["title"] = f.title
            n += 1
        return n

    def prune(self, now):
        cutoff = now - self.cfg.consensus.max_vote_age_h * 3600
        for wallet, markets in list(self.window.items()):
            for key, s in list(markets.items()):
                if s["last"] < cutoff:
                    del markets[key]
            if not markets:
                del self.window[wallet]

    # -------------------------------------------------------------- score
    def score(self, now=None):
        """Weighted consensus per (market, outcome). Returns candidates."""
        now = now or time.time()
        c = self.cfg.consensus
        # (cid, oi) -> [vote dicts]
        sides = defaultdict(list)
        meta = {}

        for wallet, markets in self.window.items():
            prof = self.profiles.get(wallet)
            if not prof or prof.get("excluded"):
                continue
            prof = dict(prof, _specialty_min_share=c.specialty_min_share)
            # A wallet's stance is its best net outcome less anything it put
            # on the other side of the same market: buying both sides is a
            # hedge, not an opinion.
            by_market = defaultdict(dict)
            for (cid, oi), s in markets.items():
                by_market[cid][oi] = s
            for cid, outcomes in by_market.items():
                best_oi = max(outcomes, key=lambda o: outcomes[o]["net"])
                s = outcomes[best_oi]
                hedge = sum(max(0.0, outcomes[o]["net"])
                            for o in outcomes if o != best_oi)
                net = s["net"] - hedge
                if net < c.min_net_usd:
                    continue
                category = s["category"] or "Other"
                W = vote_weight(prof, category, self.cfg.weights)
                if W is None or W <= 0:
                    continue
                conviction = net / max(prof.get("medianTradeUsd") or 100.0, 1.0)
                if conviction < c.min_conviction:
                    continue
                age_h = (now - s["last"]) / 3600.0
                v = vote_value(W, conviction, age_h, c)
                if v <= 0:
                    continue
                meta.setdefault((cid, best_oi), {
                    "category": category, "title": s["title"]})
                sides[(cid, best_oi)].append({
                    "wallet": wallet, "name": prof.get("name"),
                    "weight": round(W, 5), "value": round(v, 5),
                    "netUsd": round(net, 2),
                    # Average entry is dollars over SHARES. Weighting each
                    # price by the dollars spent at it biases toward the
                    # expensive fills: ten shares at 20c and ten at 80c is a
                    # 50c average, but dollar-weighting reports 68c. The
                    # drift guard subtracts this number, so an overstated
                    # entry makes a chased price look flat and lets the order
                    # through -- the exact failure the guard exists to stop.
                    "avgPrice": (round(s["bought"] / s["shares"], 4)
                                 if s["shares"] > 0 else None),
                    "conviction": round(min(conviction, c.conviction_cap), 2),
                    "ageH": round(age_h, 2),
                })

        # Group by market so the dominance test can see both sides.
        by_market = defaultdict(dict)
        for (cid, oi), votes in sides.items():
            by_market[cid][oi] = votes

        out = []
        for cid, outcomes in by_market.items():
            scored = sorted(
                ((sum(v["value"] for v in votes), oi, votes)
                 for oi, votes in outcomes.items()), key=lambda t: -t[0])
            sigma, oi, votes = scored[0]
            opposing = scored[1][0] if len(scored) > 1 else 0.0
            m = meta[(cid, oi)]
            n_eff = effective_backers([v["value"] for v in votes])
            votes.sort(key=lambda v: -v["value"])
            cand = Candidate(condition_id=cid, outcome_index=oi,
                             category=m["category"], title=m["title"],
                             sigma=round(sigma, 4), n_eff=round(n_eff, 3),
                             backers=votes, opposing_sigma=round(opposing, 4))

            if opposing > 0 and sigma < c.dominance * opposing:
                cand.rejected = (f"contested: {sigma:.2f} vs {opposing:.2f} on "
                                 f"the other side, under {c.dominance}x")
                self.rejections["contested — the sharps disagree"] += 1
            else:
                ok, reasons = passes_consensus(sigma, n_eff, len(votes), c)
                if not ok:
                    cand.rejected = "; ".join(reasons)
                    # Bucket on WHICH rails failed, not on the formatted
                    # message. The message embeds the actual Sigma, so every
                    # distinct value became its own bucket and the panel's
                    # "most common reason" fragmented into dozens of
                    # near-identical rows instead of naming the real cause.
                    self.rejections[" + ".join(label for failed, label in (
                        (sigma < c.theta_trigger, "Sigma below Theta"),
                        (n_eff < c.min_effective_backers,
                         "fewer than %.1f effective backers" % c.min_effective_backers),
                        (len(votes) < c.min_backers, "too few backers"),
                    ) if failed)] += 1
            out.append(cand)

        out.sort(key=lambda x: (x.rejected is not None, -x.sigma))
        return out

    # ------------------------------------------------------------- enrich
    def enrich(self, candidates, max_days=None, now=None):
        """Attach live market state and apply the latency guardrail."""
        now = now or time.time()
        x = self.cfg.execution
        kept = []

        def reject(cand, reason, bucket):
            """Record the reason AND count it.

            The dashboard names the most common reason a quiet engine is
            quiet, so a rejection that sets `rejected` without counting is
            invisible there -- and enrichment is where most candidates
            actually die (20 of 22 multi-backer markets in a live sample had
            already closed). Leaving these uncounted let a score-stage
            reason masquerade as the explanation.
            """
            cand.rejected = reason
            self.rejections[bucket] += 1

        for c in candidates:
            if c.rejected:
                continue
            m = self.resolver.get(c.condition_id)
            if not m or m.get("closed"):
                reject(c, "market closed", "market already closed")
                continue
            oi = c.outcome_index or 0
            prices = m.get("outcomePrices") or []
            if oi >= len(prices):
                reject(c, f"outcome index {oi} outside the market's outcomes",
                       "outcome index out of range")
                continue
            price = prices[oi]
            if not (x.min_price <= price <= x.max_price):
                reject(c, f"price {price:.3f} outside "
                          f"[{x.min_price:.2f}, {x.max_price:.2f}]",
                       "price outside the tradable band")
                continue
            end_ts = _end_ts(m.get("endDate"))
            if max_days is not None:
                if end_ts is None or end_ts - now > max_days * 86400:
                    reject(c, "resolves too far out (or no parseable end date)",
                           "resolves too far out")
                    continue

            # Weight the backers' entry by their vote, not equally: the
            # reference price should be the one the consensus actually paid.
            wsum = sum(b["value"] for b in c.backers if b["avgPrice"])
            entry = (sum(b["value"] * b["avgPrice"] for b in c.backers
                         if b["avgPrice"]) / wsum) if wsum else None
            ok, drift = drift_check(price, entry, x)
            if not ok:
                reject(c, f"drift {drift['drift']:+.3f} "
                          f"({drift['driftLogit']:+.3f} logit) past the "
                          f"backers' entry", "price drift (chasing)")
                continue

            c.detail.update({
                "question": m.get("question"),
                "outcome": (m.get("outcomes") or [None] * (oi + 1))[oi],
                "tokenId": (m.get("clobTokenIds") or [None] * (oi + 1))[oi],
                "currentPrice": price,
                "backersAvgEntry": round(entry, 4) if entry else None,
                # The dashboard builds its "Open" link from these; without
                # them every published signal points nowhere. The resolver
                # has both, so omitting them was pure loss.
                "slug": m.get("slug"),
                "eventSlug": m.get("eventSlug"),
                "endDate": m.get("endDate"),
                "daysToResolution": ((end_ts - now) / 86400.0
                                     if end_ts else None),
                **drift,
            })
            kept.append(c)
        return kept

    # --------------------------------------------------------------- size
    def size(self, candidate: Candidate, portfolio: Portfolio, book=None):
        """Kelly, then every rail. Returns (decision, economics)."""
        p = self.cfg.probability
        price = candidate.detail["currentPrice"]
        w, calibrated = implied_win_probability(
            price, candidate.sigma, p, theta=self.cfg.consensus.theta_trigger)

        fill, depth = price, None
        if book is not None and book.best_ask is not None:
            fill = book.best_ask
            depth = book.depth_notional(
                book.best_ask + self.cfg.execution.max_slippage, "buy")

        rate = fees.taker_rate(candidate.category, self.cfg.execution)
        entry_fee = fees.fee_per_share(fill, rate)
        # Held to resolution a winner redeems at $1 with no fee, so only the
        # entry is charged here; exits.py charges the exit leg if it sells.
        decision = size_position(
            w, price, fill, portfolio, self.cfg.sizing,
            entry_fee=entry_fee, exit_fee=0.0,
            cluster=candidate.condition_id, category=candidate.category,
            depth_notional=depth, calibrated=calibrated)
        economics = {
            "w": round(w, 4), "calibrated": calibrated,
            "price": price, "fill": round(fill, 4),
            "feePerShare": round(entry_fee, 6), "feeRate": rate,
            "netEdge": round(net_edge(w, fill, entry_fee), 5),
            "breakevenEdge": round(fees.breakeven_edge(fill, rate), 5),
            "depthNotional": None if depth is None else round(depth, 2),
        }
        return decision, economics

    # --------------------------------------------------------------- exits
    def manage(self, positions, marks, stances_by_market, now=None):
        """Exit decisions for every open position."""
        now = now or time.time()
        out = []
        for pos in positions:
            key = (pos.get("conditionId"), pos.get("outcomeIndex"))
            mark = marks.get(key, {}).get("price")
            if mark is None:
                continue
            days = marks.get(key, {}).get("daysToResolution")
            if days is None:
                days = self.cfg.exits.max_hold_days
            d = take_profit(pos, mark, days, self.cfg.exits, now=now)
            if not d.exiting:
                d = consensus_reversal(pos, stances_by_market.get(key, {}),
                                       self.cfg.exits)
            if d.exiting:
                order = exit_order(d, mark, marks.get(key, {}).get("bestBid"),
                                   self.cfg.exits,
                                   tick=marks.get(key, {}).get("tick", 0.01))
                out.append({"position": pos, "decision": d, "order": order})
        return out

    # ------------------------------------------------------------- report
    def preflight(self):
        """Refuse to start in a configuration that cannot place an order."""
        s = self.cfg.sizing
        ceiling = tradable_price_ceiling(s.bankroll, s)
        warnings = []
        if ceiling < self.cfg.execution.max_price:
            warnings.append(
                f"bankroll ${s.bankroll:.0f} with a {s.max_position_frac:.0%} "
                f"position cap and a {s.min_shares:g}-share exchange minimum "
                f"can only buy outcomes priced under {ceiling:.2f}; the "
                f"configured band goes to {self.cfg.execution.max_price:.2f}. "
                f"Signals above {ceiling:.2f} will always be rejected as "
                f"under-minimum. Raise the bankroll to "
                f"${s.min_shares * self.cfg.execution.max_price / s.max_position_frac:.0f} "
                f"or lower execution.max_price.")
        if not self.cfg.probability.lam:
            warnings.append(
                "probability.lam is 0 (unfitted) — every stake will be the "
                "flat minimum, not Kelly. Run `python3 -m pmx.calibrate` once "
                f"{self.cfg.probability.min_calibration_samples} signals have "
                f"settled.")
        return warnings


def _end_ts(end_date):
    if not isinstance(end_date, str):
        return None
    from datetime import datetime, timezone
    try:
        d = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.timestamp()
    except ValueError:
        return None
