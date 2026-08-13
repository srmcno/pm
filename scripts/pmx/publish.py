#!/usr/bin/env python3
"""Publish the engine's live state to the dashboard.

Writes `dashboard/data/engine.json`, which the site polls every 60 seconds
alongside the original engine's `signals.json`. Both run; the page shows
both; they can disagree in public.

What goes in it is deliberately more than a list of signals. This engine
refuses far more than it accepts -- that is the design -- so a panel showing
only what fired would sit empty most of the time and look broken rather than
selective. The payload therefore carries the diagnostics too: how many
markets drew any weighted backing, how many reached two effective backers,
which rail did the refusing, and whether the probability model is calibrated
yet. A reader should be able to tell "waiting, correctly" apart from "dead"
without opening the logs.
"""
import json
import os
import time

import pmlib

from .calibrate import OBS_PATH, load_observations
from .consensus import vote_weight

OUT_DIR = os.path.join(pmlib.BASE, "dashboard", "data")
OUT_PATH = os.path.join(OUT_DIR, "engine.json")
STATE_PATH = os.path.join(pmlib.BASE, "data", "live", "engine-state.json")


def _voting_rights(profiles, cfg):
    """How many (wallet, category) pairs may vote at all — the pool size that
    decides whether two specialists can ever overlap on one market."""
    n, wallets = 0, set()
    for addr, prof in profiles.get("profiles", {}).items():
        if prof.get("excluded") or not prof.get("categories"):
            continue
        p = dict(prof, _specialty_min_share=cfg.consensus.specialty_min_share)
        for cat in prof["categories"]:
            if vote_weight(p, cat, cfg.weights) is not None:
                n += 1
                wallets.add(addr)
    return n, len(wallets)


def signal_row(cand, decision=None, economics=None):
    """One enriched candidate, flattened for the page."""
    d = cand.detail
    row = {
        "conditionId": cand.condition_id,
        "outcomeIndex": cand.outcome_index,
        "question": d.get("question") or cand.title,
        "outcome": d.get("outcome"),
        "category": cand.category,
        "currentPrice": d.get("currentPrice"),
        "backersAvgEntry": d.get("backersAvgEntry"),
        "drift": d.get("drift"),
        "driftLogit": d.get("driftLogit"),
        "sigma": cand.sigma,
        "nEff": cand.n_eff,
        "opposingSigma": cand.opposing_sigma,
        "backerCount": len(cand.backers),
        "totalNetUsd": round(sum(b["netUsd"] for b in cand.backers), 2),
        "endDate": d.get("endDate"),
        "daysToResolution": d.get("daysToResolution"),
        "slug": d.get("slug"),
        "eventSlug": d.get("eventSlug"),
        "backers": [{"name": b["name"], "wallet": b["wallet"],
                     "weight": b["weight"], "value": b["value"],
                     "netUsd": b["netUsd"], "avgPrice": b["avgPrice"],
                     "conviction": b["conviction"], "ageH": b["ageH"]}
                    for b in cand.backers[:6]],
    }
    if economics:
        row.update({"w": economics.get("w"),
                    "calibrated": economics.get("calibrated"),
                    "netEdge": economics.get("netEdge"),
                    "breakevenEdge": economics.get("breakevenEdge"),
                    "feePerShare": economics.get("feePerShare"),
                    "depthNotional": economics.get("depthNotional")})
    if decision is not None:
        row.update({"stake": decision.stake, "shares": decision.shares,
                    "binding": decision.binding,
                    "kellyFraction": round(decision.kelly_fraction, 5)})
    return row


def build_payload(cfg, profiles, engine, rows, *, source, feed=None,
                  candidates=0, multi_backer=0, warnings=None, now=None,
                  watchlist_size=None):
    now = int(now or time.time())
    rights, voters = _voting_rights(profiles, cfg)
    obs = len(load_observations(OBS_PATH))
    p = cfg.probability
    return {
        "meta": {
            "generatedAt": now,
            "source": source,
            "engine": "pmx",
            "weightMode": cfg.weights.mode,
            "theta": cfg.consensus.theta_trigger,
            "minEffectiveBackers": cfg.consensus.min_effective_backers,
            "specialtyMinShare": cfg.consensus.specialty_min_share,
            "watchlistSize": (watchlist_size if watchlist_size is not None
                              else len(engine.profiles)),
            "profiledWallets": sum(1 for p in profiles.get("profiles", {}).values()
                                   if p.get("categories")),
            "votingRights": rights,
            "votingWallets": voters,
            "bankroll": cfg.sizing.bankroll,
            "kellyFraction": cfg.sizing.kelly_fraction,
            "calibrated": bool(p.lam) and p.lam_sample_size >= p.min_calibration_samples,
            "lambda": p.lam,
            "observations": obs,
            "observationsNeeded": p.min_calibration_samples,
            "feed": feed or "rest",
            "warnings": warnings or [],
        },
        "signals": rows,
        "diagnostics": {
            "candidates": candidates,
            "multiBacker": multi_backer,
            "fired": len(rows),
            # Sorted so the dominant reason the engine is quiet is the first
            # thing a reader sees.
            "rejections": dict(sorted(engine.rejections.items(),
                                      key=lambda kv: -kv[1])[:10]),
        },
    }


def publish(payload, out_path=OUT_PATH):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, out_path)          # the page may fetch mid-write
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump({"generatedAt": payload["meta"]["generatedAt"],
                   "fired": payload["diagnostics"]["fired"],
                   "observations": payload["meta"]["observations"]}, f)
    return out_path
