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
