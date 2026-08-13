"""Directed exchange graph, cycle enumeration, and the two pathfinders.

The model
---------
G = (V, E). Vertices are currencies. Each listed pair contributes **two**
directed edges, because crossing the book is asymmetric:

    quote -> base   "buy",  rate = (1 / ask) * (1 - taker)
    base  -> quote  "sell", rate = bid * (1 - taker)

Edge weight is w = -ln(rate). A cycle is profitable exactly when its weight sum
is negative, and the profit is `exp(-sum) - 1`. Working in logs turns the
product into a sum, which is what makes Bellman-Ford applicable at all — and,
less obviously, keeps a 6-leg cycle from underflowing a float32-ish product.

Two pathfinders, because one is not enough
------------------------------------------
`bellman_ford_cycles` is the *discovery* pass: O(V·E), finds negative cycles of
any length, and at V≈1,500 / E≈4,600 costs roughly 7M relaxations — call it
1-3 s of pure Python. That is a background job, not a per-tick job. It runs on a
cadence to answer "is there a 4- or 5-leg route we never enumerated?"

`CycleIndex.evaluate_dirty` is the *hot* path: triangles are enumerated once at
startup and inverted by symbol, so a book mutation on `FOOUSDT` re-prices only
the handful of cycles that touch `FOOUSDT` — typically 2 to 20 of them, each
three multiplies. That is single-digit microseconds, and it is the only thing
that runs on every frame.

Honest limit: top-of-book screening says an edge *might* exist. It is not a
tradable number — only `sizing.solve_cycle_size`, which walks real depth, is.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Callable, Iterable, Mapping, Sequence

__all__ = [
    "BUY", "SELL", "Quote", "Leg", "Triangle", "CycleIndex", "Opportunity",
    "build_edges", "bellman_ford_cycles", "cycle_rate", "NEG_INF",
]

BUY = 0    # quote -> base, crosses the ask
SELL = 1   # base -> quote, crosses the bid

NEG_INF = float("-inf")

# A quote is (bid, bid_qty, ask, ask_qty) — the same 4-tuple the venue's
# book-ticker gives, so the screening path never allocates an object.
Quote = tuple[float, float, float, float]


class Leg:
    """One directed conversion: which symbol, which side, at what fee."""

    __slots__ = ("symbol", "side", "fee", "src", "dst")

    def __init__(self, symbol: str, side: int, fee: float, src: str, dst: str) -> None:
        self.symbol = symbol
        self.side = side
        self.fee = fee
        self.src = src
        self.dst = dst

    def rate(self, q: Quote) -> float:
        """Net conversion rate from this leg's top of book, 0.0 if unusable."""
        if self.side == BUY:
            ask = q[2]
            return (1.0 / ask) * (1.0 - self.fee) if ask > 0.0 else 0.0
        bid = q[0]
        return bid * (1.0 - self.fee) if bid > 0.0 else 0.0

    def as_tuple(self) -> tuple[str, str]:
        return self.symbol, ("buy" if self.side == BUY else "sell")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Leg {self.src}->{self.dst} {self.symbol} {'buy' if self.side == BUY else 'sell'}>"


class Triangle:
    """A closed 3-leg cycle through the quote asset, pre-flattened for speed.

    `fee_const` folds all three (1 - taker) terms into one multiply, and the
    per-leg symbol/side are hoisted into plain attributes so `rate_from` does no
    attribute chasing inside the loop.
    """

    __slots__ = ("legs", "path", "symbols", "fee_const", "key", "cid",
                 "s0", "s1", "s2", "d0", "d1", "d2")

    def __init__(self, legs: Sequence[Leg], cid: int = -1) -> None:
        self.legs = tuple(legs)
        self.cid = cid
        self.symbols = tuple(l.symbol for l in legs)
        self.path = "→".join([legs[0].src] + [l.dst for l in legs])
        self.fee_const = 1.0
        for l in legs:
            self.fee_const *= (1.0 - l.fee)
        self.key = "|".join(f"{l.symbol}:{l.side}" for l in legs)
        # Hoisted hot fields: symbol, side per leg.
        self.s0, self.s1, self.s2 = (l.symbol for l in legs)
        self.d0, self.d1, self.d2 = (l.side for l in legs)

    def rate_from(self, quotes: Mapping[str, Quote]) -> float:
        """Gross multiplier at top of book, or 0.0 if any leg is unpriced.

        Hand-unrolled: this runs tens of thousands of times a second and the
        loop overhead was measurable against the three multiplies it wraps.
        """
        q = quotes.get(self.s0)
        if q is None:
            return 0.0
        if self.d0 == BUY:
            a = q[2]
            if a <= 0.0:
                return 0.0
            m = 1.0 / a
        else:
            b = q[0]
            if b <= 0.0:
                return 0.0
            m = b
        q = quotes.get(self.s1)
        if q is None:
            return 0.0
        if self.d1 == BUY:
            a = q[2]
            if a <= 0.0:
                return 0.0
            m /= a
        else:
            b = q[0]
            if b <= 0.0:
                return 0.0
            m *= b
        q = quotes.get(self.s2)
        if q is None:
            return 0.0
        if self.d2 == BUY:
            a = q[2]
            if a <= 0.0:
                return 0.0
            m /= a
        else:
            b = q[0]
            if b <= 0.0:
                return 0.0
            m *= b
        return m * self.fee_const

    def bps_from(self, quotes: Mapping[str, Quote]) -> float:
        m = self.rate_from(quotes)
        return (m - 1.0) * 10_000.0 if m > 0.0 else NEG_INF

    def top_of_book_capacity(self, quotes: Mapping[str, Quote]) -> float:
        """Quote-currency notional available at leg 1's touch.

        A cheap pre-filter before the depth walk: if the best ask holds $3 and
        the minimum viable stake is $5, the walk will fail anyway.
        """
        q = quotes.get(self.s0)
        if q is None:
            return 0.0
        return q[3] * q[2] if self.d0 == BUY else q[1] * q[0]

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Triangle {self.path}>"


class Opportunity:
    """A screened cycle plus whatever verification has been done to it."""

    __slots__ = ("tri", "screen_bps", "verified_bps", "size_usd", "profit_usd",
                 "detected_ns", "legs_plan", "book_seqs", "capacity_usd")

    def __init__(self, tri: Triangle, screen_bps: float, detected_ns: int = 0) -> None:
        self.tri = tri
        self.screen_bps = screen_bps
        self.detected_ns = detected_ns
        self.verified_bps = NEG_INF
        self.size_usd = 0.0
        self.profit_usd = 0.0
        self.capacity_usd = 0.0
        self.legs_plan: list = []
        self.book_seqs: dict[str, int] = {}

    @property
    def path(self) -> str:
        return self.tri.path

    def as_dict(self) -> dict:
        return {
            "path": self.tri.path,
            "legs": [list(l.as_tuple()) for l in self.tri.legs],
            "screenBps": round(self.screen_bps, 2),
            "verifiedBps": (round(self.verified_bps, 2)
                            if self.verified_bps > NEG_INF else None),
            "sizeUsd": round(self.size_usd, 4),
            "profitUsd": round(self.profit_usd, 6),
            "capacityUsd": round(self.capacity_usd, 2),
        }

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Opp {self.tri.path} screen={self.screen_bps:.1f}bps>"


# --------------------------------------------------------------- construction

def build_adjacency(symbols: Mapping[str, Mapping]) -> dict[str, list[Leg]]:
    """currency -> outgoing legs, from a {symbol: {base, quote, taker}} map."""
    adj: dict[str, list[Leg]] = defaultdict(list)
    for sym, meta in symbols.items():
        base, quote = meta["base"], meta["quote"]
        fee = float(meta.get("taker", 0.0005))
        adj[quote].append(Leg(sym, BUY, fee, quote, base))
        adj[base].append(Leg(sym, SELL, fee, base, quote))
    return adj


class CycleIndex:
    """Enumerated cycles plus the symbol -> cycles inverted index.

    Enumeration is general: every 3-cycle that starts and ends at `quote` is
    found, which subsumes the hand-written USDT->A->bridge->USDT template and
    also picks up bridge-to-bridge routes (USDT->BTC->ETH->USDT) that the
    template never expressed.
    """

    def __init__(self, symbols: Mapping[str, Mapping], quote: str = "USDT",
                 bridges: Iterable[str] | None = None,
                 max_cycles: int = 200_000) -> None:
        self.quote = quote
        self.symbols = dict(symbols)
        self.bridges = set(bridges or ())
        self.adj = build_adjacency(symbols)
        self.triangles: list[Triangle] = []
        self.by_symbol: dict[str, list[int]] = defaultdict(list)
        self._enumerate(max_cycles)

    def _enumerate(self, max_cycles: int) -> None:
        quote = self.quote
        adj = self.adj
        # Reverse lookup: which legs land *on* the quote asset. Building this
        # once turns the innermost test from a scan into a dict hit.
        into_quote: dict[str, Leg] = {}
        for cur, legs in adj.items():
            for leg in legs:
                if leg.dst == quote and cur not in into_quote:
                    into_quote[cur] = leg
        cid = 0
        seen: set[str] = set()
        for leg1 in adj.get(quote, ()):
            mid = leg1.dst
            for leg2 in adj.get(mid, ()):
                end = leg2.dst
                if end == quote or end == mid:
                    continue
                leg3 = into_quote.get(end)
                if leg3 is None or leg3.symbol == leg2.symbol:
                    continue
                tri = Triangle((leg1, leg2, leg3), cid)
                if tri.key in seen:
                    continue
                seen.add(tri.key)
                self.triangles.append(tri)
                for s in tri.symbols:
                    self.by_symbol[s].append(cid)
                cid += 1
                if cid >= max_cycles:
                    return

    # ------------------------------------------------------------- hot path

    def evaluate_dirty(self, dirty: Iterable[str], quotes: Mapping[str, Quote],
                       min_bps: float, detected_ns: int = 0,
                       seen_ids: set[int] | None = None) -> list[Opportunity]:
        """Re-price only the cycles touching the mutated symbols.

        This is the whole point of the event-driven rewrite: a frame on one
        symbol costs `len(by_symbol[sym])` triangle evaluations, not 40,000.
        `seen_ids` deduplicates cycles reachable from two dirty symbols in the
        same batch — pass a fresh set per batch.
        """
        out: list[Opportunity] = []
        tris = self.triangles
        by_symbol = self.by_symbol
        seen = seen_ids if seen_ids is not None else set()
        for sym in dirty:
            ids = by_symbol.get(sym)
            if not ids:
                continue
            for cid in ids:
                if cid in seen:
                    continue
                seen.add(cid)
                tri = tris[cid]
                m = tri.rate_from(quotes)
                if m <= 0.0:
                    continue
                bps = (m - 1.0) * 10_000.0
                if bps >= min_bps:
                    opp = Opportunity(tri, bps, detected_ns)
                    opp.capacity_usd = tri.top_of_book_capacity(quotes)
                    out.append(opp)
        out.sort(key=lambda o: -o.screen_bps)
        return out

    def evaluate_all(self, quotes: Mapping[str, Quote],
                     min_bps: float, detected_ns: int = 0) -> list[Opportunity]:
        """Full sweep — startup warm-up and the periodic consistency check."""
        out = []
        for tri in self.triangles:
            m = tri.rate_from(quotes)
            if m <= 0.0:
                continue
            bps = (m - 1.0) * 10_000.0
            if bps >= min_bps:
                opp = Opportunity(tri, bps, detected_ns)
                opp.capacity_usd = tri.top_of_book_capacity(quotes)
                out.append(opp)
        out.sort(key=lambda o: -o.screen_bps)
        return out

    def touching(self, symbol: str) -> list[Triangle]:
        return [self.triangles[i] for i in self.by_symbol.get(symbol, ())]

    def stats(self) -> dict:
        deg = [len(v) for v in self.by_symbol.values()]
        return {
            "currencies": len(self.adj),
            "symbols": len(self.symbols),
            "triangles": len(self.triangles),
            "maxCyclesPerSymbol": max(deg) if deg else 0,
            "meanCyclesPerSymbol": round(sum(deg) / len(deg), 1) if deg else 0.0,
        }


# ------------------------------------------------------------- Bellman-Ford

def build_edges(adj: Mapping[str, Sequence[Leg]], quotes: Mapping[str, Quote],
                ) -> tuple[list[str], dict[str, int], list[tuple[int, int, float, Leg]]]:
    """Materialize (u, v, -ln(rate), leg) edges for the currently priced legs.

    Legs whose book is empty are omitted entirely rather than given an infinite
    weight — an unpriced pair must not participate in a route at all.
    """
    verts: list[str] = []
    idx: dict[str, int] = {}

    def vid(name: str) -> int:
        i = idx.get(name)
        if i is None:
            i = len(verts)
            idx[name] = i
            verts.append(name)
        return i

    edges: list[tuple[int, int, float, Leg]] = []
    for cur, legs in adj.items():
        for leg in legs:
            q = quotes.get(leg.symbol)
            if q is None:
                continue
            r = leg.rate(q)
            if r <= 0.0:
                continue
            edges.append((vid(leg.src), vid(leg.dst), -math.log(r), leg))
    return verts, idx, edges


def bellman_ford_cycles(adj: Mapping[str, Sequence[Leg]],
                        quotes: Mapping[str, Quote],
                        max_cycles: int = 25,
                        max_len: int = 6,
                        min_bps: float = 1.0) -> list[dict]:
    """Find negative-weight cycles (i.e. profitable routes) of any length.

    Standard virtual-source formulation: every vertex starts at distance 0,
    which is equivalent to adding a source with zero-weight edges everywhere,
    so cycles in *any* component are reachable. After V-1 passes any further
    relaxation proves a negative cycle; walking the predecessor chain V times
    from the relaxed vertex lands inside it.

    Cost is O(V·E) — deliberately *not* on the hot path. Run it every few
    seconds on a worker to discover routes the 3-cycle enumeration cannot
    express, then promote anything real into the static index.
    """
    verts, idx, edges = build_edges(adj, quotes)
    n = len(verts)
    if n == 0 or not edges:
        return []
    dist = [0.0] * n
    pred: list[int] = [-1] * n
    pred_leg: list[Leg | None] = [None] * n

    updated_at = -1
    for _ in range(n):
        updated_at = -1
        for u, v, w, leg in edges:
            nd = dist[u] + w
            if nd < dist[v] - 1e-12:
                dist[v] = nd
                pred[v] = u
                pred_leg[v] = leg
                updated_at = v
        if updated_at < 0:
            return []                       # settled: no negative cycle
    # `updated_at` was relaxed on the n-th pass, so it is reachable from a
    # negative cycle. Walk back n times to land *on* the cycle itself.
    found: list[dict] = []
    seen_keys: set[str] = set()
    x = updated_at
    for _ in range(n):
        x = pred[x]
        if x < 0:
            return []

    cycles_to_try = [x]
    # Also probe other vertices relaxed in the final pass, to surface more than
    # one disjoint cycle per call.
    for u, v, w, leg in edges:
        if dist[u] + w < dist[v] - 1e-12 and v not in cycles_to_try:
            cycles_to_try.append(v)
            if len(cycles_to_try) >= max_cycles * 3:
                break

    for start in cycles_to_try:
        cyc: list[int] = []
        legs: list[Leg] = []
        v = start
        guard = 0
        # Walk back to the first repeated vertex — that closes the cycle.
        pos: dict[int, int] = {}
        while v not in pos and guard <= n:
            pos[v] = len(cyc)
            cyc.append(v)
            lg = pred_leg[v]
            if lg is None or pred[v] < 0:
                break
            legs.append(lg)
            v = pred[v]
            guard += 1
        if v not in pos:
            continue
        cut = pos[v]
        cycle_v = cyc[cut:]
        cycle_l = legs[cut:cut + len(cycle_v)]
        if len(cycle_l) != len(cycle_v) or not cycle_l:
            continue
        if len(cycle_v) > max_len:
            continue
        ordered = list(reversed(cycle_l))     # predecessors walk backwards
        m = 1.0
        for leg in ordered:
            q = quotes.get(leg.symbol)
            if q is None:
                m = 0.0
                break
            m *= leg.rate(q)
        if m <= 0.0:
            continue
        bps = (m - 1.0) * 10_000.0
        if bps < min_bps:
            continue
        key = "|".join(f"{l.symbol}:{l.side}" for l in ordered)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        found.append({
            "legs": [list(l.as_tuple()) for l in ordered],
            "path": "→".join([ordered[0].src] + [l.dst for l in ordered]),
            "bps": round(bps, 2),
            "length": len(ordered),
        })
        if len(found) >= max_cycles:
            break
    found.sort(key=lambda c: -c["bps"])
    return found


def cycle_rate(legs: Sequence[Leg], quotes: Mapping[str, Quote]) -> float:
    """Gross multiplier of an arbitrary-length cycle at top of book."""
    m = 1.0
    for leg in legs:
        q = quotes.get(leg.symbol)
        if q is None:
            return 0.0
        r = leg.rate(q)
        if r <= 0.0:
            return 0.0
        m *= r
    return m


def quotes_from_slab(slab, symbols: Sequence[str],
                     out: dict[str, Quote] | None = None,
                     slots: Sequence[int] | None = None) -> dict[str, Quote]:
    """Refresh a quote dict from the shared-memory slab.

    Reads only the requested slots, so the compute loop can pass the dirty set
    from `BookSlab.changed_since` and touch nothing else.
    """
    out = {} if out is None else out
    it = slots if slots is not None else range(len(symbols))
    for i in it:
        view = slab.read_slot(i)
        if view is None or not view.live:
            continue
        b = view.bid_levels[0] if view.bid_levels else (0.0, 0.0)
        a = view.ask_levels[0] if view.ask_levels else (0.0, 0.0)
        out[view.symbol] = (b[0], b[1], a[0], a[1])
    return out
