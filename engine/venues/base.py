"""The contract every venue adapter implements.

Two separate abstractions, because venues differ on exactly this axis:

  `MarketFeed`   how L2 deltas arrive and how they are sequenced.
  `OrderRouter`  how an order leaves and how its fill comes back.

Keeping them apart is what lets MEXC (REST order entry, WS fill push) and Gate
(WS order entry, WS fill push) sit behind one execution manager. The manager
never learns which is which.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, Sequence

from ..book import Level
from ..config import VenueSpec

__all__ = [
    "DepthFrame", "Snapshot", "OrderRequest", "OrderResult", "OrderStatus",
    "TimeInForce", "Side", "MarketFeed", "OrderRouter", "FillEvent",
    "VenueError", "RateLimited", "OrderRejected",
]


class VenueError(RuntimeError):
    """Any venue-originated failure. Carries the raw payload for the journal."""

    def __init__(self, message: str, raw: Any = None, retriable: bool = False) -> None:
        super().__init__(message)
        self.raw = raw
        self.retriable = retriable


class RateLimited(VenueError):
    def __init__(self, message: str, raw: Any = None, retry_after_s: float = 1.0) -> None:
        super().__init__(message, raw, retriable=True)
        self.retry_after_s = retry_after_s


class OrderRejected(VenueError):
    pass


class Side(enum.IntEnum):
    BUY = 0
    SELL = 1

    @property
    def wire(self) -> str:
        return "BUY" if self is Side.BUY else "SELL"


class TimeInForce(enum.Enum):
    IOC = "IOC"
    FOK = "FOK"


class OrderStatus(enum.Enum):
    NEW = "NEW"
    FILLED = "FILLED"
    PARTIAL = "PARTIALLY_FILLED"
    CANCELED = "CANCELED"       # IOC remainder killed — the normal terminal state
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    UNKNOWN = "UNKNOWN"

    @property
    def terminal(self) -> bool:
        return self in (OrderStatus.FILLED, OrderStatus.CANCELED,
                        OrderStatus.REJECTED, OrderStatus.EXPIRED)


@dataclass(slots=True)
class DepthFrame:
    """One decoded L2 update, venue-neutral."""
    symbol: str
    first_id: int
    last_id: int
    bids: Sequence[Level]
    asks: Sequence[Level]
    ts_ms: int = 0
    is_snapshot: bool = False
    recv_ns: int = 0


@dataclass(slots=True)
class Snapshot:
    symbol: str
    last_update_id: int
    bids: Sequence[Level]
    asks: Sequence[Level]
    recv_ns: int = 0


@dataclass(slots=True)
class OrderRequest:
    symbol: str
    side: Side
    tif: TimeInForce
    qty: float                     # base quantity
    price: float                   # limit price (IOC/FOK are always limits here)
    client_id: str
    quote_qty: float = 0.0         # only for venues that accept quote-sized orders
    tag: str = ""                  # cycle id / leg number, journaled not sent


@dataclass(slots=True)
class OrderResult:
    client_id: str
    order_id: str
    status: OrderStatus
    filled_base: float = 0.0
    filled_quote: float = 0.0
    fee_asset: str = ""
    fee_amount: float = 0.0
    avg_price: float = 0.0
    sent_ns: int = 0
    ack_ns: int = 0
    fill_ns: int = 0
    raw: Any = None

    @property
    def ack_latency_ms(self) -> float:
        return (self.ack_ns - self.sent_ns) / 1e6 if self.sent_ns and self.ack_ns else 0.0

    @property
    def fill_latency_ms(self) -> float:
        return (self.fill_ns - self.sent_ns) / 1e6 if self.sent_ns and self.fill_ns else 0.0

    @property
    def filled(self) -> bool:
        return self.filled_base > 0.0

    def as_dict(self) -> dict:
        return {"clientId": self.client_id, "orderId": self.order_id,
                "status": self.status.value, "filledBase": self.filled_base,
                "filledQuote": self.filled_quote, "avgPrice": self.avg_price,
                "ackMs": round(self.ack_latency_ms, 2),
                "fillMs": round(self.fill_latency_ms, 2)}


@dataclass(slots=True)
class FillEvent:
    """A private-stream fill push — the thing that ends a leg's wait."""
    symbol: str
    client_id: str
    order_id: str
    status: OrderStatus
    filled_base: float
    filled_quote: float
    fee_asset: str = ""
    fee_amount: float = 0.0
    ts_ms: int = 0
    recv_ns: int = 0


class MarketFeed(Protocol):
    """Decodes a venue's public depth stream."""

    spec: VenueSpec

    def channels_for(self, symbols: Sequence[str]) -> list[str]:
        """Channel strings to subscribe, one or more per symbol."""

    def subscribe_message(self, channels: Sequence[str]) -> str | bytes:
        ...

    def unsubscribe_message(self, channels: Sequence[str]) -> str | bytes:
        ...

    def ping_message(self) -> str | bytes | None:
        """Application-level keepalive, or None if protocol pings suffice."""

    def decode(self, raw: str | bytes) -> list[DepthFrame]:
        """Zero or more frames. Control messages decode to an empty list."""

    async def fetch_snapshot(self, symbol: str) -> Snapshot:
        ...


class OrderRouter(Protocol):
    """Sends orders and surfaces fills. One instance per venue."""

    spec: VenueSpec

    async def start(self) -> None: ...
    async def close(self) -> None: ...

    async def submit(self, req: OrderRequest) -> OrderResult:
        """Send and return as soon as the venue acknowledges.

        For an IOC/FOK the ack usually already carries the fill; when it does
        not, the caller awaits `wait_fill`, which is served by the private
        stream rather than by polling.
        """

    async def wait_fill(self, client_id: str, timeout_s: float) -> OrderResult:
        ...

    async def balances(self) -> dict[str, float]: ...

    def on_fill(self, cb: Callable[[FillEvent], None]) -> None: ...
