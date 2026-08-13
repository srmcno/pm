#!/usr/bin/env python3
"""Getting out: profit capture, consensus reversal, and the time rails.

Holding binaries to resolution is what makes this strategy slow. Capital sits
in a 96c position for eleven days to earn the last four cents while every
signal that fires in the meantime goes untaken. The fix is not a static
take-profit price, though -- it is a comparison.

  Capture rule. A position bought at e and now marked p has captured
  (p - e) / (1 - e) of its maximum possible gain. Holding the rest to
  resolution earns (1 - p) / p over the remaining T days, which annualizes to
  (1/p)^(365/T) - 1. Selling is right when that return no longer beats the
  hurdle -- and at 96c with resolution tomorrow it emphatically does beat it,
  which is exactly the case a flat "sell at 96" rule gets wrong. A hard
  take-profit still sits above the rule as a backstop, because tail risk in a
  resolution is not compensated at any horizon.

  Reversal rule. Two whales leaving is not two whales flipping. A wallet
  taking profit into a rally has not changed its mind; a wallet whose net
  stance crosses zero has. Reversals are therefore weighted by the same W_i
  that admitted the vote in the first place, and must reach a fraction of the
  consensus that opened the position before anything is sold.

  Liquidity rule. Every exit above is an instruction to leave, not an
  instruction to hit whatever bid exists. A 40c position with a 12c bid is not
  worth 12c; crossing into that hole realizes a loss the market never charged.
  Exits post a limit and, when the book is that thin, ladder out instead.
"""
import math
from dataclasses import dataclass

from .config import ExitConfig
from .consensus import logit

DAY = 86400.0


@dataclass
class ExitDecision:
    action: str          # "hold" | "sell" | "reduce"
    reason: str
    limit_price: float = 0.0
    fraction: float = 1.0
    urgent: bool = False
    detail: dict = None

    @property
    def exiting(self):
        return self.action in ("sell", "reduce")


def captured_fraction(entry, price):
    """Share of the maximum available gain already banked."""
    room = 1.0 - entry
    if room <= 1e-9:
        return 1.0
    return (price - entry) / room


def annualized_hold_return(price, days_to_resolution):
    """What the remaining stub pays if held to a winning resolution.

    Undefined without a horizon: an unknown resolution date is treated as the
    max-hold rail, because an unbounded horizon annualizes to nothing and
    would make every position look worth holding forever.
    """
    if price <= 0 or price >= 1:
        return 0.0
    t = max(days_to_resolution, 1.0 / 24.0)
    try:
        return (1.0 / price) ** (365.0 / t) - 1.0
    except OverflowError:
        return float("inf")


def take_profit(position, price, days_to_resolution, cfg: ExitConfig, now=None):
    """Profit capture, stop-loss and time rails on one position."""
    entry = position.get("entryPrice") or position.get("entry") or 0.0
    opened = position.get("openedAt")
    age_days = (((now or 0) - opened) / DAY
                if now is not None and opened is not None else 0.0)
    captured = captured_fraction(entry, price)
    hold_ret = annualized_hold_return(price, days_to_resolution)
    detail = {"captured": round(captured, 4), "entry": entry,
              "price": round(price, 4), "ageDays": round(age_days, 2),
              "daysToResolution": round(days_to_resolution, 2),
              "annualizedHold": round(hold_ret, 3)}

    drift = logit(price) - logit(entry) if 0 < entry < 1 else 0.0
    if drift <= cfg.stop_loss_logit:
        return ExitDecision("sell", f"stop-loss: {drift:+.2f} log-odds against "
                            f"entry (limit {cfg.stop_loss_logit:+.2f})",
                            urgent=True, detail=detail)

    if price >= cfg.take_profit_price:
        return ExitDecision("sell", f"hard take-profit at {price:.3f} "
                            f">= {cfg.take_profit_price:.2f} "
                            f"({captured:.0%} of max gain)", detail=detail)

    # Tolerance because (0.94-0.80)/(1-0.80) evaluates to 0.6999999999999996
    # in binary, and a rule stated as "70% captured" must fire at 70%.
    if (captured >= cfg.min_capture_frac - 1e-9
            and hold_ret < cfg.hold_hurdle_annualized):
        return ExitDecision("sell", f"captured {captured:.0%} of max gain and "
                            f"the remaining stub annualizes at {hold_ret:.0%}, "
                            f"below the {cfg.hold_hurdle_annualized:.0%} hurdle "
                            f"— redeploy the capital", detail=detail)

    if age_days >= cfg.max_hold_days:
        return ExitDecision("sell", f"held {age_days:.1f}d >= "
                            f"{cfg.max_hold_days:g}d rail", detail=detail)

    return ExitDecision("hold", "no exit condition met", detail=detail)


def consensus_reversal(position, current_stances, cfg: ExitConfig):
    """Emergency exit when the wallets that opened the trade leave it.

    `position["backers"]` is the opening consensus: [{wallet, weight, netUsd}].
    `current_stances` maps wallet -> current net USD on the same outcome.
    """
    backers = position.get("backers") or []
    if not backers:
        return ExitDecision("hold", "no recorded backers to check")

    opening_sigma = sum(b.get("value", b.get("weight", 0.0)) for b in backers)
    reversed_w, flipped = 0.0, []
    for b in backers:
        addr = b.get("wallet")
        was = b.get("netUsd") or 0.0
        now = current_stances.get(addr)
        if now is None or was <= 0:
            continue
        if now <= 0:
            kind = "flipped"                       # net stance crossed zero
        elif now <= was * (1.0 - cfg.reversal_exit_frac):
            kind = f"cut {1 - now / was:.0%}"
        else:
            continue
        reversed_w += b.get("value", b.get("weight", 0.0))
        flipped.append({"wallet": addr, "name": b.get("name"),
                        "was": round(was, 2), "now": round(now, 2),
                        "kind": kind})

    frac = reversed_w / opening_sigma if opening_sigma > 0 else 0.0
    detail = {"openingSigma": round(opening_sigma, 3),
              "reversedWeight": round(reversed_w, 3),
              "reversedFraction": round(frac, 3), "flipped": flipped}

    if (len(flipped) >= cfg.min_reversal_wallets
            and frac >= cfg.reversal_weight_frac):
        names = ", ".join(f["name"] or f["wallet"][:8] for f in flipped)
        return ExitDecision("sell", f"consensus reversal: {len(flipped)} backers "
                            f"({frac:.0%} of opening weight) left — {names}",
                            urgent=True, detail=detail)
    return ExitDecision("hold", f"{len(flipped)} backers moved, "
                        f"{frac:.0%} of opening weight", detail=detail)


def exit_order(decision: ExitDecision, mark, best_bid, cfg: ExitConfig,
               tick=0.01):
    """Turn an exit into a price, without donating to a thin book.

    An urgent exit crosses to the bid but never further than
    `max_exit_concession` below the mark; a patient exit posts at the mark and
    waits. When the bid is beyond the concession limit the order is split:
    sell what the book will pay for near the mark, keep the rest resting.
    """
    if not decision.exiting:
        return None
    if best_bid is None:
        return {"limit": round(mark - cfg.max_exit_concession, 3),
                "fraction": decision.fraction, "style": "blind",
                "note": "no bid visible — resting below the mark"}

    concession = mark - best_bid
    if decision.urgent and concession <= cfg.max_exit_concession:
        return {"limit": _round_tick(best_bid, tick, down=True),
                "fraction": decision.fraction, "style": "cross",
                "note": f"crossing to the bid, conceding {concession:.3f}"}
    if concession <= cfg.max_exit_concession:
        # Strictly ABOVE the best bid. A sell resting at the bid is
        # marketable, and patient exits are sent post_only, so the venue
        # rejects it outright -- the order simply never exists, and the
        # position quietly stays on when the operator believes it is leaving.
        return {"limit": _round_tick(max(best_bid + tick, mark), tick, down=False),
                "fraction": decision.fraction, "style": "join",
                "note": "resting one tick above the bid to stay a maker"}
    return {"limit": _round_tick(mark - cfg.max_exit_concession, tick, down=True),
            "fraction": min(decision.fraction, 0.5), "style": "ladder",
            "note": f"bid is {concession:.3f} below the mark — laddering out "
                    f"instead of crossing into it"}


def _round_tick(price, tick, down=True):
    if tick <= 0:
        return round(price, 4)
    n = price / tick
    n = math.floor(n) if down else math.ceil(n)
    return round(max(tick, min(1.0 - tick, n * tick)), 6)
