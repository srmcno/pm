# Oklahoma funding and execution readiness

Reviewed September 19, 2026. [Open readiness](https://srmcno.github.io/pm/readiness.html).

The active strategies remain paper simulations. Existing records are preserved, including losses. No real capital was deposited or orders submitted. A simulated position is never a broker holding, and paper equity is never a funding source.

## What works now

- Eleven independent crypto experiments, two prediction paper accounts, executable-depth cost modeling, original quote times, forward BTC/cash comparison, and explicit stale-source/risk holds.
- A readiness page compares each strategy with predeclared forward, cost-stress and benchmark screens. No current account has demonstrated all the required evidence. Passing these screens would be a reason to investigate, not proof of a profitable edge.
- Downloadable Coinbase Advanced setup profiles use the same strategy IDs, explicit allocations and a fixed US/Oklahoma context. All exports are **preview**, with `liveEnabled:false`.
- `scripts/broker-preview.mjs` validates the profile. With private credentials it reads actual account fees and calls Coinbase's actual order-preview API. It cannot submit an order, transfer funds or cancel one.
- A separate private Coinbase rotation worker now has a durable execution journal, broker reconciliation, bounded order sizing and operator-controlled live activation. See [COINBASE-WORKER.md](COINBASE-WORKER.md). It starts disarmed; synthetic lifecycle tests and read-only connectivity checks do not verify actual live fills or protection. The public tournament remains paper.
- The older Alpaca broker-paper controller remains available with its own SQLite journal; it is separate from the crypto tournament. See [ETF-BROKER.md](ETF-BROKER.md). Its private execution has not been tested against your account.

## What you need to do

1. Use an approved Coinbase Advanced US account for the first crypto integration. Confirm the intended spot assets appear in your account. Kraken Pro is another spot candidate, but its authenticated execution adapter is not connected here. Do not use international Polymarket from Oklahoma.
2. Download a setup profile from the readiness page. A $100 allocation / $10 order cap is a conservative setup default, not a deposit recommendation. Keep it private outside the repository or in ignored `.execution/`.
3. Run the offline setup check from the repository:

   ```sh
   node scripts/broker-preview.mjs /absolute/path/moffitt-execution-preview.json
   ```

4. For an authenticated **preview only**, supply `COINBASE_KEY_NAME` and `COINBASE_PRIVATE_KEY` through a secure local environment. The key must be Coinbase App ECDSA P-256, scoped to your portfolio with the minimum required permissions, without transfers. Do not paste keys into chat, the site, source control or shell history. Then run:

   ```sh
   node scripts/broker-preview.mjs /absolute/path/moffitt-execution-preview.json --connect
   ```

   The tool checks the actual account fee tier and previews a bounded BTC/USD purchase. This tests API integration, not the strategy; no order is submitted. Its output is private account information: do not publish it.
5. The separate [Coinbase worker](COINBASE-WORKER.md) provides software for a private persistent execution service with order idempotency, partial-fill reconciliation, cash reservations, account identity binding and ongoing exits. It requires private cloud credentials, a funded allocation, verified outbound IP access and activation by the account owner. Actual exchange execution/recovery remains unverified until the owner performs a real test. A public website toggle does not activate it. GitHub Pages is a static dashboard and GitHub Actions is unsuitable for protecting continuous real positions.

The setup deliberately stops short of pretending that untested public-data simulations are ready for autonomous real money. Connecting your account and proving the execution lifecycle are remaining dependencies, not an invitation to disable checks. Existing legacy live scripts are not a supported shortcut.

## Eligibility and full costs

- [Coinbase Oklahoma license](https://www.coinbase.com/legal/licenses). [Advanced fee tiers](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees) are account dependent. The model uses 0.90% taker / 0.50% maker-reference assumptions, not a verified personal tier. It walks public Exchange books; Advanced execution must be separately checked. [Authenticated fee endpoint](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary), [preview endpoint](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/preview-orders), [key requirements](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication).
- [Kraken restrictions](https://support.kraken.com/articles/where-is-kraken-licensed-or-regulated) currently do not exclude Oklahoma. US asset restrictions apply; xStocks are excluded. [Ordinary Pro spot base tier](https://www.kraken.com/features/fee-schedule): 0.40% maker / 0.80% taker; stable pairs differ. Query account/pair fees before execution. [ACH/debit funding](https://support.kraken.com/articles/360000381846-cash-deposit-options-fees-minimums-and-processing-times-) and [withdrawal costs](https://support.kraken.com/articles/360000423043-cash-withdrawal-options-fees-minimums-and-processing-times-) depend on route and holds.
- [Alpaca September fee schedule](https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf): ordinary retail equity commission zero; SEC sells 0.00206% of proceeds, TAF sells $0.000195/share capped at $9.79, CAT $0.000003/share. Aggregate each fee type per day, then round up. No margin is assumed; borrowing and special routers have separate costs. Paper omits important real execution effects.
- [Kalshi schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf): apply current series/event multipliers to quadratic fees. Maker costs are not universally zero. [Direct/non-direct rounding differs](https://docs.kalshi.com/getting_started/fee_rounding). Current prediction paper uses conservative per-level cent rounding plus an execution buffer; it does not claim exact account rebates/rounding. Deposits/withdrawals depend on route.
- [Polymarket US fees](https://docs.polymarket.us/fees): September 17 taker coefficient 0.0695 and maker rebate coefficient −0.0125. Active normalized quotes already read the venue coefficient. No maker rebates are credited. US onboarding/API access and Oklahoma product eligibility remain unverified.
- [Oklahoma AG position on sports prediction contracts](https://oklahoma.gov/oag/news/newsroom/2026/may/drummond-urges-cftc-to-recognize-state-authority-over-sports-gambling-on-prediction-market-platforms.html): there is an active jurisdictional dispute. Sports can remain labeled paper research, but are excluded from the supported funding path. This is not a categorical legal-access assurance for any prediction product.

Trading costs, spread, depth and adverse slippage affect modeled fills. Funding, withdrawal/network, conversion, borrowing, subscription and rebalancing costs must be supplied if the actual route uses them. The readiness calculator includes fixed funding/withdrawal inputs; defaults of zero assume a verified free route and no on-chain transfer. Account-specific fees remain unverified until connected. Taxes are outside trading P&L and depend on the taxpayer.

## Predeclared promotion screens

50 closed trades and 30 days from a **prospectively recorded BTC benchmark**; positive net realized result, positive result with 50% higher fees plus another 0.10% slippage each side; positive lower mean screen; beating same-period fee-adjusted BTC and cash; current marks and drawdown below 10%; eligible strategy state. Related trades and multiple strategy selection violate simplistic independence assumptions, so these screens are not statistical proof. All accounts begin separately; winning accounts cannot subsidize losing books in the evidence.
