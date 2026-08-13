#!/usr/bin/env python3
"""Fractional Kelly sizing, and every rail that overrides it.

The specified sizing rule is

    f* = gamma * (w - p) / (1 - p)

which is Kelly for a binary contract bought at p that pays 1. This module
implements the fee-aware generalization

    b  = ((1 - phi_exit) - c) / c          net odds, c = effective cost/share
    f* = (w*b - (1 - w)) / b               Kelly
    f  = gamma * f*

and reduces exactly to the specified form when costs and fees are zero. The
difference is not cosmetic: at a 90c entry the naive form claims odds of
0.111 while a 2c round trip makes the true odds 0.089, and Kelly is a ratio
of those -- so ignoring costs oversizes by ~25% on precisely the favorite
trades this strategy takes most.

Kelly is the ceiling of what is rational, never the target. Every stake here
is the minimum of the Kelly number and a stack of exposure rails, and the
binding one is always named in the returned decision so the journal records
why a trade was the size it was.
"""
import math
from dataclasses import dataclass, field

from .config import SizingConfig


@dataclass
class Portfolio:
    """The state sizing needs. Bankroll is cash PLUS marked open positions:
    sizing off cash alone silently shrinks every bet as the book fills up."""

    cash: float
    positions: list = field(default_factory=list)   # dicts with value/cluster
    spent_today: float = 0.0

    @property
    def deployed(self):
        return sum(p.get("value", p.get("cost", 0.0)) for p in self.positions)

    @property
    def bankroll(self):
        return self.cash + self.deployed

    def exposure(self, key, value):
        return sum(p.get("value", p.get("cost", 0.0))
                   for p in self.positions if p.get(key) == value)


@dataclass
class SizingDecision:
    stake: float
    shares: float
    kelly_fraction: float
    limit_price: float
    binding: str
    detail: dict

    @property
    def ok(self):
        return self.stake > 0


def min_viable_bankroll(price, cfg: SizingConfig):
    """Smallest bankroll at which a max-size position can legally be placed.

    Two constraints collide at small size: the exchange will not accept an
    order under `min_shares`, and the risk rule will not accept a position
    over `max_position_frac` of bankroll. Together they require

        min_shares * price <= max_position_frac * B

    so at a 5% cap and a 5-share floor the bankroll must be at least 100x the
    price -- $56 to buy a 56c outcome, $90 to buy a 90c one. Below that the
    engine cannot place a single order and would sit silent forever, which is
    a far worse failure than refusing at startup.
    """
    return cfg.min_shares * price / max(1e-9, cfg.max_position_frac)


def tradable_price_ceiling(bankroll, cfg: SizingConfig):
    """The most expensive outcome this bankroll can size a position in."""
    if cfg.min_shares <= 0:
        return 1.0
    return min(1.0, cfg.max_position_frac * bankroll / cfg.min_shares)


def kelly_fraction(w, cost_per_share, exit_fee_per_share=0.0):
    """Full-Kelly bankroll fraction for a binary payoff. 0 when there is no
    edge -- never negative, since this engine does not short."""
    c = cost_per_share
    payout = 1.0 - exit_fee_per_share
    if c <= 0 or payout <= c:
        return 0.0                       # paying more than the thing can pay
    b = (payout - c) / c
    f = (w * b - (1.0 - w)) / b
    return max(0.0, f)


def correlation_haircut(n_related, rho=0.5):
    """Scale Kelly down for bets that are not independent.

    Kelly is additive across independent opportunities and badly oversized
    across correlated ones. Three props on the same game are close to one bet
    with three times the stake; this divides by 1 + rho*(n-1), the standard
    approximation, so the third leg of a cluster gets half the first leg's
    size rather than the same.
    """
    if n_related <= 0:
        return 1.0
    return 1.0 / (1.0 + rho * n_related)


def size_position(w, price, fill_price, portfolio: Portfolio, cfg: SizingConfig,
                  *, entry_fee=0.0, exit_fee=0.0, cluster=None, category=None,
                  depth_notional=None, calibrated=True):
    """Turn an edge into a stake, or explain why it is zero.

    `price` is top of book, `fill_price` the depth-walked effective cost
    before fees. Rails are applied in the order that makes the binding
    constraint meaningful to read in a journal.
    """
    B = portfolio.bankroll
    detail = {"bankroll": round(B, 2), "w": round(w, 4),
              "price": round(price, 4), "fill": round(fill_price, 4)}

    if B <= 0:
        return SizingDecision(0, 0, 0, fill_price, "bankroll is zero", detail)

    cost = fill_price + entry_fee
    f_star = kelly_fraction(w, cost, exit_fee)
    detail["kellyFull"] = round(f_star, 5)

    if f_star <= 0:
        return SizingDecision(0, 0, 0, fill_price, "no edge after costs", detail)

    f = cfg.kelly_fraction * f_star
    n_related = sum(1 for p in portfolio.positions
                    if cluster and p.get("cluster") == cluster)
    haircut = correlation_haircut(n_related)
    f *= haircut
    detail["kellyFractional"] = round(f, 5)
    detail["correlationHaircut"] = round(haircut, 3)

    # Every rail as an absolute dollar ceiling, so the min() names itself.
    caps = [("fractional Kelly", f * B),
            ("max position 5% of bankroll", cfg.max_position_frac * B),
            ("per-trade dollar cap", cfg.max_stake_usd)]
    if cluster is not None:
        caps.append(("correlated-event cluster cap",
                     cfg.max_cluster_frac * B - portfolio.exposure("cluster", cluster)))
    if category is not None:
        caps.append(("category cap",
                     cfg.max_category_frac * B - portfolio.exposure("category", category)))
    caps.append(("cash reserve floor",
                 portfolio.cash - cfg.cash_reserve_frac * B))
    caps.append(("daily deployment cap",
                 cfg.max_daily_deploy_frac * B - portfolio.spent_today))
    if depth_notional is not None:
        caps.append(("book depth participation",
                     cfg.max_depth_participation * depth_notional))

    if len(portfolio.positions) >= cfg.max_open_positions:
        caps.append(("max open positions", 0.0))
    if not calibrated:
        # Without a fitted consensus->probability map there is no trustworthy
        # w, so Kelly is meaningless. Trade the floor size or nothing at all.
        caps.append(("uncalibrated: flat minimum stake", cfg.min_stake_usd))

    binding, stake = min(caps, key=lambda kv: kv[1])
    detail["caps"] = {k: round(v, 4) for k, v in caps}

    # Every rejection below still names the rail that set the ceiling: the
    # exchange minimum is only ever the proximate cause, and a journal that
    # records it alone hides which risk limit actually did the binding.
    if stake < cfg.min_stake_usd:
        return SizingDecision(0, 0, f, fill_price,
                              f"{binding} → ${stake:.2f} below the "
                              f"${cfg.min_stake_usd:.2f} minimum stake", detail)

    shares = math.floor((stake / max(fill_price, 1e-9)) * 100) / 100
    if shares < cfg.min_shares:
        return SizingDecision(0, 0, f, fill_price,
                              f"{binding} → {shares:.2f} shares below "
                              f"exchange minimum {cfg.min_shares:g}", detail)
    stake = round(shares * fill_price, 2)
    # Re-check: the share rounding must not push us back through a rail.
    if stake > min(v for _, v in caps) + 0.01:
        return SizingDecision(0, 0, f, fill_price,
                              f"share minimum busts {binding}", detail)

    return SizingDecision(round(stake, 2), shares, f, fill_price, binding, detail)
