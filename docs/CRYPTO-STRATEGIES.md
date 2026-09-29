# Crypto strategy tournament, version 7.0.0

Real-money preparation is authorized; no real-money account or order service is connected. This subsystem is deterministic paper research using public Coinbase Exchange market data and a conservative Coinbase Advanced U.S. fee model.

## Tournament structure

Eleven strategies run as separate $1,000 synthetic accounts: Relative-strength rotation, Range recovery, Trend pullback continuation, Volatility compression breakout, Liquidity-sweep rebound, Breadth-thrust rotation, Leader-laggard catch-up, and Capitulation recovery. The existing Relative-strength and Range-recovery ledgers migrate from `2026-09-16-multicoin-v1` without changing cash, positions, trades, P&L, fees, curves, or timestamps. Version 3 preserves all eight v2 accounts and adds three synthetic accounts: Defensive relative strength, Volume-weighted value recovery and Weekend participation breakout. Historical legacy breakout/reclaim evidence remains archived and exit-only.

No strategy is described as proven profitable. These are prospective hypotheses. Activity is measured by actual paper ledger entries, not by scans or signals.

## Dynamic market universe

Each cycle discovers currently online Coinbase USD spot products. Stablecoin bases and structurally unsuitable leveraged/inverse-style symbols are excluded. Public 24-hour stats pre-rank the universe by USD notional. The collector then reads completed hourly candles and public level-2 books for a bounded preliminary set. The final tournament contains up to 40 usable markets ranked by 24-hour USD notional, current spread, and visible depth.

`BTC-USD` and every product with an open tournament position are retained in the collection even when they would otherwise fall outside the top 40. A disappearing or failed required product becomes stale and blocks new entries rather than receiving a fabricated price.

## Costs

Fee profile: `coinbase-advanced-us-entry-2026-09-16`.

- U.S. Coinbase Advanced entry-level maker reference: 0.50%.
- U.S. Coinbase Advanced entry-level taker: 0.90%.
- All tournament entries and exits use the 0.90% taker rate. The tournament does not assume a passive order fills.
- The exact public order book is walked for the simulated quantity, so spread and depth are already reflected in principal.
- An additional 0.10% adverse slippage reserve is charged on each side.
- No funding rate, margin interest, or borrowing cost exists because the tournament is long-only spot.
- No network/withdrawal fee is charged because paper assets are never transferred on-chain.

The maker rate is published in the UI for reference only and never used to improve simulated performance. If Coinbase changes published pricing, the fee profile must be versioned rather than silently rewriting historical trades.

## Signal families

All strategy decisions use completed hourly candles only. A still-forming or future candle cannot alter an earlier decision.

**Relative-strength rotation** ranks positive 6-hour and 24-hour movement, volatility-normalized strength, and BTC-relative performance while limiting extension from the short trend.

**Range recovery** requires a meaningful recent drawdown, two rising completed closes, and room toward the prior range high.

**Trend pullback continuation** requires a rising 20-hour/50-hour trend, a controlled pullback near the short trend, and a completed-hour reclaim.

**Volatility compression breakout** requires short-horizon volatility compression followed by a completed break above the previous range with volume expansion.

**Liquidity-sweep rebound** requires the prior completed bar to sweep below the earlier range low, close back inside it, continue higher, and have supportive current top-book imbalance.

**Breadth-thrust rotation** runs only when a broad share of the selected universe has positive six-hour momentum and trades above its 20-hour trend, then selects stronger leaders.

**Leader-laggard catch-up** looks for a positive longer-trend coin that lagged the median six-hour move but has begun accelerating while broader breadth remains supportive.

**Capitulation recovery** requires a deep drawdown, elevated completed-hour volume, and a confirmed sequence of rising closes before entry.

## Entry, risk, and retirement

Candidates must clear current book freshness, spread, depth, product minimums, all modeled costs, and a minimum 1.1 after-cost reward/risk ratio. Entries require two qualifying scans 60 to 1,800 seconds apart. Each position uses at most 20% of account equity, total deployed cost is capped at 60%, planned stop risk is capped at 1%, and each strategy may have at most three simultaneous positions. A six-hour same-product cooldown follows closure.

New entries pause after a 3% daily equity loss or a 10% peak drawdown. Open positions still attempt safe exits. Strategies become `established` only after at least 30 closed trades spanning 14 days with positive net realized P&L and without meeting retirement rules. The UI calls this an extended paper sample, not a funded-readiness verdict.

Automatic permanent retirement requires the most recent 30 closed trades to span at least 14 days, have negative total P&L, profit factor below one, and negative net P&L in each consecutive block of ten. Retirement cannot reset or automatically restart an account. Original retirement evidence remains in Activity and Archive.

## Operation and verification

The five-minute opportunity workflow runs the tournament collector and writes `data/crypto-strategies/state.json` plus `dashboard/data/crypto-strategies.json`. State writes are atomic. Invalid existing state is refused rather than reset. Public collection uses GET only.

Before release, run `npm test`, both Python test suites, `python3 scripts/check_site.py`, and `npm run build`. The GitHub Actions collector must complete successfully on the default branch, then Pages must deploy the same verified source. Browser QA must inspect mobile and desktop tournament/activity views. A source commit is not proof of deployment.

## September 19 additions

See [FUNDING.md](FUNDING.md) for account-specific fee caveats, funding/withdrawal cost treatment, conservative prediction-fee rounding, Oklahoma eligibility and the separate real-money prerequisites. Fees above are paper assumptions until verified against the user account.

Defensive strength tests rising coins during declining BTC regimes. Volume-weighted recovery requires two rising completed closes below the preceding 72-hour volume-weighted price with at least 4% room. Weekend participation requires a UTC-weekend break of the prior range with volume and broad-market participation. Each retains the same depth, cost, risk and confirmation gates. A forward BTC/cash benchmark starts prospectively and does not alter any account cash. Evaluation time is captured after feed collection.

## 100-pair expansion and prospective rotation comparison

The September 19 expansion scans up to 100 eligible USD spot pairs from a 130-pair
shortlist. All product statistics still participate in discovery. Historical
candles are fetched before a separate fresh-book phase, and the whole shortlist
is cached. Partial-hour candles are excluded at request time and refetched after
the hour completes. Restricted taker markets (auction, post-only, cancel-only or
limit-only) are excluded. Missing required holdings stay explicitly stale.

Original accounts retain every balance and trade. Their promotion evidence
starts a new policy interval and BTC comparison; prior benchmarks are preserved
in benchmarkHistory. Historical fees are never silently rewritten.

The snapshot's rotationStudy starts only after at least 80 markets are ready.
Two fresh $1,000 paper accounts start together: a 40-pair control and a 100-pair
expanded arm. Both use the same rule, collection clock, cost model and feed;
selection ranks the observed markets independently while retaining each arm's
own holdings. Study state lives in the same authoritative atomic JSON as the
original ledgers. Comparison positions and trades appear in Activity/CSV.

Displayed higher-cost outcomes are same-fill sensitivity calculations, not a
second executed account: 1.20% taker fees plus 0.30% additional slippage each side.
Base fills retain 0.90% / 0.10% assumptions and walked spread/depth. Account fees,
individual Oklahoma asset eligibility, funding/withdrawal/hosting costs and taxes
are not verified or included. No real orders or funding are enabled.

Each account records gaps over 15 minutes and possible historical candle crossings
of stops/targets. Those crossings flag incomplete execution evidence; candle
extremes never fabricate fills. A five-minute cloud schedule does not guarantee
continuous exits. Below 80 usable markets the collector still reconciles existing
positions and preserves records, but fails its workflow to surface degraded
coverage. The dashboard reports actual selected/fresh counts and book age.

## Listing Watch: public observation of Coinbase listings and delistings

Listing Watch records what Coinbase does when it lists or delists assets, so
listing-based ideas can be tested honestly later, and it flags delisting risk.
It is observation only: no orders, no paper positions, no credentials, and no
tie to any ledger. It does not trade and does not claim an edge. Earlier
evidence (below) says buying at a Coinbase launch loses after fees on average.
Like every workflow here it runs on the best effort five-minute schedule; reads
are not continuous quotes, and a run can be delayed or skipped.

- **Modules:** pure accounting in `dashboard/listing-watch-core.mjs`; public GET-only
  collection in `scripts/collect-listing-watch.mjs` (injectable fetcher, clock and
  root); HTML in `dashboard/listing-watch-ui.mjs` and `dashboard/listing-watch.css`,
  mounted as a section of `crypto.html`; tests in `tests/listing-watch.test.mjs`.
- **State and snapshot:** `data/listing-watch/state.json` (authoritative, atomic
  writes, lock directory) and `dashboard/data/listing-watch.json` (public, compact).
  The first scheduled run creates both. An unreadable or invalid state, a changed
  policy id or a clock earlier than the saved state is refused, never reset.
  Both files are written every usable run, state first. A run in which all three
  sources fail writes nothing, so the last good files are retained unchanged.

**Sources, each read and failed independently** (an error keeps the earlier good
data with its original read time and is shown as an explicit error state):

1. Exchange `GET /products`: id, status, status_message and the trading_disabled,
   cancel_only, post_only, limit_only and auction_mode flags for every product.
2. Advanced Trade `GET /api/v3/brokerage/market/products?product_type=SPOT`:
   `new`, `new_at`, `is_disabled` and `view_only` for USD products. Coinbase's
   2023-01-01 `new_at` placeholder is ignored. A paginated answer is an error.
3. Exchange status `GET /api/v2/incidents.json`, classified as listing (auction,
   limit-only, full trading, markets open), trading suspension or delisting, or
   other. Events are deduplicated by incident id and update id, keep the source
   time and the time first seen, and record referenced product ids and asset
   symbols (best effort; unknown stays null). Bounded: 120 listing, 60 suspension
   and 20 other events.
4. Exchange `GET /products/{id}/candles?granularity=60`: see launches.

A feed with fewer than 50 usable products, one that shrank by half, or one that
adds or drops dozens of products at once is treated as a parse failure.

**Times.** `at` is when this collector read a source, never when Coinbase changed
it. Each transition also stores `since`, the previous successful read of that
source, so the change happened in (since, at]. Source times (status updates,
`new_at`) are kept as published.

**Registry and transitions.** The first read of each source is a baseline: those
products are marked `baseline` and are not launches, with one exception below.
Later reads log first-seen
ids, status changes, each flag on or off, status_message changes, and presence
(left or returned to the feed) with from/to values. Registry entries are compact
(non-default attributes only, 12 transitions per product with the first-seen
entry kept); the global log keeps the latest 250, and a counter keeps the total.

**Launches.** A product first seen after the baseline is a launch. Its
first-seen read, the read interval it appeared in, each Exchange phase (auction,
limit-only, post-only, full, and so on) with read interval, and Advanced Trade's
`new_at` are recorded. A launch whose `new_at` predates first sight by more than
15 minutes is marked detected late. A new pair of an asset that already trades
is logged as `new-pair`. A real launch is listed in the Exchange feed cancel-only
before its auction while Advanced Trade already flags it `new`. A baseline product
in a pre-trading state (cancel-only, auction, post-only or disabled) that Advanced
Trade flags `new` (with `new_at` under 30 days old) is therefore adopted as a launch
in progress and marked `startedInProgress`: its first appearance and earlier phases
were not observed and none are invented, but its later phases and candles are.
Products that flip state after the baseline are not adopted. For new-asset USD launches only, the collector records
public 1-minute candle closes and volumes from the last read that still saw the
auction until 24 hours after the first observed trading state (limit-only or full;
auction and post-only books do not match orders). It
reads at most four ranges of at most 300 minutes per run, only minutes that
ended at least two minutes earlier, and stores the exact covered ranges. A minute
with no trade has no candle but counts as covered. A window that closes with gaps
is marked `incomplete`. Nothing before collector start is backfilled. Rows live in
state for the newest 12 launches (older rows are trimmed from state and remain in
repository history); raw rows are never in the public snapshot. Up to seven
listings found in the status feed are shown as observed in status feed, times
only, without prices.

**Risk flags.** The watchlist holds assets with an upcoming suspension or
delisting notice (notice time, stated effective date and time when parseable,
source incident) and notices that became effective within 30 days. A notice that
names only non-USD pairs covers those pairs; a USD or asset-wide notice covers
the asset. `isAvoid(product, state, now)` in the core module is true for a product
with such a notice, one that is delisted, offline, trading-disabled or
cancel-only, or one first seen less than 90 days ago. The age rule uses
first-seen time for products seen after the baseline and dated Advanced Trade
`new_at` otherwise; a baseline product with no dated listing has an unknown age
and is not flagged.

**Historical study, not live results.** 216 Coinbase listings, June 2023 to
August 2026, public Coinbase daily candles, survivors only. After 1.8%
round-trip taker fees, buying at the first daily open and selling at the day 1
close returned +2.6% mean, -1.6% median and won 41% of the time; holding to day
8, -6.9% mean, -13.6% median, 27% win; to day 31, -14.4% mean, -26.1% median, 25%
win. Coins touched a median +15% above the open within three days, but that peak
is not tradable, and survivorship makes real results worse. From the day 1
close, median returns were -13% at day 8 and -40% at day 91, which is the basis of
the 90 day rule. Coinbase opens a listing in phases, hours apart: an auction of
at least 10 minutes with a single opening price, then limit-only, then full
trading. The crypto page shows this study labeled as historical.

**Operation.** `.github/workflows/opportunities.yml` runs the collector after the
arbitrage comparison with `continue-on-error`, so a Listing Watch failure cannot
block the tournament, and commits the two files if present. It is not in the
failure-surfacing condition. `npm test` uses synthetic fixtures only; a dry run
against the public APIs can be pointed at a scratch directory with
`node scripts/collect-listing-watch.mjs --root <dir>`.

## Live bot strategy: BTC/ETH daily trend paper mirror

The private Coinbase worker (see [COINBASE-WORKER.md](COINBASE-WORKER.md)) is
configured with the daily trend policy in `dashboard/trend-core.mjs`
(`2026-09-29-trend-v1`). Its real-money orders, balances and results are
private and never appear in public snapshots. The public site instead shows a
separate paper mirror of the same rules. It is not one of the eleven tournament
accounts, shares no ledger or state file with them, and never submits orders.

- **State:** `data/crypto-trend/state.json` (authoritative) and the browser
  snapshot `dashboard/data/crypto-trend.json`, written atomically by
  `scripts/collect-crypto-trend.mjs` in the five-minute opportunity workflow.
  Pure accounting lives in `dashboard/crypto-trend-core.mjs`; public GET-only
  collection lives in `scripts/crypto-trend-feed.mjs`.
- **Start:** $1,000 paper, started prospectively at its first cycle. Nothing is
  backfilled. Invalid state or a changed policy id is refused, not reset; a new
  policy version needs an explicit migration.
- **Signal:** completed UTC daily Coinbase candles (about 200 days). Enter when a
  close is above its 100-day simple average plus 2%; exit below the average
  less 2%. One entry per coin per completed bar, and never on a bar that closed
  before that coin's latest exit.
- **Fills and costs:** about 49% of paper equity per coin. Entry assumes the
  worker's resting limit at the observed best bid fills there as maker (0.50%).
  Unlike the tournament, the maker rate is credited here because it is the
  worker's entry method; a real resting order may fill later, elsewhere or not
  at all. Trend exits walk observed bids with the 0.90% taker fee plus the
  0.10% slippage reserve.
- **Native bracket:** the stop triggers at 80% of the entry signal close and is
  filled at no better than 95% of the trigger (worse if the observed book is
  lower). Stop evidence counts from observed books and daily lows from the UTC
  day of entry; take-profit (160%) counts only book prices and highs of bars
  that began after entry, is charged as taker, and loses to a stop when both
  appear.
- **Marks and benchmark:** equity is cash plus liquidation marks after taker
  exit costs. A BTC buy-and-hold benchmark starts on the first usable BTC book
  with the same maker entry and taker liquidation assumptions.
- **Source failures:** each product records candle and book fetch times. A
  failed read keeps the earlier good signal with its original times, marks it
  retained and never trades on it; stale marks block new entries. A cycle in
  which every read fails writes nothing, so a good snapshot is never replaced.
- **Records:** trades are never truncated. The equity curve keeps hourly points
  (90 days), daily points (about three years) and the last 288 cycle receipts.

The crypto page and overview show each coin's close against its 100-day
average and bands, the current action, paper equity against the BTC benchmark,
trades and source times. They also show the historical study that motivated
the rule, labeled "historical study, not live results": Coinbase daily bars from
2024-01 to 2026-09 with maker-entry/taker-exit costs returned +118% (maximum
drawdown -36%) versus +99% (-53%) for BTC buy-and-hold, and were positive in
each third of the sample; many short-horizon altcoin strategies lost 70-95%
without a market filter. The paper mirror never copies those returns. Cycles are
scheduled and best effort; they are not continuous quotes or continuous
protection.

## Strategy Lab: paper alternatives beside the live bot

The Strategy Lab lets the owner watch several alternative daily strategies run
prospectively next to the live bot. It is paper only, isolated like the trend
mirror, and never submits an order, reads credentials or touches any ledger
outside its own files. Its results are short-window observations, not evidence
of an edge, and nothing is backfilled.

- **State:** `data/crypto-lab/state.json` (authoritative) and the browser
  snapshot `dashboard/data/crypto-lab.json`, written atomically by
  `scripts/collect-crypto-lab.mjs` in the five-minute opportunity workflow
  (`continue-on-error`, then surfaced). Pure accounting and signals live in
  `dashboard/crypto-lab-core.mjs`; public GET-only collection in
  `scripts/crypto-lab-feed.mjs`; the page section in
  `dashboard/crypto-lab-ui.mjs` and `dashboard/crypto-lab.css`. The state files
  are absent until the first scheduled run, which starts every book. The
  collector takes an injectable root (`runLab({root})`, or `MM_LAB_ROOT` for a
  dry run) so tests and experiments never write into the repository.
- **Books:** five separate $1,000 paper accounts, each with its own cash,
  positions, trades, fees, drawdown and bounded equity curve, plus a same-start
  hold-3 benchmark.
  1. `sma200-5`: enter when the completed daily close is above the 200-day
     simple average x 1.05; exit when it is below the average x 0.95.
  2. `donchian-100-50`: enter when the close is above the highest high of the
     previous 100 daily bars (current bar excluded); exit when it is below the
     lowest low of the previous 50.
  3. `supertrend-10-3`: standard Supertrend on the high-low midpoint with the
     simple mean of 10 true ranges and multiplier 3, the usual final-band
     ratchet, initial trend down, computed from the full contiguous history
     (at least 250 completed bars are required so the latest state does not
     depend on where the fetch window begins). Long while the trend is up.
  4. `sma100-2`: the live bot's rule (100-day average, plus or minus 2%) on all
     three coins as a control, so SOL behavior is visible. It shares the live
     rule's arithmetic but reads and writes none of the mirror's or worker's
     files; a test compares its signals with `trendSignal`.
  5. `hold-3`: equal-weight buy-and-hold of BTC, ETH and SOL, entered once at
     the first usable book and never sold. It is the benchmark for the others.
- **Universe and sizing:** long-only spot in BTC-USD, ETH-USD and SOL-USD, one
  position per product, one third of book equity per product while long,
  sized from equity after that cycle's exits. There are no stops or take
  profits; the only exit is the rule's own completed-bar exit.
- **Signals:** completed UTC daily bars only, from `normalizeDaily` and
  `completedDaily` in `dashboard/trend-core.mjs` (imported, unchanged). About
  420 days are fetched in windows of at most 300 candles. A stale latest bar, a
  gap in the bars a rule needs or too little history makes that reading
  unavailable rather than guessed.
- **Entries:** one entry per product per completed daily bar (the signal id
  carries the bar time), never on a bar that closed before the product's latest
  exit, and never on a retained or failed reading. An entry signal that was
  already in force when the book started is taken once and labeled an initial
  entry; later entries are labeled bar-close entries. State alone never causes
  a repeat entry.
- **Fills and costs:** the trend mirror's model. Entries assume a resting buy
  at the observed best bid fills as maker (0.50%); exits walk the observed
  bids with the 0.90% taker fee plus the 0.10% slippage reserve. Equity and the
  benchmark are marked at liquidation value after exit costs.
- **Source failures:** each product records candle and book fetch times. A
  failed read keeps the earlier good signal with its original times, marks it
  retained and never trades on it; a stale or missing book leaves marks
  incomplete and blocks new entries. A cycle in which every read fails writes
  nothing, so a good snapshot is never replaced. hold-3 needs only a fresh
  book; a benchmark leg whose book was unavailable at the first run starts,
  with its own recorded start time, at the first usable book.
- **Records:** trades are never truncated. Each book keeps hourly equity points
  (30 days), daily points (about three years) and the lab keeps the last 288
  cycle receipts. Invalid state, changed parameters or a changed policy id are
  refused, not reset; new books or parameters need an explicit migration.
- **Page:** a Strategy Lab section on `crypto.html` labeled "Paper experiments.
  Not the live bot. Results so far are short-window and not evidence of an
  edge.", one card per book (equity, return, difference from hold-3 in
  percentage points, drawdown, trades, fees, per-coin signal state and source
  times), and a static table labeled as a historical backtest, not live results
  (February 2024 to September 2026, BTC/ETH/SOL, live-bot fee model): the
  live SMA100 +/-2% rule 0.51 mean Sharpe, 12.5% mean CAGR, -71.9% worst
  drawdown; Supertrend 10x3 0.48, 15.7%, -48.5%; SMA150 +/-2% 0.41, 8.4%,
  -61.3%; Donchian 100/50 0.38, 7.9%, -56.8%; SMA200 +/-5% 0.36, 6.5%, -59.3%;
  hold 0.45, 7.6%, -76.3%. Those results swing widely with small parameter
  changes, and SOL lost money under the live rule. The paper books never copy
  them.
- **Boundaries:** it does not change the live worker, `TREND_POLICY`, the trend
  mirror's saved state or the tournament. Selecting or changing the live
  strategy remains the owner's decision; a lab book that looks good over a short
  window is not a recommendation to change it. Scheduled cycles are best effort,
  not continuous quotes.
