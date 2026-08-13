#!/usr/bin/env python3
"""Specialty-weighted consensus: from a set of tracked fills to one number.

The engine replaces "three wallets bought it" with a weighted vote in which a
wallet only speaks about markets it has actually proven itself in, and in
which no single wallet can carry a motion alone.

    W_i        vote weight of backer i, in [0, 1]
    v_i        that vote after conviction and recency decay
    Sigma      sum of v_i on the winning side  -- the Consensus Score
    N_eff      (Sigma^2) / sum(v_i^2)          -- effective backer count

A signal fires only when Sigma >= Theta AND N_eff >= the minimum. The second
condition is the one that matters: Sigma alone is a sum, and a sum is trivially
cleared by one large term. Requiring the inverse-Herfindahl count to reach ~2
forces the mass to be spread across genuinely independent wallets, which is
what the original three-backer rule was actually trying to express.

Two weight modes are available:

  raw     W_i = WinRate_cat x log10(PnL_90d) x Sharpe, exactly as specified.
  robust  W_i = (skill x scale x consistency)^(1/3), each term in [0, 1].

`raw` is kept so the two can be compared on the same signals, but it is not
the default, and measured against the cohort in data/analyzed.json it fails
three ways: log10(PnL) is undefined for the 77 of 235 wallets whose 90-day PnL
is <= 0; a negative Sharpe (47 of 192 wallets) flips a vote's sign so a bad
trader's buy counts as a sell; and the unbounded product spans more than two
orders of magnitude, so the single largest wallet outvotes every other backer
combined. `robust` keeps the multiplicative intent -- a wallet must be good on
all three axes, not merely enormous on one -- via a geometric mean, which is
bounded, monotone in each term, and still collapses toward zero when any one
of them does.
"""
import math

from .config import ConsensusConfig, ProbabilityConfig, WeightConfig

LN2 = math.log(2.0)


# ------------------------------------------------------------------ scalars

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def logit(p, eps=1e-6):
    p = clamp(p, eps, 1 - eps)
    return math.log(p / (1 - p))


def expit(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def beta_shrink(successes, trials, prior_mean, prior_strength):
    """Posterior mean of a Beta-Binomial. A wallet with 4 wins from 5 trades
    in a category is not an 80% trader; this says so."""
    if trials <= 0:
        return prior_mean
    a = prior_mean * prior_strength
    b = (1.0 - prior_mean) * prior_strength
    return (successes + a) / (trials + a + b)


def mean_shrink(value, n, prior_mean, prior_n):
    """Shrink any sample mean toward a prior by sample size."""
    if n <= 0:
        return prior_mean
    return (value * n + prior_mean * prior_n) / (n + prior_n)


# ------------------------------------------------------------- vote weight

def _skill_term(prof, category, cfg: WeightConfig):
    """Category skill in [0, 1], blending price-adjusted ROI with win rate.

    Win rate alone is not skill: buying 92c favorites wins ~92% of the time
    and earns nothing after fees. ROI per dollar staked is what pays, so it
    carries most of the blend, with win rate as the stability term.
    """
    cat = (prof.get("categories") or {}).get(category)
    if not cat:
        return None
    n = cat.get("settledTrades") or 0
    if n < cfg.min_category_trades:
        return None

    base_wr = cat.get("cohortWinRate", 0.5)
    wr = beta_shrink(cat.get("wins") or 0, n, base_wr, cfg.winrate_prior_trades)
    # Lift over the category's own base rate, not over 50%: a category where
    # everyone buys favorites has a high base rate that is worth nothing.
    wr_term = clamp((wr - base_wr) / max(1e-6, 1.0 - base_wr), 0.0, 1.0)

    roi = mean_shrink(cat.get("roi") or 0.0, n,
                      cat.get("cohortRoi", 0.0), cfg.winrate_prior_trades)
    roi_term = clamp(roi / max(1e-9, cfg.roi_reference), 0.0, 1.0)

    return clamp(cfg.roi_blend * roi_term + (1 - cfg.roi_blend) * wr_term,
                 cfg.term_floor, 1.0)


def _scale_term(prof, cfg: WeightConfig):
    """Bounded stand-in for log10(PnL): credit for having made real money,
    saturating at pnl_reference so size alone cannot buy votes."""
    pnl = prof.get("pnl90") or 0.0
    if pnl <= 0:
        return 0.0
    lo, hi = math.log10(cfg.pnl_floor), math.log10(cfg.pnl_reference)
    z = (math.log10(max(pnl, 1.0)) - lo) / max(1e-9, hi - lo)
    return clamp(z, 0.0, 1.0)


def _consistency_term(prof, cfg: WeightConfig):
    """Shrunk, clamped Sharpe in [0, 1]. Negative Sharpe means no credit --
    never a negative weight, which would silently invert the wallet's vote."""
    n = prof.get("pnlDays") or 0
    if n < cfg.min_pnl_days:
        return cfg.term_floor
    sh = (prof.get("sharpe") or 0.0) * (n / (n + cfg.sharpe_shrink_days))
    return clamp(sh / max(1e-9, cfg.sharpe_reference), cfg.term_floor, 1.0)


def vote_weight(prof, category, cfg: WeightConfig):
    """W_i for one backer in one category. None means "not qualified here"."""
    if prof.get("excluded"):
        return None
    share = (prof.get("categoryShare") or {}).get(category, 0.0)
    if share < prof.get("_specialty_min_share", 0.0):
        return None                       # outside their verified specialty

    if cfg.mode == "raw":
        cat = (prof.get("categories") or {}).get(category) or {}
        n = cat.get("settledTrades") or 0
        if n < cfg.min_category_trades:
            return None
        pnl, sh = prof.get("pnl90") or 0.0, prof.get("sharpe") or 0.0
        if pnl <= 1.0 or sh <= 0:
            return None                   # the spec's formula has no value here
        wr = (cat.get("wins") or 0) / n
        return max(0.0, wr * math.log10(pnl) * sh)

    skill = _skill_term(prof, category, cfg)
    if skill is None:
        return None
    scale = _scale_term(prof, cfg)
    if scale <= 0:
        return None
    consistency = _consistency_term(prof, cfg)
    # Geometric mean: bounded in [0,1], still collapses when any leg does.
    return (skill * scale * consistency) ** (1.0 / 3.0)


# ------------------------------------------------------------------- votes

def vote_value(weight, conviction, age_h, cfg: ConsensusConfig):
    """W_i scaled by how hard the backer leaned and how fresh the fill is.

    Conviction is normalized so that a stake of 2x the wallet's own median
    trade contributes 1.0 -- the sqrt keeps a 10x outlier from counting ten
    times as loudly as a normal-sized bet.
    """
    if age_h > cfg.max_vote_age_h:
        return 0.0
    conv = clamp(conviction, cfg.min_conviction, cfg.conviction_cap)
    conviction_mult = math.sqrt(conv / 2.0)
    recency_mult = 0.5 ** (age_h / max(1e-9, cfg.vote_half_life_h))
    return weight * conviction_mult * recency_mult


def effective_backers(values):
    """Inverse-Herfindahl count of a weighted vote.

    Three equal votes give 3.0; one vote of 10 alongside two of 0.1 gives
    1.04. This is the anti-whale rail -- it measures how many wallets the
    consensus actually rests on rather than how much weight was summed.
    """
    vals = [v for v in values if v > 0]
    if not vals:
        return 0.0
    s = sum(vals)
    return (s * s) / sum(v * v for v in vals)


def score_side(votes, cfg: ConsensusConfig):
    """Aggregate one side's votes into (Sigma, N_eff, contributions)."""
    vals = [v["value"] for v in votes]
    sigma = sum(vals)
    return sigma, effective_backers(vals)


def passes_consensus(sigma, n_eff, n_backers, cfg: ConsensusConfig):
    """Every reason a candidate is rejected, so the caller can log which."""
    reasons = []
    if sigma < cfg.theta_trigger:
        reasons.append(f"Sigma {sigma:.2f} < Theta {cfg.theta_trigger:.2f}")
    if n_eff < cfg.min_effective_backers:
        reasons.append(f"N_eff {n_eff:.2f} < {cfg.min_effective_backers:.2f} "
                       f"(consensus rests on too few wallets)")
    if n_backers < cfg.min_backers:
        reasons.append(f"{n_backers} backers < {cfg.min_backers}")
    return (not reasons), reasons


# --------------------------------------------------------- drift and edge

def drift_check(p_now, p_entry, cfg):
    """Latency guardrail. Returns (ok, detail).

    Absolute drift is the rule as specified; the log-odds form is what makes
    it correct across the price range. 3c of drift is a 60% relative move at
    a nickel and a 3% move at 90c, so an absolute-only rule waves through
    exactly the cheap-outcome chases that hurt most. Both must pass.
    """
    if p_entry is None or p_now is None:
        return True, {"drift": None, "driftLogit": None}
    d_abs = p_now - p_entry
    d_logit = logit(p_now) - logit(p_entry)
    # The rule is "reject when drift EXCEEDS the limit", so a drift landing
    # exactly on it must pass; binary floating point makes 0.53 - 0.50 a hair
    # over 0.03, which would otherwise reject at the boundary.
    tol = 1e-9
    ok = (d_abs <= cfg.max_drift_abs + tol
          and d_logit <= cfg.max_drift_logit + tol)
    return ok, {
        "drift": round(d_abs, 4),
        "driftLogit": round(d_logit, 4),
        "limitAbs": cfg.max_drift_abs,
        "limitLogit": cfg.max_drift_logit,
    }


def implied_win_probability(price, sigma, cfg: ProbabilityConfig,
                            theta=0.0):
    """Consensus strength -> win probability, in log-odds space.

        logit(w) = logit(p) + lambda * (Sigma - Theta)

    The market price is the prior; the sharps' agreement is the evidence;
    lambda is how much a unit of agreement has historically been worth. It is
    FIT from settled outcomes by calibrate.py, never assumed.

    Returns (w, calibrated). When the fit is missing or thin, w == price:
    zero edge, and Kelly therefore sizes nothing. A Kelly stake computed from
    an invented w is not a bet, it is a leak.
    """
    if cfg.lam == 0.0 or cfg.lam_sample_size < cfg.min_calibration_samples:
        return price, False
    w = expit(logit(price) + cfg.lam * (sigma - theta))
    return clamp(w, max(1e-6, price - cfg.max_edge),
                 min(1 - 1e-6, price + cfg.max_edge)), True


def net_edge(w, fill_price, fee_per_share, extra_cost=0.0):
    """EV per share after everything that is taken out of it.

        EV_net = (w - P_fill) - fee - other costs

    `fill_price` is the depth-walked effective price, so slippage is already
    inside it; `extra_cost` is there for anything the caller wants to charge
    (gas, an exit-fee reserve) without pretending it is slippage.
    """
    return w - fill_price - fee_per_share - extra_cost
