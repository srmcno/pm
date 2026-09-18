# Crypto Tournament v6 Design

## Goal
Expand Moffitt Money's crypto paper research from a fixed 10-coin, two-strategy experiment into a dynamic, cost-aware strategy tournament while preserving every existing ledger and keeping real trading disabled.

## Universe
Discover Coinbase USD spot products from the public product list every cycle. Exclude stablecoins, fiat proxies, leveraged/inverse tokens, offline/disabled markets, and products without usable increments/minimums. Rank candidates by recent public USD notional volume, then collect hourly history and depth for a preliminary pool. Publish the best 40 usable markets by notional volume, spread, and depth. Always retain BTC-USD and any product with an open paper position even if it drops from the top 40.

## Fees and execution
Use versioned fee profile `coinbase-advanced-us-entry-2026-09-16`: maker 0.50%, taker 0.90%. All active strategies simulate taker entry and exit for conservative executability. Charge actual walked asks/bids, 0.90% taker fee per side, and an additional 0.10% adverse slippage reserve per side. Do not charge withdrawal/network fees because the paper model never transfers assets on-chain. No leverage, borrowing, funding rate, or spot shorts.

## Strategies
Eight independent $1,000 paper ledgers: Relative-strength rotation, Range recovery, Trend pullback continuation, Volatility compression breakout, Liquidity-sweep rebound, Breadth-thrust rotation, Leader-laggard catch-up, and Capitulation recovery. Each uses only completed hourly data and fresh books. Two-scan confirmation, minimum reward/risk after all modeled costs, position/deployment limits, stale-data checks, and drawdown controls remain mandatory.

## Migration and retirement
Migrate the existing `2026-09-16-multicoin-v1` state without resetting rotation/recovery cash, positions, trades, P&L, fees, curve, or timestamps. Six new strategies start at $1,000 at migration time. Open v1 positions remain valid and exit under their stored stop/target plus current safety exits. New entries use v2 IDs. Automatic retirement remains evidence-based: latest 30 closed trades over at least 14 days, negative net P&L, profit factor below one, and all three consecutive 10-trade blocks negative. Retirement is permanent and exit-only.

## UI
Crypto page shows eight strategy cards, active/retired status, equity, realized P&L, fee drag, positions, current candidates, 40-market board, universe coverage, and explicit fee profile. Activity includes prediction and crypto ledgers with fee attribution. Archive retains retired strategies and older arbitrage/legacy research. Prediction home adds a compact crypto tournament summary only.

## Safety and verification
Real execution remains locked. Public collection uses GET only. Invalid or stale data fails closed. State writes remain atomic and validated. Verify targeted crypto tests, full npm test, both Python suites, site checker, build, collector cycle, mobile/desktop render, GitHub Pages deployment, and the published build/version before completion.
