#!/usr/bin/env python3
"""Walk-forward validation — the test the old system never ran.

Its predecessor picked one configuration from a 216-point grid using three
days of training data and two of testing, reported the winner's number, and
armed it. That is not validation; it is choosing the luckiest of 216 coins
after five flips each.

Walk-forward instead: split the history into consecutive folds, fit on each
fold's training window, and score ONLY on the untouched window that follows.
Stitch those out-of-sample windows together and that record — not any
in-sample number — is what the desk gets judged on. Selection happens inside
each fold, so parameters chosen with hindsight cannot leak into the score.

`n_trials` (the grid size) is carried into the statistics so the deflated
Sharpe can discount the search. A desk that only clears the bar before that
discount is a desk that found noise.
"""
import itertools
from dataclasses import dataclass, field

from . import metrics
from .engine import Engine


@dataclass
class Fold:
    index: int
    train_start: int
    train_end: int
    test_start: int
    test_end: int
    chosen_params: dict = field(default_factory=dict)
    train_sharpe: float = 0.0
    test_return_pct: float = 0.0
    test_bars: int = 0


@dataclass
class WalkForwardResult:
    folds: list = field(default_factory=list)
    oos_returns: list = field(default_factory=list)
    oos_equity: list = field(default_factory=list)
    stats: metrics.Stats = None
    n_trials: int = 1
    param_stability: dict = field(default_factory=dict)
    notes: list = field(default_factory=list)
    folds_requested: int = 0

    def to_dict(self):
        return {
            "folds": [f.__dict__ for f in self.folds],
            "stats": self.stats.to_dict() if self.stats else None,
            "nTrials": self.n_trials,
            "paramStability": self.param_stability,
            "notes": self.notes,
        }


def _slice(series, lo, hi):
    return {s: v[lo:hi] for s, v in series.items()}


def _grid_points(grid):
    if not grid:
        return [{}]
    keys = sorted(grid)
    return [dict(zip(keys, combo)) for combo in
            itertools.product(*(grid[k] for k in keys))]


def walk_forward(desk_cls, series, start_equity=1000.0, n_folds=5,
                 train_frac=0.6, grid=None, engine_kw=None,
                 select_on="sharpe", min_train_bars=120):
    """Rolling-origin walk-forward over aligned bar history.

    Each fold trains on `train_frac` of its window and tests on the rest,
    with the window sliding forward so every test period is strictly after
    its training period. Returns the stitched out-of-sample record.
    """
    engine_kw = engine_kw or {}
    probe = getattr(metrics.Stats(), select_on, None)
    if not isinstance(probe, (int, float)) or isinstance(probe, bool):
        raise ValueError(f"select_on={select_on!r} is not a numeric Stats field")
    grid = grid if grid is not None else desk_cls.param_grid()
    points = _grid_points(grid)
    length = min(len(v) for v in series.values()) if series else 0

    res = WalkForwardResult(n_trials=max(1, len(points)))
    if length < min_train_bars + 40:
        res.notes.append(f"history too short for walk-forward: {length} bars")
        res.stats = metrics.Stats(notes=res.notes)
        return res

    # Contiguous, non-overlapping windows tiling the series. The FIRST
    # window is the training prefix and is never scored — there is nothing
    # before it to train on — so `n_folds` windows yield `n_folds - 1`
    # out-of-sample folds. The result says so explicitly (foldsScored).
    usable = length
    fold_len = usable // n_folds
    if fold_len < 30:
        n_folds = max(2, usable // 60)
        fold_len = usable // n_folds
    res.folds_requested = n_folds

    chosen_counts = {}
    for k in range(n_folds):
        test_start = usable - (n_folds - k) * fold_len
        test_end = test_start + fold_len
        train_end = test_start
        train_start = max(0, train_end - max(min_train_bars,
                                             int(fold_len * train_frac / (1 - train_frac))))
        if train_end - train_start < min_train_bars:
            continue

        train = _slice(series, train_start, train_end)
        best, best_score = None, None
        for params in points:
            desk = desk_cls(**params)
            eng = Engine(desk, train, start_equity=start_equity, **engine_kw)
            r = eng.run()
            if not r.returns:
                continue
            st = metrics.compute(r.returns,
                                 equity_curve=[e for _, e in r.equity_curve],
                                 periods_per_year=desk.meta.periods_per_year)
            score = getattr(st, select_on)
            if best_score is None or score > best_score:
                best, best_score = params, score
        if best is None:
            continue

        # Test on the untouched window, warming the desk on prior bars so the
        # first test decision is not made from an empty history.
        warm = desk_cls().meta.warmup_bars
        ctx_start = max(0, test_start - warm)
        test = _slice(series, ctx_start, test_end)
        desk = desk_cls(**best)
        eng = Engine(desk, test, start_equity=start_equity, **engine_kw)
        r = eng.run()
        # The replay scores from its own warm-up point inside the slice;
        # anything before test_start is a training bar and is dropped, so
        # every scored return is strictly out of sample.
        first_scored = ctx_start + max(warm, 2)
        skip = max(0, test_start - first_scored)
        returns = r.returns[skip:]
        curve = r.equity_curve[skip:]

        fold = Fold(index=k, train_start=train_start, train_end=train_end,
                    test_start=test_start, test_end=test_end,
                    chosen_params=best, train_sharpe=round(best_score or 0, 3),
                    test_bars=len(returns))
        if returns and curve:
            base = r.equity_curve[skip - 1][1] if skip > 0 else start_equity
            fold.test_return_pct = round((curve[-1][1] / base - 1) * 100, 3)
            res.oos_returns.extend(returns)
        res.folds.append(fold)
        key = tuple(sorted(best.items()))
        chosen_counts[key] = chosen_counts.get(key, 0) + 1

    if not res.oos_returns:
        res.notes.append("no out-of-sample returns produced")
        res.stats = metrics.Stats(notes=res.notes)
        return res

    eq, curve = start_equity, []
    for r in res.oos_returns:
        eq *= (1 + r)
        curve.append(eq)
    res.oos_equity = curve
    ppy = desk_cls().meta.periods_per_year
    res.stats = metrics.compute(res.oos_returns, equity_curve=curve,
                                periods_per_year=ppy, n_trials=res.n_trials)
    res.param_stability = {
        "distinctWinners": len(chosen_counts),
        "folds": len(res.folds),
        "foldsRequested": res.folds_requested,
        "foldsScored": len(res.folds),
        "mostCommon": (dict(max(chosen_counts.items(), key=lambda kv: kv[1])[0])
                       if chosen_counts else None),
    }
    if res.folds_requested and len(res.folds) < res.folds_requested:
        res.notes.append(
            f"{res.folds_requested} windows requested; the first is the training "
            f"prefix, so {len(res.folds)} were scored out of sample")
    if len(chosen_counts) == len(res.folds) and len(res.folds) > 2:
        res.notes.append(
            "every fold chose different parameters — the surface is unstable, "
            "treat any single configuration as noise")
    return res
