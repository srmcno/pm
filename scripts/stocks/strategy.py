#!/usr/bin/env python3
"""Signal engine: crypto lead-lag into digital-asset proxy equities.

The tradable universe consists of US equities whose intraday price is largely
a function of a crypto reference asset that trades 24/7 on venues this stack
already monitors in real time. The signal is the residual between what the
equity did and what its crypto driver implies it should have done:

    d(t) = r_stock(anchor -> t) - beta * r_crypto(anchor -> t)

Crypto prints continuously and with lower latency than the equity tape
reprices the proxies, so a large residual is usually the equity lagging its
driver rather than independent information. The desk trades convergence:
long when the equity lags an up-move (d below -entry), short when it lags a
down-move (d above +entry), exit on reversion, adverse widening, time, or
the session close. A second, open-only model trades the unpriced portion of
the overnight crypto move at the opening print.

Beta is estimated from daily closes (OLS on log returns, clamped), refit at
most once per session. All thresholds are in basis points and configurable
in data/stocks/config.json.
"""
import math
import time
from dataclasses import asdict, dataclass, field

from . import stocklib

# driver, floor/ceiling for the fitted beta, and a per-symbol spread
# estimate in bps used by the fill simulator and the entry economics.
UNIVERSE = {
    "MSTR": {"driver": "BTCUSDT", "betaBounds": (1.0, 4.0), "spreadBps": 4},
    "COIN": {"driver": "BTCUSDT", "betaBounds": (0.6, 3.0), "spreadBps": 4},
    "MARA": {"driver": "BTCUSDT", "betaBounds": (0.8, 3.5), "spreadBps": 8},
    "RIOT": {"driver": "BTCUSDT", "betaBounds": (0.8, 3.5), "spreadBps": 8},
    "IBIT": {"driver": "BTCUSDT", "betaBounds": (0.8, 1.2), "spreadBps": 2},
    "ETHA": {"driver": "ETHUSDT", "betaBounds": (0.8, 1.2), "spreadBps": 4},
}


@dataclass
class StrategyConfig:
    # Defaults selected by a 216-config grid on 5 days of 1-minute bars
    # (train on the first 3 sessions, score on the held-out last 2) and
    # confirmed on 22 sessions of 5-minute bars with the driver aligned to
    # each bar's close and fills at the next bar's open (dislocations seen
    # up to ~300s late). This configuration is positive in all three views
    # — train +$6.02 and held-out +$1.02 per $1000 on the 1m window, +1.01%
    # over 50 trades in the month stress — with a worst stress day of
    # -$4.54. The tighter 90bps/20-minute variant scored +1.13% in the
    # stress but lost money on the held-out sessions. The edge decays
    # within minutes, which is why entries are gated on quote freshness.
    entry_bps: float = 75.0          # |d| to open
    exit_bps: float = 12.0           # |d| to close on reversion
    stop_bps: float = 70.0           # adverse widening beyond entry level
    min_driver_move_bps: float = 25.0  # required |beta * crypto move|
    # Rolling anchor: dislocation is measured over this trailing window.
    # Anchoring at the session open let idiosyncratic drift accumulate all
    # day and stopped out 260 of 288 replay trades.
    anchor_minutes: float = 20.0
    max_hold_minutes: float = 45.0
    flatten_minutes_before_close: float = 5.0
    slippage_bps: float = 3.0        # paid on top of half the spread
    # Entries require a quote at most this old. The replay evidence puts the
    # whole edge inside the first couple of minutes, so trading on a stale
    # quote is donating the spread.
    max_quote_age_s: float = 20.0
    risk_frac: float = 0.20          # of equity per position
    max_positions: int = 3
    max_daily_loss_frac: float = 0.04  # halt for the day past this drawdown
    poll_seconds: float = 12.0
    beta_lookback_days: int = 60
    # Minimum daily-return R^2 against the driver. Fitted values on live
    # data: IBIT/ETHA 0.89, MSTR/COIN ~0.53, MARA 0.18, RIOT 0.08 — below
    # this line the "driver" explains too little of the equity's variance
    # for a dislocation to mean anything.
    min_beta_r2: float = 0.25

    @classmethod
    def load(cls):
        cfg = cls()
        raw = stocklib.load_state("config.json", {})
        for k, v in raw.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg

    def save(self):
        stocklib.save_state("config.json", asdict(self))


class RollingTape:
    """Recent (timestamp, price) history per instrument, for anchor lookups.

    Both the live desk and the backtest push prices in as they see them and
    read the value as of an earlier instant; keeping one implementation is
    what makes the replay test the same arithmetic the desk trades."""

    def __init__(self, keep_seconds=7200):
        self.keep = keep_seconds
        self.series = {}

    def record(self, key, ts, price):
        s = self.series.setdefault(key, [])
        if s and ts <= s[-1][0]:
            return
        s.append((int(ts), float(price)))
        cutoff = ts - self.keep
        while s and s[0][0] < cutoff:
            s.pop(0)

    def at(self, key, ts):
        """Latest recorded price at or before ts."""
        import bisect
        s = self.series.get(key)
        if not s:
            return None
        i = bisect.bisect_right(s, (int(ts), float("inf")))
        return s[i - 1][1] if i else None


# ------------------------------------------------------------------ betas

def fit_beta(stock_closes, crypto_closes, bounds):
    """OLS slope of stock daily log returns on driver daily log returns.

    Crypto trades weekends; only dates present on both sides are used.
    Returns (beta, n_observations, r_squared)."""
    s_days = {t // 86400: c for t, c in stock_closes.items()}
    c_days = {t // 86400: c for t, c in crypto_closes.items()}
    days = sorted(set(s_days) & set(c_days))
    xs, ys = [], []
    for a, b in zip(days, days[1:]):
        if b - a > 5:
            continue
        try:
            ys.append(math.log(s_days[b] / s_days[a]))
            xs.append(math.log(c_days[b] / c_days[a]))
        except (ValueError, ZeroDivisionError):
            continue
    n = len(xs)
    if n < 20:
        return None, n, 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx <= 0:
        return None, n, 0.0
    beta = sxy / sxx
    syy = sum((y - my) ** 2 for y in ys)
    r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0.0
    lo, hi = bounds
    return max(lo, min(hi, beta)), n, r2


def fit_all_betas(cfg: StrategyConfig):
    """Fit and persist betas for the whole universe. Refit at most daily."""
    state = stocklib.load_state("betas.json", {})
    today = time.strftime("%Y-%m-%d")
    if state.get("date") == today and state.get("betas"):
        return state["betas"]
    crypto_cache = {}
    betas = {}
    for sym, meta in UNIVERSE.items():
        drv = meta["driver"]
        if drv not in crypto_cache:
            crypto_cache[drv] = stocklib.crypto_daily_closes(
                drv, days=cfg.beta_lookback_days + 10)
        sc = stocklib.daily_closes(sym)
        beta, n, r2 = fit_beta(sc, crypto_cache[drv], meta["betaBounds"])
        if beta is None:
            beta = sum(meta["betaBounds"]) / 2.0
        betas[sym] = {"beta": round(beta, 3), "n": n, "r2": round(r2, 3)}
    stocklib.save_state("betas.json", {"date": today, "betas": betas})
    return betas


# ----------------------------------------------------------------- signal

@dataclass
class Snapshot:
    """One evaluation of one symbol against its driver."""
    symbol: str
    price: float
    driver: str
    driver_price: float
    beta: float
    dislocation_bps: float
    driver_move_bps: float          # beta-scaled driver move since anchor
    anchor: str                      # 'open' | 'gap'
    action: str = "none"             # 'long' | 'short' | 'none'
    reason: str = ""


def evaluate(symbol, price, anchor_price, driver_price, driver_anchor_price,
             beta, cfg: StrategyConfig, spread_bps):
    """Dislocation of one symbol vs its driver since a common anchor."""
    if not all(x and x > 0 for x in
               (price, anchor_price, driver_price, driver_anchor_price)):
        return None
    r_stock = math.log(price / anchor_price)
    r_drv = math.log(driver_price / driver_anchor_price)
    d_bps = (r_stock - beta * r_drv) * 1e4
    drv_bps = beta * r_drv * 1e4
    snap = Snapshot(symbol=symbol, price=price, driver="", driver_price=driver_price,
                    beta=beta, dislocation_bps=round(d_bps, 1),
                    driver_move_bps=round(drv_bps, 1), anchor="open")
    # Entry economics: the reversion must clear the round trip.
    cost_bps = spread_bps + 2 * cfg.slippage_bps
    entry = max(cfg.entry_bps, cost_bps * 1.5)
    if abs(drv_bps) < cfg.min_driver_move_bps:
        snap.reason = "driver move below threshold"
        return snap
    if d_bps <= -entry and drv_bps > 0:
        snap.action = "long"
        snap.reason = (f"lagging a +{drv_bps:.0f}bps driver move by "
                       f"{-d_bps:.0f}bps")
    elif d_bps >= entry and drv_bps < 0:
        snap.action = "short"
        snap.reason = (f"lagging a {drv_bps:.0f}bps driver move by "
                       f"{d_bps:.0f}bps")
    else:
        snap.reason = "inside entry band"
    return snap


def exit_check(position, d_bps, minutes_held, mins_to_close,
               cfg: StrategyConfig):
    """Exit decision for an open lead-lag position. Returns reason or None.

    Sign convention: a long was opened at d <= -entry; reversion drives d up
    toward 0. Adverse is d falling further."""
    side = 1 if position["side"] == "long" else -1
    adj = d_bps * side                 # negative = still dislocated
    if adj >= -cfg.exit_bps:
        return "reverted"
    if adj <= -(cfg.entry_bps + cfg.stop_bps):
        return "stop"
    if minutes_held >= cfg.max_hold_minutes:
        return "time"
    if mins_to_close <= cfg.flatten_minutes_before_close:
        return "close"
    return None
