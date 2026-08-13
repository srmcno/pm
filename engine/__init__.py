"""Event-driven, sub-100 ms triangular / cross-venue arbitrage engine.

The `scripts/arb.py` desk polls REST on a ~25 s cycle: by the time it sees an
edge, the edge is a historical artifact. This package replaces the polling loop
with a push architecture — WebSocket L2 deltas into an in-memory book, dirty-node
triggered cycle evaluation, and IOC leg chaining driven off private fill pushes.

Layout:

    config      tunables, venue specs, hard risk rails
    clock       monotonic timing + latency histograms
    book        L2 order book, delta application, sequence-gap detection, walks
    shm         seqlock shared-memory slab (ingestion process -> compute process)
    feed        WebSocket connection pool, sharding, resync orchestration
    venues/     per-venue wire adapters (mexc, gate) behind one protocol
    graph       directed graph, -log edge weights, Bellman-Ford + 3-cycle eval
    sizing      exchange filters and the depth-walking size solver
    risk        rails, balance ledger, kill switch
    execution   async execution manager: IOC chaining, partial fills, unwind
    telemetry   T+25/100/500 ms decay benchmarks, edge survival, latency
    crossvenue  synthetic MEXC/Gate spread monitor
    runtime     process wiring and supervision

Nothing here trades without explicit arming — see `engine.risk` and the
checklist in `docs/ARCHITECTURE.md`.
"""

__version__ = "0.1.0"
