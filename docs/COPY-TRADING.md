# Forward copy study

The built-in simulation now has an isolated $100 international Polymarket copy account. `scripts/collect-copy-study.mjs` reads public activity, metadata, books and final resolutions. It has no order connection or credential input. The retired collectors and earlier $50 account remain paused.

The existing opportunity workflow runs the study on its five-minute schedule, best effort. `data/copy-forward/state.json` is the canonical ledger; `dashboard/data/copy-study.json` is its compact publication. The browser does not advance either account. Decision receipts are retained in daily files under `data/copy-forward/decisions/`; the interface exports the most recent 500. Open/closed trades retain entry books, fee metadata and settlement evidence in the canonical state.

## Frozen selection and rules

Research inputs are dated September 7, with their SHA-256 recorded before the first scan. Of 254 wallets, 52 meet continuous history, material-day, diversification, execution-style and positive-time-block requirements. The top 20 by research score form the fixed cohort. Absolute dollar P&L does not improve the score when a wallet's trading size is scaled uniformly. The four equally weighted components measure path efficiency, gains versus drawdown, persistence across three chronological blocks and event diversification. These are research priorities, not probabilities or proven optimal thresholds.

Activity uses a fixed six-hour window with opaque v2 cursors, a fixed end time and at most 4,000 rows per wallet. Any missing page or malformed record holds entries. Overlap reads retain first-observed timestamps. Principal is `shares × price`; v2 reported cash can include fees. Identical fills without a distinct log identifier can be deduplicated. Trade flow does not include transfers, merges, splits or redemptions and is not a reconstructed wallet inventory.

A candidate needs three backers, at least 2.5 effective backers and 80% of the condition's weighted flow. Dollar conviction is capped, old buys decay over a three-hour half-life, and sales reduce flow without refreshing buy age. The entry reference weights remaining net shares. Confirmation needs a later complete scan at least 60 seconds after first qualification, with no gap over 15 minutes.

Entries cost at most $5, with $30 total exposure and $10 per event. Checks include current token identity, open-market status, 5¢ spread, 3¢ entry drift, a 5–95¢ price range, minimum size and 10% maximum participation in each ask level. Sizing includes the observed fee curve and a ½¢ per-share execution buffer. Fees are collateral-denominated: BUY receives full shares and pays principal plus fees. The curve is `shares × r × (p × (1-p))^e`, rounded to five collateral decimals per modeled level. Fill aggregation and actual order execution can differ from this simulation.

Positions are marked by walking bid depth and deducting modeled exit fees and buffer. Unavailable marks retain their source time and block entries. A 20% equity drawdown pauses entries; monitoring and settlement continue. A condition is copied at most once. Cash and equity reconcile against all entries and final proceeds before any progression.

Settlement requires an exact condition, official resolved status, a valid final timestamp and a two-outcome micro-USDC payout vector summing to 1,000,000. Gamma token/outcome arrays establish payout indices and are corroborated by exact CLOB token/outcome identities; CLOB response order alone is never used. Fractional payouts are supported. Prices near $1 never settle this account. A resolution predating a simulated entry is quarantined as a provenance conflict.

## Verification and operation

- `node --test tests/copy-study.test.mjs`
- `node scripts/collect-copy-study.mjs --state /tmp/copy-study/state.json --output /tmp/copy-study/snapshot.json` runs an isolated study against real public data.
- `node scripts/collect-copy-study.mjs` advances the canonical study. Do not replace its state with a test file.

Changes to frozen rules require an explicit versioned study migration; do not silently rewrite results. The Python standard-library wrapper holds an OS advisory lock for the Node writer. Process exit releases it automatically. A killed parent does not release it while its child still writes. On restart, daily journals reconcile idempotently from committed decisions before another cycle. No account reset is needed for source outages.

## Primary contracts

[Activity and cursor pagination](https://docs.polymarket.com/api-reference/feeds/list-account-activity), [CLOB metadata](https://docs.polymarket.com/api-reference/markets/get-clob-market-info), [fee curve](https://docs.polymarket.com/trading/fees), [V2 collateral fee implementation](https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Trading.sol), [final payout units](https://docs.polymarket.com/api-reference/markets/get-resolution-state).
