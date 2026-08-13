# Polymarket Wallet Intelligence

A study of every wallet that topped a Polymarket leaderboard, traced trade-by-trade
across the trailing 90 days — plus the tools the study feeds: an interactive
dashboard, a smart-money signal engine, and a paper-trading simulator with an
honest out-of-sample backtest.

Everything runs on Polymarket's public APIs. No keys, no accounts, no real money.

## What's here

| Piece | Path | What it does |
|---|---|---|
| Data pipeline | `scripts/fetch_data.py` | Pulls leaderboards (week/month/all-time × PnL/volume × 10 categories), then every candidate wallet's 90-day trades, open positions, portfolio value, and daily PnL series. Timestamp-cursor pagination gets past the API's 5,500-row offset cap. |
| Re-fetch helper | `scripts/refetch_capped.py` | Re-pulls any wallet whose history hit the pagination cap. |
| Analyzer | `scripts/analyze.py` | Per-wallet 90-day metrics (volume, sizing, timing, category mix, entry-price appetite, drawdown, win-day rate) and archetype classification. Writes `data/analyzed.json`. |
| Dashboard | `dashboard/index.html` (built by `scripts/build_dashboard.py`) | Self-contained explorer: ranked cohort table with expandable per-wallet profiles, plus aggregate views. No external dependencies. |
| Signal engine | `scripts/signals.py` | Finds outcomes that several historically profitable wallets are independently net-buying right now. Writes `data/signals/latest.json` + `reports/signals-latest.md`. |
| Paper trader | `scripts/papertrade.py` | Simulates the copy strategy with a virtual bankroll — live loop and out-of-sample backtest. Writes `reports/paper-latest.md` / `reports/backtest-latest.md`. |
| Live executor | `scripts/livetrade.py` | The only tool that can touch real money — ships disarmed. `plan` is a keyless dry run; `execute` needs your keys, two explicit flags, and enforces hard caps + a STOP file. See the arming checklist in its docstring. |
| Consensus engine | `scripts/pmx/` | A second-generation pipeline that runs alongside the above and publishes to the same site: specialty-weighted voting instead of a flat backer count, fractional-Kelly sizing instead of fixed stakes, sub-second on-chain detection instead of polling, and active exits instead of holding to resolution. Its own shift (`engine-shift.yml`) feeds the dashboard's **Consensus engine** panel. Architecture and the measurements behind it: **[`docs/ENGINE.md`](docs/ENGINE.md)**. |

## Quick start

```bash
pip install requests

# 1. Fetch the cohort (≈300 MB into data/raw/, ~30–90 min)
python3 scripts/fetch_data.py
python3 scripts/refetch_capped.py     # deep-fetch high-frequency wallets

# 2. Analyze and build the dashboard
python3 scripts/analyze.py
python3 scripts/build_dashboard.py    # -> dashboard/index.html, open in a browser

# 3. Smart-money signals (live)
python3 scripts/signals.py --live --hours 48

# 4. Paper-trade the signals with a virtual $20
python3 scripts/papertrade.py init --bankroll 20
python3 scripts/papertrade.py trade   # act on the latest signals
python3 scripts/papertrade.py mark    # mark to market / settle / report

# 5. The honest test: out-of-sample backtest of the copy strategy
python3 scripts/papertrade.py backtest --bankroll 20
```

## How the signal engine thinks

1. **Watchlist** — wallets qualify on realized 90-day PnL and win-day rate.
   Market-maker/HFT and crypto-scalper archetypes are excluded: their order
   flow is inventory management, not opinion.
2. **Stance, not trades** — a wallet's stance in a market is its best-net
   outcome minus whatever it spent on the other side. A trader who bought both
   sides has hedged, not spoken.
3. **Consensus with dominance** — a signal needs ≥2 independent qualified
   backers, and if the other side of the market also has real backing, the
   winning side must beat it by 1.5×; otherwise the market is contested and
   emits nothing.
4. **No chasing** — signals whose price has already moved >15¢ past the
   backers' average entry are dropped; the move already happened.
5. **Short horizon only** — with a max-days rail set (the watcher uses 3),
   markets resolving further out are skipped, and a market with *no*
   parseable end date counts as too far out: an unknown horizon can lock
   capital for weeks.

Scoring per backer: `wallet quality × √conviction × recency decay`, where
conviction is the net stake relative to that wallet's own median trade.

## How the backtest stays honest

- **Out-of-sample split**: the watchlist qualifies on the *first half* of the
  90-day window only; the strategy then trades the *second half*. (Residual
  look-ahead: archetype labels come from the full window.)
- **Real fills**: entries are taken from actual CLOB price history at signal
  time *plus a copy delay* (default 1 h), +1¢ slippage. If nothing traded within
  2 h of the intended fill, the trade is skipped — resolved markets can't be
  entered, exactly like real life.
- **The latency cost is measured** — the report shows the average difference
  between the fill and the price when the signal fired.

Run it before believing anything about copy-trading. The verdict line in
`reports/backtest-latest.md` is generated from the numbers, not from hope.

### Results on the full dataset (Jun 28 – Aug 12 window)

| config | result | note |
|---|---|---|
| ≥2 backers, 1 h delay | −1.9% | coin flip (49% win rate) |
| ≥2 backers, 3 h delay | −26.2% | latency is fatal |
| ≥3 backers, 1 h delay | +42.3% | promising but concentrated — one window, not proof |

Full breakdown: `reports/backtest-summary.md`. The live paper account runs the
strict config to accumulate a real out-of-sample record before any conclusion.

## The live site

The dashboard deploys to **https://srmcno.github.io/pm/** (GitHub Pages).
Human pushes touching `dashboard/` deploy on push; the watcher's own data
pushes use the workflow token, which GitHub never lets trigger on-push
workflows, so the watcher explicitly dispatches the deploy after each
publish. It stays live end to end:

- The v2 consensus engine (`engine-shift.yml`) runs its own back-to-back
  ~2-hour shifts on a separate concurrency group, detecting fills from
  Polygon logs and republishing `dashboard/data/engine.json` on every signal
  and every 10-minute heartbeat. Both engines are live on the page at once,
  free to disagree.
- A cloud watcher (`watch-shift.yml`) runs back-to-back ~2-hour shifts,
  polling the global trade feed every 45 s, and every ~15 minutes it
  re-prices standing signals, re-marks the paper account, and pushes the data
  — each push redeploys the site. Note the feed it polls is itself the
  bottleneck: `data-api /trades` was measured serving data **~260 s behind
  block time** and not advancing between rapid polls, so this watcher's real
  reaction time is minutes, not the sub-minute its poll interval suggests.
  That measurement is what the v2 engine's on-chain feed exists to fix; see
  [`docs/ENGINE.md`](docs/ENGINE.md) §3.1.
- A watchdog (`watch-watchdog.yml`) checks twice an hour that a shift is
  actually running and dispatches one if GitHub dropped the scheduled start.
- The page itself re-fetches `data/signals.json`, `data/paper.json` and
  `data/engine.json` every 60 s and shows a **bot live / bot stale** pill per
  engine, so one dead pipeline is visible instead of being masked by the
  other still publishing.

## The arb desk

A second page of the app — **https://srmcno.github.io/pm/arb.html** — runs a
micro-cap arbitrage scanner on MEXC spot (chosen over Pionex for its full
public market-data API and ~2,100 listed pairs). The full universe is
re-screened every **2 seconds** (one bulk book-ticker call plus pure CPU
over ~740 cycles); candidate legs get their depth fetched in parallel, so
a screen hit is depth-verified within a second or two. Heavy extras (Gate
comparison, volumes, the tape) refresh on a slower timer so they never sit
between an edge and its execution:

- **Triangular cycles** (USDT → coin → USDC/USD1/BTC/ETH → USDT) priced by
  crossing real bids and asks net of each pair's actual taker fee, then
  re-verified by walking live order-book depth at size. Fees kill almost
  everything — what survives is small and dies in seconds, so the page also
  measures edge survival scan-to-scan.
- **Microstructure board** — spread, depth within 1%, book imbalance, taker
  aggression, print sizes: the flow behind the candles.
- **Cross-venue gaps vs Gate.io**, guarded against the same-ticker-
  different-token trap (price-ratio and volume filters), published as intel
  only — capturing one needs funded accounts on both venues.
- A **$20 paper account** (same stake as the Polymarket bot) executes
  verified cycles at the largest depth-verified size that fits, re-striking
  a persisting edge every 30 s against freshly walked depth — atomic fills
  assumed, an upper bound, clearly labeled.
- **Real money (ships disarmed)**: `scripts/arblive.py` can fire verified
  triangles as real IOC orders with automatic unwind if a leg fails, under
  hard rails (`data/arb/live-config.json`: $20 bankroll, $10/cycle,
  $40/day, 10 bps minimum edge, `data/arb/STOP` kill file). Arming needs
  MEXC repo secrets (spot-trade-only API key, never withdrawal) — see the
  checklist in the file's docstring, and read the latency-capture ratio
  first: if a one-scan delay already kills the edges, real money is a
  donation to faster bots.
- **Historical testing, the honest way**: books aren't archived anywhere
  public and candles can't see spreads, so the desk records its own tick
  history every scan (`data/arb/history/`) and continuously replays it with
  one scan of latency (`arb.py backtest`) — the capture ratio between
  atomic and delayed PnL is the measured cost of being ~25 s slow.
  `arb-watch.yml` runs everything in self-chaining ~2-hour shifts like the
  Polymarket watcher.

### The event-driven engine (`engine/`)

The scanner above is a REST polling loop: by the time it sees an edge, the edge
is a historical artifact — its own latency replay measures how much survives one
scan of delay. `engine/` is the rewrite that removes the polling: WebSocket L2
deltas into an in-memory book, cycle re-evaluation triggered only by the books
that actually mutated, and IOC leg chaining driven off private fill pushes
instead of `sleep`-and-poll.

```bash
python3 -m unittest discover -s tests    # 62 tests, stdlib only
python3 -m engine selftest               # full pipeline vs a simulated venue
python3 -m engine plan                   # universe + connection-pool arithmetic

pip install -r requirements-engine.txt
python3 -m engine run                    # paper: real feeds, no orders
```

| Piece | Path | What it does |
|---|---|---|
| L2 book | `engine/book.py` | delta apply in ~1.7 µs, sequence-gap detection, non-blocking resync state machine |
| Shared memory | `engine/shm.py` | seqlock slab; ingestion processes publish, compute reads without locks |
| Connection pool | `engine/feed.py` | MEXC allows 30 subs/socket, so 2,100 pairs is 70 sockets — sharded, self-recycling |
| Graph engine | `engine/graph.py` | −ln(rate) edges net of taker fees; symbol→cycles inverted index (1.3 µs/frame) plus a background Bellman-Ford sweep for longer routes |
| Sizer | `engine/sizing.py` | depth walking with lot/notional quantization, bisection for the largest size that holds the edge |
| Execution | `engine/execution.py` | FOK leg 1, IOC legs 2-3 sized from actual fills, continue-vs-exit decision on the live book, two-hop unwind |
| Risk | `engine/risk.py` | rails re-checked per leg, inventory ledger, kill switch |
| Telemetry | `engine/telemetry.py` | T+25/100/500 ms edge decay, edge survival distribution, tick-to-trade breakdown |

Three things worth knowing before believing any of it — all detailed in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

1. **MEXC has no order-entry WebSocket.** Orders are REST-only; the private WS
   carries fills. The recoverable latency is the pre-warmed keep-alive pool plus
   taking fills from the push instead of polling — which is worth ~1 s per
   triangle against the current `arblive.py`.
2. **Where the process runs dominates everything the code does.** Compute is
   tens of microseconds; RTT from a GitHub Actions runner to MEXC is 150-250 ms.
   Sub-100 ms tick-to-trade needs a VPS in the venue's metro, in any language.
3. **The decay telemetry is the stop condition.** If capture at T+100 ms is
   already near zero, the edge dies before any router could reach it and the
   correct action is to stop — not to optimize further.

It ships disarmed, under the same rails as the rest of the desk.

## Data sources

- `https://data-api.polymarket.com/v1/leaderboard` — trader rankings
- `https://data-api.polymarket.com/activity` — per-wallet trade history
- `https://data-api.polymarket.com/positions`, `/value` — holdings
- `https://user-pnl-api.polymarket.com/user-pnl` — daily PnL series
- `https://gamma-api.polymarket.com/markets` — market metadata & resolution
- `https://clob.polymarket.com/prices-history`, `/midpoint` — prices

## Honest limitations

- The cohort is leaderboard-seeded: a strong wallet that never surfaced on any
  leaderboard window doesn't appear.
- Category classification is keyword-based on event slugs; a small share of
  volume lands in "Other".
- 90-day PnL comes from Polymarket's own per-user PnL series (realized +
  mark-to-market).
- Signals are information, not advice. Past profitability of a wallet is a weak
  predictor of its future trades' value — that is precisely what the backtest
  is for. Nothing here places real orders, and nothing here should be read as a
  promise that $20 becomes more than $20.
