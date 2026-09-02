#!/usr/bin/env python3
"""The validation record, and how the allocator reads it.

`desk.cli validate` writes data/desk/evidence.json: every desk's walk-forward
statistic at its own capital floor. That file is what decides whether a desk
may be funded. The desk's declared status can only make the answer stricter;
it cannot rescue a desk whose latest statistic failed. The record also ages:
past `MAX_AGE_DAYS` without a fresh run the allocator refuses everything,
because a strategy nobody has re-tested in a month is a strategy nobody is
watching.
"""
import json
import os
import time

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
PATH = os.path.join(BASE, "data", "desk", "evidence.json")
MAX_AGE_DAYS = 30


def load(path=None):
    try:
        with open(path or PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def verdicts(path=None, now=None, max_age_days=MAX_AGE_DAYS):
    """{desk name: {verdict, date, ageDays, stale}} from the evidence file.
    An empty dict means there is no record at all."""
    blob = load(path)
    gen = int(blob.get("generatedAt") or 0)
    now = now or time.time()
    age = (now - gen) / 86400.0 if gen else float("inf")
    out = {}
    for name, d in (blob.get("desks") or {}).items():
        out[name] = {
            "verdict": d.get("verdict", "?"),
            "generatedAt": gen,
            "date": time.strftime("%Y-%m-%d", time.gmtime(gen)) if gen else "never",
            "ageDays": round(age, 1) if gen else None,
            "maxAgeDays": max_age_days,
            "stale": age > max_age_days,
        }
    return out
