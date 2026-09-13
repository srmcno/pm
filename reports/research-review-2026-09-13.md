# Research decisions — September 13, 2026

The primary product retains copy trading and crypto arbitrage alongside Kalshi/Polymarket predictions. Contract comparisons are prediction research; they do not replace crypto arbitrage. The algorithm work addresses accounting and selection errors before adding more strategy variants. Existing accounts and losing observations are retained.

## Evidence reviewed

| Experiment | Recorded result | What it supports |
|---|---|---|
| Cross-venue NFL/MLB price screen | 3,474 correlated observations, 58 gross sub-$1 packages, zero net positive packages | Costs eliminate these observed gaps; mismatched exceptional rules independently prevent an arbitrage claim |
| Current crypto scanner v3 | −10.3992% across the preserved 90 days, 28 trades / 6 winners, profit factor 0.4575, $79.58 fees | The revision remains held; each chronological block also loses money |
| Retired stock forward simulation | $948.6975 from $1,000, 265 settled trades, 67 wins / 196 losses / 2 flat | The forward loss outweighs small favorable short replays; it is not an active recommendation |
| Old international wallet simulation | $59.8235 equity from $50, 12 settled / 9 positive, two unresolved positions | Incomplete fees and a different venue make this unsuitable as evidence for Polymarket US |
| Old crypto arbitrage simulations | Repeated credited positive cycles under optimistic atomic fills | A positive-cycle filter is not a measured trading win rate; inventory and non-atomic execution must be modeled |
| Monthly ETF rule | Positive 2006–2026 replay, lower drawdown but lower return than hold benchmarks; $5/month case loses | Continue the already chosen $1,000 built-in forward experiment, with costs and uncertainty visible |

Sources are the committed [scanner results](../dashboard/data/scanner-backtest.json), [stock paper book](../data/stocks/paper.json), [retained wallet snapshot](../data/research/retired-public-snapshots/paper.json), [paired study](paired-market-history.md), and [ETF report](etf-research.md). These are dated findings; later forward results may change. Reused history is development evidence, not an untouched holdout.

## Changes made

- Compare full-game NFL/MLB moneylines only when named provider team IDs, the exact scheduled start and outcome orientation match. Evaluate both Kalshi team strikes; display the best funded package per game, retain all checked contract pairs in the data.
- Price whole equal-quantity packages by walking both ask books, applying effective venue fees and one cent slippage per leg. Cash cannot be netted across venues. Account allocation and exposure budgets remain separate.
- Preserve original book receipt/quote times. Recheck freshness after collection; the display labels dated quotes. Unknown, missing or changed settlement rules do not become certified equivalence. Exceptional package payouts retain a conservative 0–2 range and execution remains off.
- Mark prediction positions against the complete available bid depth, including modeled liquidation fees and slippage. Missing depth holds new entries instead of manufacturing a mark.
- Use Kalshi's matching sports milestone as the full-game entry cutoff, never estimated game-end time. Missing kickoff identity holds entries.
- Record at most one event observation per horizon. Earlier behavior kept only the first horizon forever, starving later cohorts. New rows explicitly carry `one-event-per-horizon-v1`; older rows remain unchanged. Training deduplicates events within each cohort, excludes future labels and validates against prior recorded forecasts. The overview deduplicates events across horizons and never calls outcome counts trade wins.
- Prioritize open positions and due contracts for official settlement checks. Retain newer data and expose source failures.
- Repair the old spread monitor so absent balances cannot qualify and sell inventory caps acquired token quantity rather than its higher sale value. Missing fee parameters also fail closed. Its retired collectors remain stopped.

The 100-outcome cohort, 50-outcome price bin, 30 prior-forecast, 3-cent conservative edge, two-scan confirmation, 2% per-event risk, 10% exposure and 10% drawdown rules were not relaxed. None of these checks establishes a future edge by itself.

## Product and repository cleanup

The new interface removes repeated navigation and account panels, token-radar clutter, manual prediction controls, and duplicated standalone shells. Contract details, costs, holds, actual trade exports, calibration, ETF holdings/transactions, and historical conclusions remain discoverable. Native dialogs, readable table/card layouts, keyboard controls and visible failure states support desktop and mobile use.

Unused frontend modules, styles, the old wallet HTML generator and eight obsolete retirement workflows were removed. Wallet and crypto-arbitrage page URLs now route directly to their restored core sections; ETF and stock links retain research access. Frozen baseline and retired published data moved under `data/research/`; authoritative ledgers are unchanged. Active background account managers were preserved. Sites and Pages publish the same fresh allowlisted build so removed assets cannot linger in a reused output directory.

## Copy and crypto restoration

The shared interface restores wallet ranking, saved wallets, detailed profiles, individual consensus backers, complete copy-paper history and historical variants. Public wallet activity can be inspected separately from the dated research. The displayed paper curve begins at the recorded $50 all-cash opening baseline, removing an inherited earlier funding discontinuity without deleting raw history.

Current Coinbase/Kraken crypto comparisons verify asset metadata and book keys, check receipt/provider freshness, walk the same quantity on both sides and include both taker fees and additional slippage. Three-leg Kraken cycles enforce depth and order minimums. The current Kraken base spot fee is 0.80%, superseding the old 0.40% fallback. These observations never create credited fills. Earlier atomic-fill simulations and the separate directional spot ledger remain available.

## Remaining evidence needed

The prediction accounts have no settled trades at the time of this review. The paired screen has no depth-backed historical fills, no proven all-scenarios settlement equivalence and no atomic cross-venue execution. The one-day sample cannot establish a general absence of future opportunities. More recorded outcomes, distinct chronological validation periods and actual forward results are needed before stronger performance claims. The selected ETF account remains a built-in simulation; no broker-paper or real fills are implied.
