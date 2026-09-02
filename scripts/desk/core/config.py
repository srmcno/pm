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
from dataclasses import dataclass, asdict, field, fields

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
        notes="Runs every registered desk on paper, including the rejected "
              "and marginal ones, and records the result. No venue "
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
        desks=("trend", "xsect"),
        notes="At this size nothing currently clears the bar. The daily "
              "equity desk needs $2,000 of its own capital in whole shares; "
              "the Kalshi favorite-longshot study found no edge; crypto trend "
              "on BTC/ETH (trend) and monthly ETF momentum (xsect) are both "
              "MARGINAL — trend sits just over the p 0.10 bar on the strictly "
              "out-of-sample run, xsect trails an equal-weight hold of its "
              "own ETFs. Both are listed, both are re-tested every Monday, "
              "and the allocator funds neither until a run validates it AND "
              "it is named in data/desk/config.json. Until then this preset "
              "runs paper and records the result.",
    ),

    "small": Preset(
        name="small",
        title="Small account ($250-$4,000)",
        min_equity=250.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.5,
                          max_position_weight=0.34, daily_loss_halt=0.04,
                          weekly_loss_halt=0.10, max_drawdown_halt=0.25,
                          max_annual_turnover=120.0, min_trade_notional=1.0,
                          max_open_positions=6),
        desks=("trend", "xsect"),
        notes="Nothing is funded by default at this size. Crypto trend (p "
              "0.10 on the strictly out-of-sample run) and monthly ETF "
              "momentum (below its equal-weight benchmark) are both marginal "
              "and off until a Monday run validates them and they are named "
              "in data/desk/config.json. The overnight "
              "desk is NOT here: it needs $2,000 of its OWN capital (whole-"
              "share auction sizing), which under a shared preset means a "
              "$4,000 account. Between $2,000 and $4,000 it can run alone: "
              "`config --desks overnight` with max_desk_weight 1.0. No "
              "shorting: under $2,000 an Alpaca account is limited-margin "
              "and cannot short at all.",
    ),

    "standard": Preset(
        name="standard",
        title="Standard account ($4,000-$25,000)",
        min_equity=4000.0,
        limits=RiskLimits(max_gross_exposure=1.0, max_desk_weight=0.5,
                          max_position_weight=0.30, daily_loss_halt=0.035,
                          weekly_loss_halt=0.09, max_drawdown_halt=0.22,
                          max_annual_turnover=250.0, min_trade_notional=5.0,
                          max_open_positions=10),
        desks=("overnight", "xsect", "trend"),
        notes="From $4,000 the overnight desk gets the $2,000 of its own "
              "capital its record requires (half the account under the 50% "
              "desk cap; walk-forward Sharpe 0.76 at $2,000, 0.79 at $5,000). "
              "It is the one desk currently validated. The marginal desks "
              "(trend, xsect, reversion) stay off unless named explicitly in "
              "data/desk/config.json and their latest statistic validates; "
              "the rejected Kalshi desk never funds.",
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
        desks=("overnight", "xsect", "trend"),
        notes="Frictions are immaterial at this size, so the binding "
              "constraints become capacity and correlation rather than cost. "
              "Position and desk caps tighten, not loosen.",
    ),
}


@dataclass
class Config:
    preset: str = "observe"
    equity: float = 1000.0
    # Permits the REAL MONEY endpoint. Not sufficient on its own: orders
    # still need credentials, --live, --i-accept-total-loss, --real-money,
    # and no STOP file. Lives in the repo so the decision is in git history.
    live: bool = False
    venue_paper: bool = True           # Alpaca paper endpoint when live
    desks: tuple = ()
    limits: RiskLimits = field(default_factory=RiskLimits)
    desk_params: dict = field(default_factory=dict)
    # Desks the operator named in the config file, as opposed to inherited
    # from the preset. A marginal desk runs only if it is in here.
    explicit_desks: tuple = ()
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

    # The operator's overrides are the one hand-edited input. Unknown keys
    # are ignored and values are coerced to the field's type, so a typo or
    # a quoted number cannot crash the halt evaluation mid-session.
    base = p.limits.to_dict()
    types = {f.name: f.type for f in fields(RiskLimits)}
    for key, val in (raw.get("limits") or {}).items():
        if key not in base:
            continue
        try:
            base[key] = int(val) if types[key] is int else float(val)
        except (TypeError, ValueError):
            continue
    limits = RiskLimits(**base)
    cfg = Config(
        preset=p.name,
        equity=eq,
        # The real-money gate is the JSON boolean true and nothing else.
        # bool("false") is True; a hand-edited file that SAYS live is off
        # must never arm the real endpoint. venuePaper errs the other way:
        # anything but the boolean false stays on the paper endpoint.
        live=raw.get("live", False) is True,
        venue_paper=raw.get("venuePaper", True) is not False,
        desks=tuple(raw.get("desks") or p.desks),
        explicit_desks=tuple(raw.get("desks") or ()),
        limits=limits,
        desk_params=raw.get("deskParams") or {},
        notes=p.notes,
    )
    return cfg


def save(cfg, path=None):
    path = path or CONFIG_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    # Only the operator's EXPLICIT desk list is written. Writing the
    # preset's inherited list would turn every preset desk into an
    # explicitly named one on the next load, which is what arms a marginal
    # desk — a save/load round trip must not change what runs.
    blob = {"preset": cfg.preset, "equity": cfg.equity, "live": cfg.live,
            "venuePaper": cfg.venue_paper, "limits": cfg.limits.to_dict(),
            "deskParams": cfg.desk_params}
    if cfg.explicit_desks:
        blob["desks"] = list(cfg.explicit_desks)
    with open(tmp, "w") as f:
        json.dump(blob, f, indent=1)
    os.replace(tmp, path)
    return path


def describe(cfg):
    """Operator-facing summary of what is configured and what it means."""
    p = PRESETS.get(cfg.preset)
    lines = [
        f"preset      {cfg.preset} — {p.title if p else ''}",
        f"equity      ${cfg.equity:,.2f}",
        f"real money  {'PERMITTED by config (still needs keys and the --live, --i-accept-total-loss, --real-money flags)' if cfg.live else 'forbidden by config'}",
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
