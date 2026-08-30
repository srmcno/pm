#!/usr/bin/env python3
"""Layered configuration and risk presets.

Three layers, later ones overriding earlier: built-in defaults, a named
preset, then whatever is in data/desk/config.json. That last file is the
only thing an operator edits, and anything absent from it falls back, so a
partial file cannot leave the system in a half-configured state.

The presets are sized to the account, because the right settings genuinely
differ by capital rather than by taste. On a $250 account the per-day
regulatory fee floor is 2.7% a year and turnover has to be rationed; at
$5,000 it is a rounding error and the same strategy can run freely. A
preset is a coherent set of answers to that, not a difficulty slider.
"""
import json
import os
from dataclasses import dataclass, asdict, field

from .risk import RiskLimits

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
CONFIG_PATH = os.path.join(BASE, "data", "desk", "config.json")


@dataclass
class Preset:
    name: str
    title: str
    min_equity: float
    limits: RiskLimits
    desks: tuple
    notes: str = ""


# The desk names referenced here are registered by desk.desks.* modules.
PRESETS = {
    # Everything paper, nothing armed. What a new operator starts on and
    # what the CI shifts run until the evidence says otherwise.
    "observe": Preset(
        name="observe",
        title="Observe only — paper, no orders",
        min_equity=0.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.5,
                          max_position_weight=0.35, daily_loss_halt=0.04,
                          max_annual_turnover=1000.0, max_open_positions=8),
        desks=("overnight", "trend", "xsect", "reversion", "kalshi-bias"),
        notes="Runs every desk on paper and records the result. No venue "
              "credentials are read and no order can be produced.",
    ),

    # A real but tiny account. Only desks that survive at this size are on,
    # and turnover is rationed hard because spread cost, not regulation, is
    # what kills small accounts now that the PDT rule is gone.
    "micro": Preset(
        name="micro",
        title="Micro account ($25-$250)",
        min_equity=25.0,
        limits=RiskLimits(max_gross_exposure=0.9, max_desk_weight=0.6,
                          max_position_weight=0.30, daily_loss_halt=0.05,
                          weekly_loss_halt=0.12, max_drawdown_halt=0.25,
                          max_annual_turnover=12.0, min_trade_notional=1.0,
                          max_open_positions=4),
        desks=("kalshi-bias",),
        notes="At this size US equity desks are not viable: the per-day fee "
              "floor of about $0.03 is 14% a year on $40 and takes the "
              "account to zero over a decade. Kalshi is the exception — "
              "fractional contracts to $0.01 and free maker orders — so it "
              "is the only desk enabled here.",
    ),

    "small": Preset(
        name="small",
        title="Small account ($250-$2,000)",
        min_equity=250.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.5,
                          max_position_weight=0.34, daily_loss_halt=0.04,
                          weekly_loss_halt=0.10, max_drawdown_halt=0.25,
                          max_annual_turnover=120.0, min_trade_notional=1.0,
                          max_open_positions=6),
        desks=("overnight", "xsect", "kalshi-bias"),
        notes="Equity desks become viable here. The overnight desk is the "
              "flagship (walk-forward Sharpe 0.83) and monthly-rebalanced "
              "cross-sectional momentum adds a low-turnover second stream. "
              "No shorting: under $2,000 an Alpaca account is limited-margin "
              "and cannot short at all.",
    ),

    "standard": Preset(
        name="standard",
        title="Standard account ($2,000-$25,000)",
        min_equity=2000.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.4,
                          max_position_weight=0.30, daily_loss_halt=0.035,
                          weekly_loss_halt=0.09, max_drawdown_halt=0.22,
                          max_annual_turnover=250.0, min_trade_notional=5.0,
                          max_open_positions=10),
        desks=("overnight", "xsect", "trend", "reversion", "kalshi-bias"),
        notes="Above $2,000 the account leaves limited-margin status: "
              "shorting and 4x intraday buying power become available. The "
              "fee floor is now noise, so every validated desk can run and "
              "crypto trend is worth its 25bps taker cost.",
    ),

    # Deliberately not a "maximum risk" preset. It relaxes turnover and
    # position caps because size makes frictions small, not because more
    # risk is better.
    "scaled": Preset(
        name="scaled",
        title="Scaled account ($25,000+)",
        min_equity=25000.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.35,
                          max_position_weight=0.25, daily_loss_halt=0.03,
                          weekly_loss_halt=0.08, max_drawdown_halt=0.20,
                          max_annual_turnover=400.0, min_trade_notional=20.0,
                          max_open_positions=16),
        desks=("overnight", "xsect", "trend", "reversion", "kalshi-bias"),
        notes="Frictions are immaterial at this size, so the binding "
              "constraints become capacity and correlation rather than cost. "
              "Position and desk caps tighten, not loosen.",
    ),
}


@dataclass
class Config:
    preset: str = "observe"
    equity: float = 1000.0
    live: bool = False                 # arm real orders (still needs flags + keys)
    venue_paper: bool = True           # Alpaca paper endpoint when live
    desks: tuple = ()
    limits: RiskLimits = field(default_factory=RiskLimits)
    desk_params: dict = field(default_factory=dict)
    notes: str = ""

    def to_dict(self):
        d = asdict(self)
        d["limits"] = self.limits.to_dict()
        d["desks"] = list(self.desks)
        return d


def preset_for_equity(equity):
    """The preset whose size band contains this account."""
    best = PRESETS["observe"]
    for p in PRESETS.values():
        if p.min_equity <= equity and p.min_equity >= best.min_equity:
            best = p
    return best


def load(path=None, equity=None, preset=None):
    """Built-in defaults, then the preset, then the operator's file."""
    path = path or CONFIG_PATH
    raw = {}
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        pass

    eq = float(equity if equity is not None else raw.get("equity", 1000.0))
    name = preset or raw.get("preset") or preset_for_equity(eq).name
    p = PRESETS.get(name) or preset_for_equity(eq)

    limits = RiskLimits(**{**p.limits.to_dict(), **(raw.get("limits") or {})})
    cfg = Config(
        preset=p.name,
        equity=eq,
        live=bool(raw.get("live", False)),
        venue_paper=bool(raw.get("venuePaper", True)),
        desks=tuple(raw.get("desks") or p.desks),
        limits=limits,
        desk_params=raw.get("deskParams") or {},
        notes=p.notes,
    )
    return cfg


def save(cfg, path=None):
    path = path or CONFIG_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"preset": cfg.preset, "equity": cfg.equity, "live": cfg.live,
                   "venuePaper": cfg.venue_paper, "desks": list(cfg.desks),
                   "limits": cfg.limits.to_dict(),
                   "deskParams": cfg.desk_params}, f, indent=1)
    os.replace(tmp, path)
    return path


def describe(cfg):
    """Operator-facing summary of what is configured and what it means."""
    p = PRESETS.get(cfg.preset)
    lines = [
        f"preset      {cfg.preset} — {p.title if p else ''}",
        f"equity      ${cfg.equity:,.2f}",
        f"mode        {'LIVE ORDERS ARMED' if cfg.live else 'paper only'}"
        + ("" if not cfg.live else
           f" ({'paper endpoint' if cfg.venue_paper else 'REAL MONEY endpoint'})"),
        f"desks       {', '.join(cfg.desks) or 'none'}",
        f"turnover    {cfg.limits.max_annual_turnover:g}x equity per year "
        f"(${cfg.limits.max_annual_turnover * cfg.equity:,.0f})",
        f"halts       daily {cfg.limits.daily_loss_halt:.0%} · weekly "
        f"{cfg.limits.weekly_loss_halt:.0%} · drawdown "
        f"{cfg.limits.max_drawdown_halt:.0%}",
    ]
    if p and p.notes:
        lines.append("")
        lines.append(p.notes)
    return "\n".join(lines)
