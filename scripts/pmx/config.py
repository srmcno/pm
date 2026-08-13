#!/usr/bin/env python3
"""Every tunable the engine has, in one place, with the reasoning attached.

Defaults are calibrated against the 237-wallet cohort in data/analyzed.json
(see docs/ENGINE.md for the distributions each number comes from). A value
without a stated origin is a guess, and guesses that size real orders are how
bankrolls die — so anything unverified is deliberately conservative here.

Load order: DEFAULTS <- data/live/engine.json <- CLI overrides.
"""
import json
import os
from dataclasses import asdict, dataclass, field, fields

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
CONFIG_PATH = os.path.join(BASE, "data", "live", "engine.json")


@dataclass
class WeightConfig:
    """Inputs to the per-backer vote weight W_i."""

    # "robust" bounds every term to [0,1]; "raw" is the literal
    # WinRate x log10(PnL) x Sharpe spec, kept for comparison. Raw is
    # undefined for the 77/235 cohort wallets with PnL <= 0 and lets a single
    # whale outvote a room, so it is not the default.
    mode: str = "robust"

    # --- category skill term -------------------------------------------
    # Beta-Binomial prior strength, in trades. A wallet needs ~this many
    # settled trades in a category before its own record outweighs the
    # cohort base rate for that category.
    winrate_prior_trades: float = 25.0
    # Minimum settled trades in-category before the wallet may vote at all.
    min_category_trades: int = 10
    # Realized ROI per dollar staked that maps to a full-credit skill term.
    # 8% is roughly the 75th percentile of category ROI in the cohort.
    roi_reference: float = 0.08
    # Weight of price-adjusted ROI vs raw win rate in the skill blend.
    # Win rate alone rewards favorite-buying (24 cohort wallets are
    # "Favorite grinder" archetypes that win often and earn little).
    roi_blend: float = 0.65

    # --- scale term -----------------------------------------------------
    # Below pnl_floor a wallet earns no scale credit; at pnl_reference it is
    # saturated. Capping at $1M stops a $17M whale from buying 1.4x the vote
    # of a $1M trader for size alone.
    pnl_floor: float = 25_000.0
    pnl_reference: float = 1_000_000.0

    # --- consistency term -----------------------------------------------
    # Annualized Sharpe of daily PnL deltas, shrunk toward 0 by n/(n+n0).
    # Cohort median is 2.27 and p95 is 13.45 on a mark-to-market series, so
    # the raw number is badly inflated: reference at 3.0 and clamp.
    sharpe_reference: float = 3.0
    sharpe_shrink_days: float = 30.0
    min_pnl_days: int = 20

    # Floor so a wallet strong on two legs is not zeroed by one weak leg.
    term_floor: float = 0.05


@dataclass
class ConsensusConfig:
    """Turning weighted votes into a tradable signal."""

    # Sum of vote weights required. With robust weights each W_i is in
    # [0,1], so this reads as "the equivalent of N flawless specialists".
    #
    # Calibrated against a 24-hour live sample: 28,680 fills from 45 active
    # wallets produced 341 markets with any weighted backing, Sigma peaking
    # at 1.71 (p90 = 1.04, median = 0.27). At the original 1.35 the engine
    # fired once a day; at 0.80 it fires roughly three times, which is the
    # rate that reaches the ~600 settled observations Kelly calibration needs
    # inside a year rather than a decade. Below 0.80 nothing changes, because
    # min_effective_backers becomes the binding rail — only 3 of 341 markets
    # reached N_eff >= 2 at all. Re-check this on your own sample; it is one
    # 24-hour window, not a law.
    theta_trigger: float = 0.80
    # Inverse-Herfindahl effective backer count. This is what makes
    # "consensus" mean consensus: without it one wallet with a huge weight
    # clears any sum threshold by itself.
    min_effective_backers: float = 2.0
    # A hard floor on distinct wallets regardless of weight.
    min_backers: int = 2

    # The winning side must beat the opposing side's weighted score by this
    # much or the market is contested and emits nothing.
    dominance: float = 1.5

    # Conviction: a backer's net stake over their own median trade, capped
    # before the sqrt so one outlier cannot dominate.
    conviction_cap: float = 10.0
    min_conviction: float = 0.5
    min_net_usd: float = 200.0

    # Recency half-life of a vote, in hours.
    vote_half_life_h: float = 6.0
    # Votes older than this never count.
    max_vote_age_h: float = 48.0

    # Only count a wallet's vote in categories where it is a proven
    # specialist: this share of its 90d volume must sit in the category.
    specialty_min_share: float = 0.35


@dataclass
class ProbabilityConfig:
    """Mapping consensus strength to a win probability for Kelly."""

    # logit(w) = logit(p) + lambda * (Sigma - theta), fit by calibrate.py.
    # Until it is fit from real outcomes, lambda is 0 -> w == p -> zero edge
    # -> Kelly sizes nothing. That is intentional: a made-up w is the
    # fastest way to blow up a Kelly-sized book.
    lam: float = 0.0
    lam_fitted_at: int = 0
    lam_sample_size: int = 0
    # Refuse Kelly sizing until the fit has at least this many settled
    # observations; fall back to the flat minimum stake instead.
    min_calibration_samples: int = 150

    # Hard cap on the edge the model may claim, in probability units. Even a
    # perfect fit should not assert a 20-point disagreement with the book.
    max_edge: float = 0.10


@dataclass
class SizingConfig:
    """Fractional Kelly and the rails around it."""

    kelly_fraction: float = 0.25          # gamma
    bankroll: float = 40.0
    max_position_frac: float = 0.05       # per market, of bankroll
    cash_reserve_frac: float = 0.20       # never deploy below this
    max_cluster_frac: float = 0.10        # per correlated event group
    max_category_frac: float = 0.35
    max_open_positions: int = 10
    max_daily_deploy_frac: float = 0.40

    min_stake_usd: float = 1.0
    max_stake_usd: float = 4.0
    # CLOB rejects orders under 5 shares.
    min_shares: float = 5.0
    # Never take more than this share of the resting depth inside our limit;
    # eating a whole book level is how a $4 order moves a market 3 cents.
    max_depth_participation: float = 0.25


@dataclass
class ExecutionConfig:
    """Latency, drift and slippage bounds on the way into the book."""

    # Absolute price drift vs the backers' weighted average entry.
    max_drift_abs: float = 0.03
    # The same guard in log-odds, which is scale-free: 0.03 is a 60% move at
    # 5c and a 3% move at 90c, so the absolute rule alone is far too loose in
    # the tails. Both must pass.
    max_drift_logit: float = 0.20
    # Slippage allowed between top-of-book ask and our effective fill.
    max_slippage: float = 0.01
    max_spread: float = 0.08
    min_price: float = 0.05
    max_price: float = 0.90

    # "FOK" = all-or-nothing at our limit, "FAK" = fill what you can and
    # cancel the rest, "GTC" = rest in the book. FOK is the honest default
    # for copy-trading: a partial fill at a worse average is the edge decay
    # we are trying to eliminate.
    order_type: str = "FOK"
    # Seconds a signal may age between detection and dispatch before it is
    # dropped as stale.
    max_signal_age_s: float = 90.0

    # Fees. Polymarket's schedule has changed over time and is market
    # dependent, so the engine reads fee_rate_bps from the venue when it is
    # available and only falls back to this. Overstating the fee costs
    # trades; understating it silently negates the edge.
    fallback_fee_bps: float = 0.0
    assume_fee_bps_when_unknown: float = 20.0


@dataclass
class ExitConfig:
    """Getting out: profit capture, reversal, and time rails."""

    # Hard take-profit — post a limit sell here regardless of the clock.
    take_profit_price: float = 0.96
    # ...but below the hard level, only sell if continuing to hold earns
    # less than this annualized rate. A 96c position resolving tomorrow is
    # a fantastic annualized return; selling it on a static price rule
    # donates the last cent for no reason.
    hold_hurdle_annualized: float = 2.00
    min_capture_frac: float = 0.70        # of maximum gain, before any TP

    # Consensus reversal: exit when backers whose combined weight reaches
    # this fraction of the original consensus have cut or flipped.
    reversal_weight_frac: float = 0.50
    min_reversal_wallets: int = 2
    # A wallet counts as reversing when it sells this share of its stance or
    # flips its net sign.
    reversal_exit_frac: float = 0.50

    # Stop-loss in log-odds against us; absolute stops in probability space
    # fire far too early on cheap outcomes.
    stop_loss_logit: float = -0.85
    max_hold_days: float = 7.0
    # Never dump into a hole: if the best bid is this far below the mark,
    # ladder out instead of crossing.
    max_exit_concession: float = 0.05


@dataclass
class FeedConfig:
    """Where fills are detected."""

    polygon_ws_url: str = ""              # e.g. wss://polygon-bor-rpc.publicnode.com
    data_api_poll_s: float = 2.0
    clob_ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    # Reconciliation sweep against the REST feed, to catch anything the
    # socket dropped.
    reconcile_s: float = 60.0
    ws_ping_s: float = 8.0
    ws_max_backoff_s: float = 30.0


@dataclass
class EngineConfig:
    weights: WeightConfig = field(default_factory=WeightConfig)
    consensus: ConsensusConfig = field(default_factory=ConsensusConfig)
    probability: ProbabilityConfig = field(default_factory=ProbabilityConfig)
    sizing: SizingConfig = field(default_factory=SizingConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    exits: ExitConfig = field(default_factory=ExitConfig)
    feed: FeedConfig = field(default_factory=FeedConfig)

    @classmethod
    def load(cls, path=CONFIG_PATH):
        cfg = cls()
        try:
            with open(path) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            return cfg
        for f_ in fields(cls):
            section = raw.get(f_.name)
            if not isinstance(section, dict):
                continue
            sub = getattr(cfg, f_.name)
            known = {sf.name for sf in fields(sub)}
            for k, v in section.items():
                if k in known:
                    setattr(sub, k, v)
        return cfg

    def save(self, path=CONFIG_PATH):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(asdict(self), f, indent=1)

    def validate(self):
        """Fail loudly on a config that would trade badly, before it trades."""
        e = []
        s, x, p = self.sizing, self.execution, self.probability
        if not 0 < s.kelly_fraction <= 1:
            e.append("sizing.kelly_fraction must be in (0, 1]")
        if s.kelly_fraction > 0.5:
            e.append("sizing.kelly_fraction above 0.5 is past the growth "
                     "optimum on any estimation error — refusing")
        if not 0 <= s.cash_reserve_frac < 1:
            e.append("sizing.cash_reserve_frac must be in [0, 1)")
        if s.max_position_frac > 1 - s.cash_reserve_frac:
            e.append("sizing.max_position_frac exceeds the deployable fraction")
        if s.max_position_frac > s.max_cluster_frac:
            e.append("sizing.max_cluster_frac must be >= max_position_frac")
        if not 0 < x.max_price < 1 or not 0 < x.min_price < x.max_price:
            e.append("execution price band is not 0 < min < max < 1")
        if x.order_type not in ("FOK", "FAK", "GTC"):
            e.append("execution.order_type must be FOK, FAK or GTC")
        if p.max_edge > 0.5:
            e.append("probability.max_edge above 0.5 is not an edge, it is a "
                     "claim that the book is wrong by a coin flip")
        if self.consensus.min_effective_backers < 1.5:
            e.append("consensus.min_effective_backers below 1.5 lets a single "
                     "wallet self-trigger consensus")
        if self.weights.mode not in ("robust", "raw"):
            e.append("weights.mode must be 'robust' or 'raw'")
        if e:
            raise ValueError("invalid engine config:\n  - " + "\n  - ".join(e))
        return self


def load(path=CONFIG_PATH):
    return EngineConfig.load(path).validate()
