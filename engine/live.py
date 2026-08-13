"""Live wiring: real sockets, real REST, real (optional) order routing.

Separated from `runtime.py` so that everything above — books, graph, sizing,
execution, telemetry — imports and tests with no third-party dependency at all.
Only this module needs `aiohttp` and `websockets`.

Arming checklist (nothing routes an order until every one of these holds):
  1. `MEXC_API_KEY` / `MEXC_API_SECRET` in the environment, SPOT TRADE
     permission only — never withdrawal.
  2. `--live` passed explicitly on the command line.
  3. `data/arb/STOP` absent.
  4. `engine.risk.RiskLimits` reviewed. The defaults are $20 of bankroll and a
     $2 daily loss limit for a reason.
  5. The engine has been running in paper mode long enough that
     `dashboard/data/engine.json` shows a real `decay` block. If capture at
     T+100 ms is already near zero, arming buys nothing — the edge is gone
     before any order could arrive, and the correct action is to stop.
"""
from __future__ import annotations

import asyncio
import os
import signal
from typing import Sequence

from .clock import now_ns
from .config import EngineConfig, MEXC, VENUES
from .runtime import Engine

__all__ = ["run_live", "fetch_exchange_info"]


async def fetch_exchange_info(http, spec=MEXC) -> dict:
    """Live `exchangeInfo`, reduced to the fields the engine actually uses.

    MEXC expresses size/price granularity as decimal precision rather than
    Binance-style step strings, so both are normalized to absolute steps here —
    one place, so the sizer never has to know which venue it is looking at.
    """
    raw = await http.get_json(f"{spec.rest_base}/api/v3/exchangeInfo")
    out: dict[str, dict] = {}
    for s in (raw or {}).get("symbols", []):
        if s.get("status") not in ("1", "ENABLED", "TRADING"):
            continue
        if not s.get("isSpotTradingAllowed", True):
            continue
        try:
            base_prec = int(s.get("baseSizePrecision") or s.get("baseAssetPrecision") or 8)
        except (TypeError, ValueError):
            base_prec = 8
        try:
            quote_prec = int(s.get("quotePrecision") or s.get("quoteAssetPrecision") or 8)
        except (TypeError, ValueError):
            quote_prec = 8
        try:
            min_notional = float(s.get("quoteAmountPrecision") or 0.0)
        except (TypeError, ValueError):
            min_notional = 0.0
        out[s["symbol"]] = {
            "base": s["baseAsset"],
            "quote": s["quoteAsset"],
            "taker": float(s.get("takerCommission") or spec.default_taker),
            "stepSize": 10.0 ** (-min(base_prec, 12)),
            "tickSize": 10.0 ** (-min(quote_prec, 12)),
            "minQty": 0.0,
            "minNotional": min_notional,
        }
    return out


async def run_live(cfg: EngineConfig, duration_s: float = 0.0) -> int:
    from .net import AIOHTTP_AVAILABLE, HttpClient
    from .feed import WEBSOCKETS_AVAILABLE
    from .venues.mexc import MexcCredentials, MexcFeed, MexcRouter

    if not (AIOHTTP_AVAILABLE and WEBSOCKETS_AVAILABLE):
        print("live mode needs aiohttp + websockets:\n"
              "  pip install -r requirements-engine.txt\n"
              "Paper analysis (`plan`, `selftest`) runs without them.")
        return 2

    spec = VENUES[cfg.venues[0]]
    # Two pools on purpose: a burst of resync snapshots must never queue ahead
    # of an order, and they share nothing but the destination host.
    md_http = await HttpClient(spec.rest_base, pool_size=12, timeout_s=4.0,
                               rate_per_s=16.0, warm_path="/api/v3/ping").start()
    ord_http = await HttpClient(spec.rest_base, pool_size=6, timeout_s=3.0,
                                rate_per_s=18.0, warm_path="/api/v3/ping").start()

    try:
        info = await fetch_exchange_info(md_http, spec)
        if len(info) < 200:
            print(f"refusing to start: exchangeInfo returned {len(info)} symbols")
            return 3

        creds = MexcCredentials(os.environ.get("MEXC_API_KEY", ""),
                                os.environ.get("MEXC_API_SECRET", ""))
        if cfg.live and not creds.armed:
            print("--live requested but MEXC_API_KEY/MEXC_API_SECRET are unset; "
                  "continuing in paper mode.")
            cfg.live = False

        router = MexcRouter(creds, ord_http, spec) if creds.armed else None
        engine = Engine(cfg, info, router=router,
                        feed_factory=lambda syms: MexcFeed(spec, syms, md_http))

        print(f"universe {len(engine.symbols)} symbols · "
              f"{len(engine.index.triangles):,} cycles · "
              f"{spec.conns_needed(len(engine.symbols))} sockets · "
              f"{'ARMED' if cfg.live else 'paper'}")

        loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:  # pragma: no cover - non-POSIX
                pass

        run = asyncio.create_task(engine.run(duration_s))
        wait = asyncio.create_task(stop.wait())
        done, pending = await asyncio.wait({run, wait},
                                           return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        if run in done and run.exception():
            raise run.exception()            # type: ignore[misc]
        await engine.stop()
        return 0
    finally:
        await md_http.close()
        await ord_http.close()
