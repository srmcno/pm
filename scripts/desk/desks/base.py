#!/usr/bin/env python3
"""What a desk is, and the only view of the world it is allowed to see.

A desk answers one question — "what should I be holding right now?" — as
target weights of account equity. Everything else (order placement, fills,
fees, reconciliation, risk limits) belongs to the machinery around it, so
the SAME desk object drives the replay and the live loop. When those two
diverge, a backtest stops predicting anything, which is precisely how the
previous system came to report +0.38% and then lose 4.2%.

The other half of that failure was lookahead. A desk here cannot read a
price it would not have had: `View` hands out history sliced to the exact
instant of the decision, and the intraday fields of the current bar are
withheld at the open event because at 9:30 nobody knows the day's high.
"""
from dataclasses import dataclass, field


# Decision points within a session. A desk declares which it uses; the
# engine walks them in this order within each bar.
OPEN = "open"
CLOSE = "close"
EVENTS = (OPEN, CLOSE)


@dataclass
class Decision:
    """Target weights of equity, by symbol.

    +0.5 means "hold a long worth half of account equity"; -0.25 a short of
    a quarter. Absent symbols mean flat. Weights are targets, not orders —
    the executor computes the difference from what is actually held, which
    makes a missed fill self-correcting on the next decision.
    """
    weights: dict = field(default_factory=dict)
    note: str = ""
    # Optional per-symbol limit prices for live execution; None = market.
    limits: dict = field(default_factory=dict)

    def gross(self):
        return sum(abs(w) for w in self.weights.values())

    def net(self):
        return sum(self.weights.values())


class View:
    """History as of one decision instant. Slicing happens here, once.

    `bars(sym)` returns every COMPLETED bar strictly before the current one,
    plus — only at the close event — the current bar itself. At the open
    event the current bar is withheld entirely except for its open price,
    available through `open_price()`. There is no way to reach around this
    from a desk, which is the point.
    """

    def __init__(self, series, index, event, timestamp):
        self._series = series          # {symbol: [Bar]} aligned, full history
        self._i = index                # index of the CURRENT bar
        self.event = event
        self.timestamp = timestamp

    @property
    def index(self):
        return self._i

    def symbols(self):
        return list(self._series.keys())

    def bars(self, symbol):
        s = self._series.get(symbol)
        if not s:
            return []
        # close event: the current bar is complete and visible.
        # open event: it is not — only its open price is knowable.
        end = self._i + 1 if self.event == CLOSE else self._i
        return s[:end]

    def closes(self, symbol):
        return [b.c for b in self.bars(symbol)]

    def last_close(self, symbol):
        c = self.closes(symbol)
        return c[-1] if c else None

    def open_price(self, symbol):
        """The current bar's open — known at both events."""
        s = self._series.get(symbol)
        if not s or self._i >= len(s):
            return None
        return s[self._i].o

    def price_now(self, symbol):
        """The price a trade at this decision point would reference."""
        if self.event == OPEN:
            return self.open_price(symbol)
        return self.last_close(symbol)

    def history_length(self, symbol):
        return len(self.bars(symbol))


@dataclass
class DeskMeta:
    """Everything the framework needs to run a desk without knowing what it
    does. `capital_floor` and `pdt_day_trades` are declarations the risk
    manager enforces — a desk that day-trades says so here and is throttled
    under $25k rather than quietly flagging the account."""
    name: str
    title: str
    asset_class: str                 # equity | crypto | prediction
    venue: str                       # alpaca | coinbase | kraken | kalshi
    interval: str = "1d"
    periods_per_year: int = 252
    events: tuple = (CLOSE,)
    universe: tuple = ()
    warmup_bars: int = 30
    capital_floor: float = 25.0      # below this, frictions dominate
    pdt_day_trades: bool = False     # does a round trip open and close same day?
    shortable: bool = False
    fractional: bool = True
    # How this desk reaches the market. "auction" means market-on-close /
    # market-on-open orders filling at the official print; "crossing" means
    # marketable orders paying the spread. The replay's cost model and the
    # live executor's order type both read this field, so a desk cannot be
    # backtested one way and traded another.
    execution_style: str = "crossing"
    # The desk author's verdict, which can be STRICTER than the statistic.
    # A walk-forward record can validate on the full sample and still be
    # one an honest author will not fund — because it only holds in half
    # the sample, or because the effect it exploits is documented to have
    # weakened. The statistic cannot know that; the author can. Values:
    # "validated" | "marginal" | "rejected". The allocator refuses
    # "rejected" outright and funds "marginal" only when the operator names
    # the desk explicitly in data/desk/config.json.
    status: str = "validated"
    status_reason: str = ""
    description: str = ""


class Desk:
    """Base class. Subclasses implement `decide` and set `meta`.

    Desks are pure: given the same View and params they return the same
    Decision. No I/O, no clock reads, no randomness — that is what makes the
    replay trustworthy and the unit tests meaningful.
    """
    meta: DeskMeta = None
    params: dict = None

    def __init__(self, **params):
        self.params = {**(self.defaults() or {}), **(params or {})}

    @classmethod
    def defaults(cls):
        return {}

    @classmethod
    def param_grid(cls):
        """Parameter values a sweep may explore. Every point in this grid
        counts as a trial when the deflated Sharpe is computed, so keeping
        it small is a statistical decision, not a performance one."""
        return {}

    def universe(self):
        return list(self.meta.universe)

    def decide(self, view: View) -> Decision:
        raise NotImplementedError

    # Convenience for desks that want per-symbol vol targeting.
    @staticmethod
    def vol_scaled_weight(target_vol, realized, cap=1.0):
        """Weight that would put realized volatility at `target_vol`."""
        if not realized or realized <= 0:
            return 0.0
        return max(0.0, min(cap, target_vol / realized))


_REGISTRY = {}


def register(cls):
    """Decorator: make a desk discoverable by name from the CLI."""
    if not cls.meta:
        raise ValueError(f"{cls.__name__} has no meta")
    _REGISTRY[cls.meta.name] = cls
    return cls


def get(name):
    return _REGISTRY.get(name)


def all_desks():
    return dict(_REGISTRY)
