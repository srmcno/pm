"""Venue specifications, engine tunables, and the hard risk rails.

Everything a human must review before real money moves lives here or in
`data/arb/live-config.json`. Nothing in the hot path invents a limit.

The venue numbers below are load-bearing — they decide how many sockets the
pool opens and whether an order can go out over WebSocket at all:

  MEXC  30 subscriptions per connection, 24 h connection lifetime, protobuf
        market data, and **no order entry over WebSocket** (REST `POST
        /api/v3/order` only). Its private WS carries fills and balances, which
        is the half that actually matters for leg chaining.
  Gate  WS v4 supports `spot.order_place`, so orders genuinely leave over the
        already-open socket. Order-book diffs carry `U`/`u` with overlap
        allowed.

2,100 MEXC pairs / 30 subs = 70 public sockets. That is the pool, and it is why
`feed.py` shards rather than opening one connection per symbol.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace

__all__ = ["VenueSpec", "EngineConfig", "RiskLimits", "MEXC", "GATE",
           "VENUES", "load_config", "BASE"]

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


@dataclass(frozen=True)
class VenueSpec:
    name: str
    ws_public: str
    ws_private: str
    rest_base: str

    # --- connection-pool sizing -------------------------------------------
    max_subs_per_conn: int = 30
    max_conns: int = 96
    conn_lifetime_s: float = 23 * 3600      # recycle before the venue cuts us
    ping_interval_s: float = 15.0
    idle_timeout_s: float = 45.0            # venue drops a silent socket at 60

    # --- market data semantics --------------------------------------------
    depth_channel: str = ""
    strict_sequencing: bool = True          # frame N+1 must start at last+1
    snapshot_path: str = "/api/v3/depth"
    snapshot_limit: int = 1000
    wire: str = "json"                      # "json" | "protobuf"

    # --- trading ----------------------------------------------------------
    ws_order_entry: bool = False            # can orders leave over the socket?
    default_taker: float = 0.0005
    supports_ioc: bool = True
    supports_fok: bool = True
    order_path: str = "/api/v3/order"
    recv_window_ms: int = 5_000

    # --- rate limits (per IP unless noted) --------------------------------
    rest_orders_per_10s: int = 100
    rest_weight_per_min: int = 1_200

    def conns_needed(self, n_symbols: int, streams_per_symbol: int = 1) -> int:
        subs = n_symbols * streams_per_symbol
        return (subs + self.max_subs_per_conn - 1) // self.max_subs_per_conn


MEXC = VenueSpec(
    name="mexc",
    ws_public="wss://wbs-api.mexc.com/ws",
    ws_private="wss://wbs-api.mexc.com/ws",
    rest_base="https://api.mexc.com",
    max_subs_per_conn=30,
    conn_lifetime_s=23 * 3600,
    # Aggregated incremental depth at 100 ms. The 10 ms variant exists and is
    # tempting, but 2,100 symbols x 100 frames/s is ~210 k frames/s of decode —
    # far past what one box can absorb. 100 ms is the honest default; raise it
    # only for the handful of symbols a live cycle is actually watching.
    depth_channel="spot@public.aggre.depth.v3.api.pb@100ms@{symbol}",
    strict_sequencing=True,                 # fromVersion == last toVersion + 1
    wire="protobuf",
    ws_order_entry=False,                   # verified: REST-only order entry
    default_taker=0.0005,
    snapshot_limit=1000,
)

GATE = VenueSpec(
    name="gate",
    ws_public="wss://api.gateio.ws/ws/v4/",
    ws_private="wss://api.gateio.ws/ws/v4/",
    rest_base="https://api.gateio.ws/api/v4",
    max_subs_per_conn=200,                  # far more generous than MEXC
    depth_channel="spot.order_book_update",
    strict_sequencing=False,                # U <= last+1 <= u
    snapshot_path="/spot/order_book",
    snapshot_limit=100,
    wire="json",
    ws_order_entry=True,                    # spot.order_place
    default_taker=0.002,
    order_path="/spot/orders",
)

VENUES = {v.name: v for v in (MEXC, GATE)}


@dataclass
class RiskLimits:
    """Hard rails. Every one of these is checked on the order path, not just
    at signal time — a signal that passed 40 ms ago is not a permission slip."""

    bankroll_usd: float = 20.0
    max_stake_per_cycle_usd: float = 10.0
    max_daily_stake_usd: float = 40.0
    max_daily_loss_usd: float = 2.0
    max_open_cycles: int = 2
    max_inflight_per_symbol: int = 1
    min_edge_bps: float = 10.0              # net of fees, at the executable size
    min_edge_bps_after_slippage: float = 4.0
    max_signal_age_ms: float = 40.0         # older than this is a memory
    max_book_age_ms: float = 750.0          # a silent book is not a live book
    max_leg_latency_ms: float = 350.0       # abort the chain past this
    # Unwind aggression: how far through the bid we are willing to cross to get
    # flat. Being slow to unwind costs more than the extra bps, every time.
    unwind_cross_bps: float = 60.0
    unwind_max_attempts: int = 3
    max_stranded_usd: float = 5.0           # halt if inventory exceeds this
    stop_file: str = os.path.join(BASE, "data", "arb", "STOP")

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


@dataclass
class EngineConfig:
    quote: str = "USDT"
    bridges: tuple[str, ...] = ("USDC", "USD1", "BTC", "ETH", "USDE", "EUR")
    venues: tuple[str, ...] = ("mexc",)
    depth_levels: int = 20                  # levels kept in the shm slab
    ingest_shards: int = 4                  # ingestion processes
    max_symbols: int = 4096

    # Screening: the top-of-book pre-filter that decides which cycles are worth
    # a full depth walk. Set below zero so near-misses stay observable.
    screen_min_bps: float = -15.0
    evaluate_min_bps: float = 0.5
    size_candidates_usd: tuple[float, ...] = (5.0, 10.0, 20.0, 50.0)

    # Telemetry benchmarks from the brief.
    decay_checkpoints_ms: tuple[int, ...] = (25, 100, 500)
    survival_max_ms: int = 60_000

    # Cross-venue.
    cross_min_bps: float = 30.0
    cross_max_bps: float = 800.0            # bigger than this is a ticker collision
    cross_min_vol_usd: float = 20_000.0
    cross_price_ratio_band: tuple[float, float] = (0.5, 2.0)

    risk: RiskLimits = field(default_factory=RiskLimits)
    live: bool = False                      # ships disarmed
    journal_path: str = os.path.join(BASE, "data", "arb", "engine-journal.jsonl")
    telemetry_path: str = os.path.join(BASE, "dashboard", "data", "engine.json")

    def venue_specs(self) -> list[VenueSpec]:
        return [VENUES[v] for v in self.venues]


def load_config(path: str | None = None, **overrides) -> EngineConfig:
    """Config from disk, then keyword overrides. Missing file is not an error —
    the defaults are the disarmed, paper-only configuration."""
    cfg = EngineConfig()
    if path and os.path.exists(path):
        try:
            with open(path) as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        risk_raw = raw.pop("risk", None)
        if isinstance(risk_raw, dict):
            known = {k: v for k, v in risk_raw.items()
                     if k in RiskLimits.__dataclass_fields__}
            cfg.risk = replace(cfg.risk, **known)
        for k, v in raw.items():
            if k in EngineConfig.__dataclass_fields__ and k != "risk":
                if isinstance(getattr(cfg, k), tuple) and isinstance(v, list):
                    v = tuple(v)
                setattr(cfg, k, v)
    for k, v in overrides.items():
        if k in EngineConfig.__dataclass_fields__:
            setattr(cfg, k, v)
    return cfg
