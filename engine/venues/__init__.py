"""Per-venue wire adapters behind one protocol (see `base.py`)."""

from .base import (DepthFrame, FillEvent, MarketFeed, OrderRejected,
                   OrderRequest, OrderResult, OrderRouter, OrderStatus,
                   RateLimited, Side, Snapshot, TimeInForce, VenueError)

__all__ = [
    "DepthFrame", "FillEvent", "MarketFeed", "OrderRejected", "OrderRequest",
    "OrderResult", "OrderRouter", "OrderStatus", "RateLimited", "Side",
    "Snapshot", "TimeInForce", "VenueError", "get_feed", "get_router",
]


def get_feed(venue: str, **kw):
    if venue == "mexc":
        from .mexc import MexcFeed
        return MexcFeed(**kw)
    if venue == "gate":
        from .gate import GateFeed
        return GateFeed(**kw)
    raise KeyError(f"unknown venue {venue!r}")


def get_router(venue: str, **kw):
    if venue == "mexc":
        from .mexc import MexcRouter
        return MexcRouter(**kw)
    if venue == "gate":
        from .gate import GateRouter
        return GateRouter(**kw)
    raise KeyError(f"unknown venue {venue!r}")
