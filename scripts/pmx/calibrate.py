#!/usr/bin/env python3
"""Fit the one number that makes Kelly sizing legitimate.

Kelly needs a win probability w. Consensus strength Sigma is not a
probability -- it is a score in arbitrary units, and treating it as one is
the single most expensive mistake available in this design, because Kelly
scales the bet linearly in the claimed edge. A w that is 5 points too
optimistic does not cost 5% of the bankroll, it compounds into ruin.

So w is defined as a one-parameter correction to the market price, in
log-odds:

    logit(w) = logit(p) + lambda * (Sigma - Theta)

p is the prior -- prediction market prices are well calibrated and beating
them is the whole claim. (Sigma - Theta) is the evidence, centred so that a
signal landing exactly on the trigger threshold asserts no edge at all.
lambda is how much a unit of sharp agreement has historically been worth,
and it is FIT from settled outcomes here, never chosen.

The fit is a single-parameter logistic regression with logit(p) as a fixed
offset, solved by Newton-Raphson with an L2 prior. Its acceptance gate is
out-of-sample: fit on the earlier 70% of signals, score the later 30%, and
keep lambda only if it beats simply trusting the market price on held-out
log-loss. A lambda that cannot beat the price out of sample is an
overfit, and this refuses to write it.

Usage:
  python3 -m pmx.calibrate --observations data/live/observations.jsonl
  python3 -m pmx.calibrate --dry-run          # report, do not write config

Each observation is one settled signal:
  {"t": 1786611554, "price": 0.62, "sigma": 1.9, "won": 1}
"""
import argparse
import json
import math
import os
import sys
import time

from .config import CONFIG_PATH, EngineConfig
from .consensus import clamp, expit, logit

OBS_PATH = os.path.join(os.path.dirname(CONFIG_PATH), "observations.jsonl")


def load_observations(path=OBS_PATH):
    obs = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("price") is None or r.get("won") is None:
                    continue
                p = float(r["price"])
                if not 0.0 < p < 1.0:
                    continue
                obs.append({"t": int(r.get("t") or 0), "price": p,
                            "sigma": float(r.get("sigma") or 0.0),
                            "won": 1 if r["won"] else 0})
    except OSError:
        return []
    obs.sort(key=lambda r: r["t"])
    return obs


def record_observation(price, sigma, won, t=None, path=OBS_PATH):
    """Append one settled signal. The engine calls this at resolution."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps({"t": int(t or time.time()), "price": price,
                            "sigma": sigma, "won": 1 if won else 0}) + "\n")


# ------------------------------------------------------------------- fit

def fit_lambda(obs, theta, l2_sigma=1.0, iters=60, tol=1e-10):
    """Newton-Raphson on a single-parameter logistic model with an offset.

    L(lam) = sum[ y*log(w) + (1-y)*log(1-w) ] - lam^2 / (2*l2_sigma^2)
    with  logit(w) = logit(p) + lam * x,  x = Sigma - Theta.

    The L2 prior is what keeps a handful of lucky signals from producing a
    lambda of 40. With few observations it pulls the answer to ~0, which
    correctly means "no demonstrated edge".
    """
    if not obs:
        return 0.0, {"converged": False, "reason": "no observations"}
    xs = [o["sigma"] - theta for o in obs]
    zs = [logit(o["price"]) for o in obs]
    ys = [o["won"] for o in obs]
    if all(abs(x) < 1e-12 for x in xs):
        return 0.0, {"converged": False, "reason": "no variation in Sigma"}

    lam = 0.0
    for _ in range(iters):
        grad = -lam / (l2_sigma ** 2)
        hess = -1.0 / (l2_sigma ** 2)
        for x, z, y in zip(xs, zs, ys):
            w = expit(z + lam * x)
            grad += x * (y - w)
            hess -= x * x * w * (1.0 - w)
        if abs(hess) < 1e-12:
            break
        step = grad / hess
        lam -= step
        # A runaway step means separation; clamp rather than diverge.
        lam = clamp(lam, -10.0, 10.0)
        if abs(step) < tol:
            return lam, {"converged": True}
    return lam, {"converged": False, "reason": "did not converge"}


# ---------------------------------------------------------------- scoring

def log_loss(obs, lam, theta):
    if not obs:
        return float("nan")
    tot = 0.0
    for o in obs:
        w = expit(logit(o["price"]) + lam * (o["sigma"] - theta))
        w = clamp(w, 1e-9, 1 - 1e-9)
        tot += -(o["won"] * math.log(w) + (1 - o["won"]) * math.log(1 - w))
    return tot / len(obs)


def brier(obs, lam, theta):
    if not obs:
        return float("nan")
    tot = 0.0
    for o in obs:
        w = expit(logit(o["price"]) + lam * (o["sigma"] - theta))
        tot += (w - o["won"]) ** 2
    return tot / len(obs)


def reliability(obs, lam, theta, bins=5):
    """Predicted vs realized frequency, the plot that catches a liar."""
    buckets = [[] for _ in range(bins)]
    for o in obs:
        w = expit(logit(o["price"]) + lam * (o["sigma"] - theta))
        buckets[min(bins - 1, int(w * bins))].append((w, o["won"]))
    out = []
    for i, b in enumerate(buckets):
        if not b:
            continue
        out.append({"bin": f"{i/bins:.1f}-{(i+1)/bins:.1f}", "n": len(b),
                    "predicted": round(sum(w for w, _ in b) / len(b), 4),
                    "realized": round(sum(y for _, y in b) / len(b), 4)})
    return out


def walk_forward(obs, theta, l2_sigma, folds=5, min_train=80):
    """Rolling-origin evaluation: train on the past, score the next block.

    A single 70/30 split wastes 70% of the data as unscored and leaves the
    verdict resting on one noisy block -- in testing it rejected a genuine
    lambda of 0.40 at n=600 purely on split variance. Expanding windows score
    nearly every observation out of sample while never letting the model see
    its own future, which is the property that matters for a strategy that
    will meet regime changes.

    Returns (model_log_loss, baseline_log_loss, n_scored, t_stat) where
    t_stat is the paired one-sided statistic on the per-observation loss
    difference. Comparing two mean log-losses is a paired measurement -- every
    held-out signal is scored by both models -- so the paired standard error
    is the right yardstick, and it is far tighter than treating the two means
    as independent.
    """
    n = len(obs)
    if n < min_train + folds:
        return float("nan"), float("nan"), 0, 0.0
    edges = [min_train + round(i * (n - min_train) / folds) for i in range(folds + 1)]
    diffs = []                       # baseline loss - model loss, per signal
    m_tot = b_tot = 0.0
    for a, b in zip(edges, edges[1:]):
        if b <= a:
            continue
        train, test = obs[:a], obs[a:b]
        lam, _ = fit_lambda(train, theta, l2_sigma)
        for o in test:
            lm = log_loss([o], lam, theta)
            lb = log_loss([o], 0.0, theta)
            diffs.append(lb - lm)
            m_tot += lm
            b_tot += lb
    scored = len(diffs)
    if not scored:
        return float("nan"), float("nan"), 0, 0.0
    mean = sum(diffs) / scored
    if scored > 1:
        var = sum((d - mean) ** 2 for d in diffs) / (scored - 1)
        se = math.sqrt(var / scored)
    else:
        se = 0.0
    t = mean / se if se > 1e-12 else 0.0
    return m_tot / scored, b_tot / scored, scored, t


def calibrate(obs, theta, folds=5, l2_grid=(0.1, 0.25, 0.5, 1.0, 2.0),
              min_t=2.0):
    """Choose the prior strength by walk-forward score, then fit on everything.

    The L2 strength is itself a hyperparameter, so picking it by the same
    out-of-sample criterion is the only defensible way to set it. On the
    degenerate case -- every signal a winner -- the grid selects a tight prior
    and lambda stays small, instead of the unbounded value that maximum
    likelihood would hand back from perfect separation.
    """
    n = len(obs)
    results = []
    for l2 in l2_grid:
        m, b, scored, t = walk_forward(obs, theta, l2, folds)
        if scored:
            results.append({"l2": l2, "oosLogLoss": m,
                            "oosBaselineLogLoss": b, "nScored": scored,
                            "tStat": t})
    best = min(results, key=lambda r: r["oosLogLoss"]) if results else None

    l2 = best["l2"] if best else l2_grid[-1]
    lam, info = fit_lambda(obs, theta, l2)
    # "Better than the book" is not enough: an improvement inside sampling
    # noise is how a strategy talks itself into sizing on nothing. Require the
    # paired improvement to clear `min_t` standard errors. Note the grid
    # search already picked the luckiest l2, so this threshold is doing
    # double duty and should not be lowered.
    improves = bool(best) and (best["oosLogLoss"] < best["oosBaselineLogLoss"]
                               and best["tStat"] >= min_t)

    return {
        "n": n, "theta": theta,
        "lambda": round(lam, 5),
        "l2Chosen": l2,
        "converged": info.get("converged", False),
        "note": info.get("reason"),
        "inSampleLogLoss": round(log_loss(obs, lam, theta), 5),
        "baselineLogLoss": round(log_loss(obs, 0.0, theta), 5),
        "oosLogLoss": round(best["oosLogLoss"], 5) if best else None,
        "oosBaselineLogLoss": round(best["oosBaselineLogLoss"], 5) if best else None,
        "oosScored": best["nScored"] if best else 0,
        "tStat": round(best["tStat"], 3) if best else None,
        "minTRequired": min_t,
        "oosBrier": round(brier(obs, lam, theta), 5),
        "oosBrierBaseline": round(brier(obs, 0.0, theta), 5),
        "beatsMarketOutOfSample": improves,
        "l2Sweep": [{k: (round(v, 5) if isinstance(v, float) else v)
                     for k, v in r.items()} for r in results],
        "reliability": reliability(obs, lam, theta),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--observations", default=OBS_PATH)
    ap.add_argument("--folds", type=int, default=5,
                    help="walk-forward evaluation blocks")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="write lambda even if it fails the out-of-sample gate")
    args = ap.parse_args()

    cfg = EngineConfig.load()
    obs = load_observations(args.observations)
    if not obs:
        print(f"No observations at {args.observations}. The engine appends one "
              f"per settled signal; run it until there are at least "
              f"{cfg.probability.min_calibration_samples}.", file=sys.stderr)
        return 2

    rep = calibrate(obs, cfg.consensus.theta_trigger, folds=args.folds)
    print(json.dumps(rep, indent=1))

    enough = rep["n"] >= cfg.probability.min_calibration_samples
    gate = rep["beatsMarketOutOfSample"] and enough
    if not enough:
        print(f"\n{rep['n']} observations < "
              f"{cfg.probability.min_calibration_samples} required — "
              f"lambda stays 0 and sizing stays flat.")
    elif not rep["beatsMarketOutOfSample"]:
        print("\nFitted lambda does NOT beat the market price out of sample. "
              "That is the answer: the consensus score adds no information "
              "the book does not already have. Refusing to write it.")
    else:
        print(f"\nlambda = {rep['lambda']} beats the book out of sample "
              f"({rep['oosLogLoss']} vs {rep['oosBaselineLogLoss']} log-loss "
              f"over {rep['oosScored']} walk-forward signals).")

    if args.dry_run or not (gate or args.force):
        return 0
    cfg.probability.lam = rep["lambda"]
    cfg.probability.lam_sample_size = rep["n"]
    cfg.probability.lam_fitted_at = int(time.time())
    cfg.save()
    print(f"Wrote lambda to {CONFIG_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
