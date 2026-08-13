"""Async HTTP with a pre-warmed keep-alive pool, plus a token-bucket limiter.

The pool is the latency story on MEXC, where orders must go out over REST. A
cold request pays DNS + TCP + TLS — two round trips minimum, 60-120 ms from a
Tokyo VPS and far worse from anywhere else. A warm one pays zero. So:

  * connections are opened and `GET /api/v3/ping`-ed at startup,
  * an idle keepalive tickles them well inside the server's idle timeout,
  * order traffic and snapshot traffic use *separate* sessions, because a
    burst of 40 snapshot fetches must never queue behind an order or steal its
    connection.

`aiohttp` is an optional dependency: importing this module without it is fine,
and only constructing a client raises — so the pure-computation tests, and the
paper path, run on a stdlib-only box.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Mapping

from .clock import now_ns
from .venues.base import RateLimited, VenueError

__all__ = ["HttpClient", "TokenBucket", "AIOHTTP_AVAILABLE"]

try:  # pragma: no cover - environment dependent
    import aiohttp
    AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover
    aiohttp = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False


class TokenBucket:
    """Rate limiter that yields the event loop instead of sleeping the world.

    Venue limits are per-IP and shared across every coroutine in the process,
    so a single bucket per (venue, purpose) is the correct granularity. Orders
    get their own bucket from snapshots: exhausting the snapshot budget must
    never delay a leg.
    """

    __slots__ = ("rate", "capacity", "_tokens", "_last", "_lock")

    def __init__(self, rate_per_s: float, capacity: float | None = None) -> None:
        self.rate = rate_per_s
        self.capacity = capacity if capacity is not None else max(1.0, rate_per_s)
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def take(self, n: float = 1.0) -> float:
        """Acquire `n` tokens; returns the seconds spent waiting."""
        waited = 0.0
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(self.capacity,
                                   self._tokens + (now - self._last) * self.rate)
                self._last = now
                if self._tokens >= n:
                    self._tokens -= n
                    return waited
                deficit = (n - self._tokens) / self.rate
                waited += deficit
                await asyncio.sleep(deficit)

    def try_take(self, n: float = 1.0) -> bool:
        now = time.monotonic()
        self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
        self._last = now
        if self._tokens >= n:
            self._tokens -= n
            return True
        return False


class HttpClient:
    """Keep-alive HTTP/1.1 client over `aiohttp`, with a pre-warm step."""

    def __init__(self, base_url: str = "", pool_size: int = 8,
                 timeout_s: float = 4.0, rate_per_s: float = 18.0,
                 warm_path: str = "", user_agent: str = "pm-arb-engine/0.1") -> None:
        if not AIOHTTP_AVAILABLE:  # pragma: no cover
            raise RuntimeError(
                "aiohttp is required for network I/O — `pip install -r "
                "requirements-engine.txt`. Pure-computation paths (book, graph, "
                "sizing, execution against a stub router) do not need it.")
        self.base_url = base_url.rstrip("/")
        self.pool_size = pool_size
        self.timeout_s = timeout_s
        self.warm_path = warm_path
        self.bucket = TokenBucket(rate_per_s)
        self._session: Any = None
        self._ua = user_agent
        self.requests = 0
        self.errors = 0
        self.rate_limited = 0

    async def start(self) -> "HttpClient":
        connector = aiohttp.TCPConnector(
            limit=self.pool_size, limit_per_host=self.pool_size,
            ttl_dns_cache=300, keepalive_timeout=90.0, force_close=False,
            enable_cleanup_closed=True)
        self._session = aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=self.timeout_s),
            headers={"User-Agent": self._ua})
        if self.warm_path:
            await self.warm()
        return self

    async def warm(self) -> int:
        """Open and TLS-negotiate every pooled connection up front.

        Fired concurrently so the connector is forced to actually create
        `pool_size` sockets rather than reusing one.
        """
        if not self.warm_path:
            return 0
        url = f"{self.base_url}{self.warm_path}"

        async def one() -> bool:
            try:
                async with self._session.get(url) as r:
                    await r.read()
                    return r.status < 500
            except Exception:  # noqa: BLE001
                return False

        results = await asyncio.gather(*(one() for _ in range(self.pool_size)),
                                       return_exceptions=True)
        return sum(1 for r in results if r is True)

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def request_json(self, method: str, url: str,
                           params: Mapping[str, Any] | None = None,
                           headers: Mapping[str, str] | None = None,
                           data: str | None = None,
                           weight: float = 1.0) -> Any:
        if self._session is None:
            raise VenueError("http client not started")
        await self.bucket.take(weight)
        self.requests += 1
        try:
            async with self._session.request(method, url, params=params,
                                             headers=headers, data=data) as r:
                body = await r.text()
                if r.status == 429 or r.status == 418:
                    self.rate_limited += 1
                    raise RateLimited(f"{r.status} from {url}", body,
                                      float(r.headers.get("Retry-After", 1.0)))
                if r.status >= 400:
                    self.errors += 1
                    raise VenueError(f"HTTP {r.status} from {url}: {body[:200]}",
                                     body, retriable=r.status >= 500)
                try:
                    return json.loads(body)
                except ValueError as e:
                    raise VenueError(f"non-JSON from {url}: {body[:120]}", body) from e
        except asyncio.TimeoutError as e:
            self.errors += 1
            raise VenueError(f"timeout on {url}", None, retriable=True) from e
        except aiohttp.ClientError as e:  # pragma: no cover - network dependent
            self.errors += 1
            raise VenueError(f"client error on {url}: {e}", None, retriable=True) from e

    async def get_json(self, url: str, params: Mapping[str, Any] | None = None,
                       weight: float = 1.0) -> Any:
        return await self.request_json("GET", url, params=params, weight=weight)

    def stats(self) -> dict:
        return {"requests": self.requests, "errors": self.errors,
                "rateLimited": self.rate_limited}
