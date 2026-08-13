# Sub-100 ms arbitrage engine — architecture

Replaces the ~25 s REST polling loop in `scripts/arb.py` with a push
architecture: WebSocket L2 deltas into an in-memory book, dirty-node triggered
cycle evaluation, and IOC leg chaining driven off private fill pushes.

Read [The three constraints](#0-the-three-constraints-that-shape-everything)
first. Two of them are venue facts that cannot be engineered around, and they
change what "sub-100 ms" can mean here.

---

## 0. The three constraints that shape everything

### 0.1 MEXC has no order-entry WebSocket

The brief asks for "private WS order routing (not REST) to remove connection
handshakes." On **Gate.io that is achievable** — WS v4 exposes
`spot.order_place`. On **MEXC it is not**: orders go over `POST /api/v3/order`,
and the WebSocket carries market data and a private user-data stream only.

The good news is that the *latency* the requirement is chasing is still
recoverable, because it lives in two places and only one of them is the
request protocol:

| Cost | Cause | Fix here |
|---|---|---|
| ~1-2 RTT per order | cold TCP + TLS handshake | pre-warmed keep-alive pool (`engine/net.py`), handshake amortized to zero |
| ~350 ms **per leg** | `sleep(0.35)` then `GET /api/v3/order` to learn the fill | private-stream fill push resolves an `asyncio.Future` (`MexcRouter.wait_fill`) |

The second row is the real prize. `scripts/arblive.py` spends roughly a second
of dead time per triangle polling for its own fills — more than the entire
latency budget. MEXC's order ack does not carry fill quantities (there is no
`newOrderRespType`), so the private stream is not an optimization, it is the
only low-latency way to learn what filled.

`OrderRouter` (`engine/venues/base.py`) abstracts this: `GateRouter` genuinely
sends over the socket, `MexcRouter` sends over warm REST. The execution manager
never learns which is which.

### 0.2 MEXC allows 30 subscriptions per socket

2,100 pairs ⇒ **70 sockets**, not one. The connection pool is a requirement of
the venue, not an optimization, and it is why `engine/feed.py` shards. Sockets
also die at 24 h by policy, so transports recycle themselves early — a planned
reconnect beats an unplanned one mid-cycle.

    python3 -m engine plan     # prints this arithmetic for your live universe

### 0.3 Where the process runs dominates everything the code does

Tick-to-trade is `network + compute + network`. The compute half measures in
**tens of microseconds** (§4). The network half is set by geography:

| Host | RTT to MEXC | Sub-100 ms tick-to-trade? |
|---|---|---|
| GitHub Actions runner (current) | ~150-250 ms | **No.** Not by any margin, in any language. |
| Home connection, EU/US | ~200-300 ms | No |
| VPS, US-east | ~180 ms | No |
| VPS, Tokyo / Singapore (`ap-northeast-1`, `ap-southeast-1`) | ~5-40 ms | Yes |

This is the single highest-leverage change in the whole project, and it is a
hosting decision, not a code one. Running this engine on the existing Actions
runner would replace a 25 s disadvantage with a 250 ms disadvantage — a genuine
100× improvement, and still last place against anything colocated. **Before
arming real money, move the process to a VPS in the venue's metro.** The
architecture below assumes that has happened.

---

## 1. Data flow

```
   MEXC / Gate WebSocket (70 sockets, 30 subs each)
              │  protobuf / JSON depth deltas
              ▼
┌─────────────────────────────────────────────────────────────┐
│ INGESTION SHARD  × N processes            engine/feed.py    │
│  ├ decode frame                     venues/{mexc,gate}.py   │
│  ├ sequence check (strict / overlap)      engine/book.py    │
│  ├ apply delta      ~1.7 µs               engine/book.py    │
│  ├ gap? → queue resync (never awaits)                       │
│  └ publish if top-of-book moved  ~10 µs    engine/shm.py    │
└──────────────────────────┬──────────────────────────────────┘
                           │ seqlock, no locks either side
                           ▼
              [ SHARED-MEMORY BOOK SLAB ]   1.8 MB / 2,700 symbols
                           │  dirty scan 30 µs · read 5 µs
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ COMPUTE ENGINE   1 process               engine/runtime.py  │
│  ├ refresh quotes for dirty symbols only                    │
│  ├ evaluate_dirty()  1.3 µs / symbol      engine/graph.py   │
│  │     inverted index: symbol → its cycles                  │
│  ├ solve_cycle_size()  5 µs              engine/sizing.py   │
│  │     depth walk + lot quantization + bisection            │
│  ├ decay probes T+25/100/500 ms       engine/telemetry.py   │
│  └ Bellman-Ford discovery sweep (background thread, ~1 s)   │
└──────────────────────────┬──────────────────────────────────┘
                           │ CyclePlan (priced, filter-legal)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ EXECUTION WORKER   1 process, async     engine/execution.py │
│  ├ risk gate (re-checked per leg)          engine/risk.py   │
│  ├ leg 1  FOK  ─── no fill → free abort                     │
│  ├ continue-vs-exit decision on the LIVE book               │
│  ├ leg 2  IOC  ─── sized from the ACTUAL leg-1 fill         │
│  ├ leg 3  IOC  ─── failure → aggressive hedge to quote      │
│  └ unwind router: direct pair, else 2-hop escape            │
└─────────────────────────────────────────────────────────────┘
       ▲ fills                                    │ orders
       │ private WS push                          ▼
   MEXC user-data stream / Gate spot.orders   warm REST / spot.order_place
```

### Why processes, not threads

The GIL. Decoding ~21,000 frames/s and evaluating cycles are both CPU-bound
Python; as threads they take turns, and the turn boundary lands at the worst
possible microsecond. So ingestion shards are separate processes publishing
into `multiprocessing.shared_memory`, and the compute process reads through a
**seqlock** — writers never block readers, readers never block writers.

Single-process mode (the default) runs everything on one event loop with a
direct dirty callback. Flipping to multi-process changes nothing above the
slab; that seam is the reason the slab exists.

### Why the resync cannot be inline

A sequence gap means a REST snapshot: 5-50 ms of network. Awaiting that inside
the frame loop stalls *every other symbol on that socket* — one thin micro-cap
dropping a frame would blind the engine to 29 others. So a gap does three O(1)
things (mark `SYNCING`, enqueue, keep reading) and a bounded-concurrency worker
drains the queue while the book buffers deltas.

---

## 2. Technology stack

### Recommendation: **Rust for the ingestion + compute path, Python for the rest** — but not yet

The honest sequencing matters more than the language:

**Now — Python 3.12 + uvloop (this implementation).** The compute path is
already 10-100× inside the budget (§4). Nothing about Python is the bottleneck
when the network is 5-40 ms. Ship this, colocate it, and let the telemetry
answer whether the edge survives at all.

**Only if telemetry says the edge lives in the 1-10 ms band — rewrite ingestion
and compute in Rust.** Signals that this threshold has been crossed:
`engine.json` shows meaningful capture at T+25 ms but near-zero at T+100 ms;
or shard decode CPU saturates a core.

| Option | Verdict |
|---|---|
| **Rust** (`tokio`, `fastwebsockets`, `simd-json`, `rust_decimal`) | The right destination. No GC pauses, real threads, 1-5 µs tick-to-signal. Cost: ~4-6× the development time and a much slower iteration loop for strategy work. |
| **C++** (`Boost.Beast`, `Seastar`) | Marginally faster than Rust in expert hands; materially more ways to strand inventory via a use-after-free in the execution path. Rust's ownership model is worth more here than the last microsecond. |
| **Go** | Good sockets and real concurrency, but a stop-the-world GC pause lands in the 100 µs-1 ms range at exactly the wrong time. Fine for the telemetry/dashboard tier. |
| **Python + uvloop + C extensions** | What this is. Adequate *while the network dominates*, which is the current regime by two orders of magnitude. Also keeps this codebase in one language. |
| **Java/JVM** | Excellent JIT throughput, but warm-up and GC tuning are a project of their own. |

**Concrete stack as built:**

| Layer | Choice | Why |
|---|---|---|
| Event loop | `asyncio` + **uvloop** | 2-4× lower loop overhead; one line to enable |
| WebSocket | `websockets` | no compression (`compression=None` — a 40 µs inflate per frame is pure latency) |
| HTTP | `aiohttp` with a **pre-warmed** pool | handshake cost amortized to zero |
| Wire decode | schema-free protobuf reader | no `protoc` step to run; validates before trusting |
| Books | sorted `list` + `dict` per side | delta = O(1) dict store; structural change = C-level `insort` |
| IPC | `multiprocessing.shared_memory` seqlock | lock-free, 1.8 MB, no serialization |
| Numerics | plain `float` in log space | `Decimal` is ~50× slower; f64 has 15 digits and prices need 8 |

**Deployment:** a VPS in `ap-northeast-1` or `ap-southeast-1` (§0.3), pinned
CPU, `chrt`/`taskset` for the ingestion shards, `net.core.rmem_max` raised.
NTP-disciplined clock for wall timestamps only — every *duration* uses
`perf_counter_ns` so an NTP step can never produce a negative latency.

---

## 3. The graph engine

Vertices are currencies. Each pair contributes **two** directed edges, because
crossing the book is asymmetric:

```
quote → base   "buy",   rate = (1 / ask) × (1 − taker)
base  → quote  "sell",  rate = bid × (1 − taker)
weight w = −ln(rate);   cycle profitable ⟺ Σw < 0;   profit = e^(−Σw) − 1
```

**Two pathfinders, because one is not enough.**

`CycleIndex.evaluate_dirty` is the hot path. Triangles are enumerated once at
startup and inverted by symbol, so a frame on `FOOUSDT` re-prices only the
cycles touching `FOOUSDT` — a mean of 3, worst case ~270 — at three multiplies
each. **1.3 µs**, versus 0.6 ms for the full sweep the polling desk did.

`bellman_ford_cycles` is the discovery pass: O(V·E), finds negative cycles of
*any* length, runs on a background thread every 15 s. Its job is to notice that
a 4-leg route has been quietly profitable all afternoon — not to trade a tick.
Both agree on the same cycles where their domains overlap, which is asserted in
`tests/test_engine.py::test_bellman_ford_agrees_with_triangle_index`.

Enumeration is **general** — every 3-cycle through the quote asset — which
subsumes the hardcoded `USDT→A→bridge→USDT` template in `scripts/arb.py` and
also finds bridge-to-bridge routes (`USDT→BTC→ETH→USDT`) the template could
not express.

### Sizing: solve continuously, then quantize, then re-verify

Cycle yield is **monotonically non-increasing in size** — every extra unit
fills at a weakly worse price on at least one leg — so bisection is valid and
exact. `solve_cycle_size` finds the largest size that still clears the bar,
rather than testing three hardcoded candidates.

The part that is easy to get wrong: **lot and notional filters**. A cycle sized
at $7.31 whose leg-2 quantity rounds down to a step boundary hands leg 3 less
than the plan assumed, and that residue is an open position in a micro-cap. So
sizing runs continuously first (smooth, bisectable), then quantizes, then
**re-prices the quantized plan** and keeps it only if it still clears. Yield is
measured against `deployed_usd` — what leg 1 actually spends — not against the
requested size.

---

## 4. Measured performance

2,720-symbol synthetic universe, single core, CPython 3.11, no JIT:

| Operation | Time | Note |
|---|---|---|
| Book delta apply (1 level, 400-level book) | **1.7 µs** | 590k frames/s |
| Book delta apply (5 levels) | 3.3 µs | 302k frames/s |
| `evaluate_dirty` (1 symbol) | **1.3 µs** | the per-frame cost |
| `evaluate_dirty` (100 symbols) | 48 µs | a busy batch |
| `evaluate_all` (1,466 cycles) | 0.6 ms | *the cost the old design paid every scan* |
| `simulate_cycle` (3 × 20-level walk) | 5.9 µs | |
| `solve_cycle_size` (bisection + quantize) | 4.7 µs | |
| Slab write / read (20 levels/side) | 10 µs / 5 µs | |
| Dirty scan, 2,720 slots | **30 µs** | contiguous seq prefix |
| Cycle index build | 9 ms | once, at startup |

**Tick-to-signal is therefore ~10-60 µs.** At 2,100 symbols on MEXC's 100 ms
aggregate channel the steady-state load is ~21,000 frames/s ⇒ roughly 0.2 core
for decode+apply and 0.03 core for evaluation. The budget is spent almost
entirely on the wire, which is exactly the regime §0.3 describes.

Two optimizations paid for themselves during development and are worth keeping
in mind if you change the layout:

* Sequence counters live in a **contiguous prefix array**, not inside their
  672-byte slots. One bulk `unpack_from` instead of 2,720 strided reads:
  **468 µs → 30 µs**.
* Books publish to the slab only when the **touch moves**, or when the symbol
  is in the compute engine's *hot set* (under active sizing). Screening needs
  only top-of-book; the ~2,000 symbols nobody is trading skip the 10 µs write.

---

## 5. Execution: what actually protects the money

A triangle is not an atomic trade. It is three orders that can each fill fully,
partially, or not at all, against books that move between them.

1. **Leg 1 is FOK by default.** No fill ⇒ nothing at risk ⇒ the cycle costs
   zero. A *partial* leg 1 is not a smaller trade; it is an unhedged micro-cap
   position, the most expensive thing this system can do to itself.

2. **Every later leg is sized from the actual fill**, re-quantized. Sizing
   leg 2 from the plan is how a bot cancels into a hole.

3. **After leg 1, continuing is a decision, not a reflex.** `_choose_exit`
   prices *finishing legs 2-3* against *selling straight back to the quote*, on
   the live book, and takes the better. `scripts/arblive.py` always continues —
   which loses money precisely when the book has moved, the case that matters.

4. **Unwind first, ask later.** A failed leg triggers an immediate aggressive
   IOC crossing `unwind_cross_bps` through the bid, doubling on each retry. If
   the direct pair is the one that just broke, the router escapes through a
   **two-hop route** (`USDC → FOO → USDT`) rather than sitting on the bag.

5. **Rails are re-checked per leg.** A signal that cleared the gate 40 ms ago
   is not a permission slip. Balances move, the daily counter moves, and the
   STOP file can appear between the decision and leg 3.

6. **Stranded inventory halts the engine.** A bot that keeps trading while
   quietly accumulating micro-caps is not running a strategy; it is buying a
   bag one failed cycle at a time.

`python3 -m engine selftest` exercises all of this against a simulated venue
that fills, partially fills, and refuses — everything downstream of the socket
is the production code:

```
[PASS] clean fill     COMPLETE   plan 118.9bps $10.00 → realized  +118.9bps
[PASS] leg 3 fails    UNWOUND    plan 118.9bps $10.00 → realized  -187.7bps   ← escaped via FOO
[PASS] leg 1 partial  COMPLETE   plan 118.9bps $10.00 → realized  +117.4bps   ← legs resized
[PASS] leg 2 partial  COMPLETE   plan 118.9bps $10.00 → realized   +46.5bps
[PASS] leg 1 no fill  NO_FILL    plan 118.9bps $10.00 → realized    +0.0bps   ← free abort
```

That −187.7 bps is the point: a failed third leg costs ~19 bps of the stake
instead of the whole position.

---

## 6. Telemetry: the number that decides whether to continue

`DecayTracker` re-prices each signalled cycle against the live book at
**T+25 ms, T+100 ms, T+500 ms** and reports the surviving fraction.

**If capture at T+100 ms is already near zero, no amount of further engineering
matters** — the edge is gone before any router could reach it, and the correct
action is to stop, not to optimize. That is the same lesson the Polymarket
backtest in this repo taught at 1 h and 3 h delays, measured here in
milliseconds.

`SurvivalTracker` reports how long each dislocation persists from first sight
to disappearance — median survival is the single most useful number for
deciding whether to chase an edge at all. `LatencyBudget` attributes
tick-to-trade across decode → apply → evaluate → send → ack → fill, so a
regression is attributable rather than merely visible.

Everything lands in `dashboard/data/engine.json`, written atomically.

---

## 7. Running it

```bash
python3 -m unittest discover -s tests    # 62 tests, stdlib only
python3 -m engine selftest               # full pipeline, simulated venue
python3 -m engine plan                   # universe + socket arithmetic

pip install -r requirements-engine.txt
python3 -m engine run                    # paper: real feeds, no orders
python3 -m engine run --live             # ARMED (see the checklist)
```

### Before arming

1. `MEXC_API_KEY` / `MEXC_API_SECRET` set, **SPOT TRADE only, never withdrawal**.
2. Process running in the venue's metro (§0.3). Anything else is a donation.
3. `data/arb/STOP` absent — `RiskEngine.halt()` writes it and only a human removes it.
4. `RiskLimits` reviewed. Defaults: $20 bankroll, $10/cycle, $2 daily loss.
5. **`engine.json` shows a real `decay` block from paper mode.** If T+100 ms
   capture is near zero, do not arm.
6. Protobuf field discovery verified against a live frame — the reader in
   `engine/venues/protobuf.py` finds the depth body by structure and
   sanity-checks it, but generating stubs with `protoc` is the production path.
7. Gate WS order entry (`GateRouter(use_ws=True)`) verified against Gate's
   current `spot.order_place` envelope. It ships **off**, REST-only, because
   the failure mode of a wrong envelope is a silently unplaced leg.

---

## 8. Known limitations

- **Cross-venue capture needs funded balances on both venues simultaneously.**
  `CrossVenueMonitor` checks real balances and reports what is executable
  *now*; a transfer takes longer than the gap lives. Everything else is intel.
- **The protobuf field map is discovered, not declared.** Validated on decode,
  but `protoc` stubs are the production answer.
- **Gate's `spot.order_place` envelope is not publicly specified** to the
  detail the subscribe/auth flow is. Verify before enabling.
- **Fee tiers are static per symbol** from `exchangeInfo`. VIP tiers and MX
  discounts are not modelled, so realized edges will differ from planned ones
  by a consistent, measurable amount — check the journal before assuming a bug.
- **No maker/rebate logic.** Every leg is a taker by construction; that is what
  IOC/FOK means, and it is why fees kill almost everything.
- **The engine assumes it is the only user of the balances.** Trading the same
  account by hand while it runs will produce leg failures that look like venue
  problems.
