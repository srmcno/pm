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
