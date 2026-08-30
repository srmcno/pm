#!/usr/bin/env python3
"""Performance statistics, written to make overfitting visible.

The system this replaces selected a configuration from a 216-point grid on
five days of data, reported +0.38%, and then lost 4.2% over 239 live paper
trades. Nothing was miscoded — the search found noise and the report had no
way to say so. Every statistic here exists to prevent a repeat:

  * `t_stat` / `p_value` — is the mean return distinguishable from zero at all?
  * `deflated_sharpe` — after searching N configurations, how much of the best
    Sharpe is explained by the search itself? A grid of 216 on a short sample
    has an expected maximum Sharpe well above zero from luck alone.
  * `min_track_record_length` — how long must the record be before the Sharpe
    is credible? If it exceeds the sample, the result is not evidence yet.
  * `vs_benchmark` — a crypto desk that returns 30% in a year bitcoin doubled
    has not found an edge; it has found expensive beta.

A desk that cannot beat these is not armed. That is the entire point.
"""
import math
import statistics as st
from dataclasses import dataclass, asdict, field

SQRT_252 = 252 ** 0.5
SQRT_365 = 365 ** 0.5


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    """Inverse normal CDF (Acklam's rational approximation, ~1e-9 accurate)."""
    if not 0.0 < p < 1.0:
        return float("nan")
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


@dataclass
class Stats:
    """One record's performance. `periods_per_year` makes daily and
    intraday records comparable."""
    n: int = 0
    total_return_pct: float = 0.0
    cagr_pct: float = 0.0
    ann_vol_pct: float = 0.0
    sharpe: float = 0.0
    sortino: float = 0.0
    max_drawdown_pct: float = 0.0
    calmar: float = 0.0
    win_rate_pct: float = 0.0
    profit_factor: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    exposure_pct: float = 0.0
    turnover_ann: float = 0.0
    t_stat: float = 0.0
    p_value: float = 1.0
    deflated_sharpe: float = 0.0
    min_track_record_days: float = 0.0
    skew: float = 0.0
    kurtosis: float = 0.0
    worst_period_pct: float = 0.0
    best_period_pct: float = 0.0
    verdict: str = "insufficient-data"
    notes: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


def _moments(rets):
    n = len(rets)
    m = sum(rets) / n
    var = sum((r - m) ** 2 for r in rets) / n
    sd = math.sqrt(var)
    if sd <= 0:
        return m, 0.0, 0.0, 3.0
    skew = sum((r - m) ** 3 for r in rets) / n / sd ** 3
    kurt = sum((r - m) ** 4 for r in rets) / n / sd ** 4
    return m, sd, skew, kurt


def max_drawdown(equity_curve):
    """Deepest peak-to-trough fraction of an equity curve (negative)."""
    peak, mdd = None, 0.0
    for v in equity_curve:
        if v <= 0:
            continue
        peak = v if peak is None else max(peak, v)
        mdd = min(mdd, v / peak - 1.0)
    return mdd


def deflated_sharpe(sharpe, n, skew, kurt, n_trials=1, periods_per_year=252):
    """Probability the observed Sharpe beats what a search of `n_trials`
    would produce by luck (Bailey & Lopez de Prado, 2014).

    Returns a probability in [0,1]. Below ~0.95 means the result is not
    distinguishable from the best of N random tries. This is the statistic
    the old grid search needed and did not have.
    """
    if n < 10 or sharpe == 0:
        return 0.0
    sr = sharpe / math.sqrt(periods_per_year)           # per-period
    trials = max(1, int(n_trials))
    if trials > 1:
        # expected max Sharpe of `trials` independent draws from N(0,1)
        e = 0.5772156649015329
        z1 = _norm_ppf(1 - 1.0 / trials)
        z2 = _norm_ppf(1 - 1.0 / (trials * math.e))
        sr0 = (1 - e) * z1 + e * z2
        sr0 /= math.sqrt(n)                             # scale to sample size
    else:
        sr0 = 0.0
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr))
    z = (sr - sr0) * math.sqrt(max(1, n - 1)) / denom
    return _norm_cdf(z)


def min_track_record_length(sharpe, skew, kurt, target_sharpe=0.0,
                            confidence=0.95, periods_per_year=252):
    """Periods needed before a Sharpe of this size beats `target_sharpe`
    at the given confidence. If this exceeds the sample, say so out loud."""
    sr = sharpe / math.sqrt(periods_per_year)
    tgt = target_sharpe / math.sqrt(periods_per_year)
    if sr <= tgt:
        return float("inf")
    z = _norm_ppf(confidence)
    num = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
    return 1 + num * (z / (sr - tgt)) ** 2


def compute(returns, equity_curve=None, periods_per_year=252, n_trials=1,
            turnover=0.0, exposure=1.0, benchmark_returns=None):
    """Full statistics for a return series.

    `returns` are per-period fractional returns of the strategy's EQUITY,
    not per-trade P&L — so idle periods count against the Sharpe, which is
    the honest treatment for a desk that only trades sometimes.
    """
    s = Stats()
    rets = [r for r in returns if r is not None and math.isfinite(r)]
    s.n = len(rets)
    if s.n < 3:
        s.notes.append("fewer than 3 periods — no statistics computed")
        return s

    if equity_curve is None:
        equity_curve, e = [], 1.0
        for r in rets:
            e *= (1 + r)
            equity_curve.append(e)

    mean, sd, skew, kurt = _moments(rets)
    s.skew, s.kurtosis = round(skew, 3), round(kurt, 3)
    total = equity_curve[-1] / (equity_curve[0] / (1 + rets[0])) - 1 if equity_curve else 0.0
    total = (equity_curve[-1] / equity_curve[0] - 1) if len(equity_curve) > 1 else 0.0
    s.total_return_pct = round(total * 100, 4)
    years = s.n / periods_per_year
    if years > 0 and equity_curve[-1] > 0 and equity_curve[0] > 0:
        s.cagr_pct = round(((equity_curve[-1] / equity_curve[0]) ** (1 / years) - 1) * 100, 3)
    s.ann_vol_pct = round(sd * math.sqrt(periods_per_year) * 100, 3)
    s.sharpe = round(mean / sd * math.sqrt(periods_per_year), 3) if sd > 0 else 0.0

    downside = [r for r in rets if r < 0]
    dsd = math.sqrt(sum(r * r for r in downside) / len(rets)) if downside else 0.0
    s.sortino = round(mean / dsd * math.sqrt(periods_per_year), 3) if dsd > 0 else 0.0

    s.max_drawdown_pct = round(max_drawdown(equity_curve) * 100, 3)
    s.calmar = round(s.cagr_pct / abs(s.max_drawdown_pct), 3) if s.max_drawdown_pct < 0 else 0.0

    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r < 0]
    s.win_rate_pct = round(100 * len(wins) / s.n, 2)
    s.avg_win = round(st.mean(wins), 6) if wins else 0.0
    s.avg_loss = round(st.mean(losses), 6) if losses else 0.0
    gross_win, gross_loss = sum(wins), -sum(losses)
    s.profit_factor = round(gross_win / gross_loss, 3) if gross_loss > 0 else 0.0
    s.worst_period_pct = round(min(rets) * 100, 3)
    s.best_period_pct = round(max(rets) * 100, 3)
    s.exposure_pct = round(exposure * 100, 2)
    s.turnover_ann = round(turnover, 2)

    # significance
    se = sd / math.sqrt(s.n) if sd > 0 else 0.0
    s.t_stat = round(mean / se, 3) if se > 0 else 0.0
    s.p_value = round(2 * (1 - _norm_cdf(abs(s.t_stat))), 5)
    s.deflated_sharpe = round(deflated_sharpe(s.sharpe, s.n, skew, kurt,
                                              n_trials, periods_per_year), 4)
    mtrl = min_track_record_length(s.sharpe, skew, kurt,
                                   periods_per_year=periods_per_year)
    s.min_track_record_days = round(mtrl, 1) if math.isfinite(mtrl) else float("inf")

    if benchmark_returns:
        bm = [r for r in benchmark_returns if r is not None and math.isfinite(r)]
        if len(bm) >= 3:
            bmean, bsd, _, _ = _moments(bm)
            bsharpe = bmean / bsd * math.sqrt(periods_per_year) if bsd > 0 else 0.0
            s.notes.append(
                f"benchmark Sharpe {bsharpe:.2f} vs strategy {s.sharpe:.2f}; "
                f"benchmark total {(math.prod(1 + r for r in bm) - 1) * 100:.1f}%")
            if s.sharpe <= bsharpe:
                s.notes.append("does NOT beat the benchmark on risk-adjusted terms")

    s.verdict = _verdict(s)
    return s


def _verdict(s: Stats) -> str:
    """One word a human can act on. Deliberately hard to pass."""
    if s.n < 30:
        return "insufficient-data"
    if s.sharpe <= 0 or s.total_return_pct <= 0:
        return "unprofitable"
    if s.p_value > 0.10:
        return "not-significant"
    if s.deflated_sharpe < 0.90:
        return "likely-overfit"
    if math.isfinite(s.min_track_record_days) and s.min_track_record_days > s.n:
        return "too-short-to-judge"
    if s.sharpe < 0.5:
        return "weak"
    if s.max_drawdown_pct < -40:
        return "too-volatile"
    return "validated"


def summarize(stats: Stats) -> str:
    """One dense human-readable line."""
    return (f"n={stats.n} ret={stats.total_return_pct:+.2f}% cagr={stats.cagr_pct:+.1f}% "
            f"sharpe={stats.sharpe:.2f} maxDD={stats.max_drawdown_pct:.1f}% "
            f"p={stats.p_value:.4f} dsr={stats.deflated_sharpe:.2f} -> {stats.verdict}")
