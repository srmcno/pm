# Coinbase rotation worker

This private worker is separate from the public paper dashboard. Its goal is an operator-activated, automated Coinbase Advanced USD spot test with an allocation ceiling of $20. Deploying the repository or editing a website does not activate trading. No real orders were used to validate this implementation.

## Hosting

`render.yaml` configures one Node 24 background worker and a 1 GB persistent disk at `/var/data`. The displayed Render price at setup was $7/month for 0.5 CPU / 512 MB plus $0.25/month storage, before taxes or other usage charges. This cost is separate from trading fees and the trading loss trigger. Billing starts when the paid service is provisioned, even while disarmed.

The worker runs independently of the owner's computer. Public universe collection runs about every five minutes; the broker loop runs about every 15 seconds plus request latency. Collection runs independently so scanning 100 pairs does not suspend reconciliation. This is polling software, not an exchange-level latency guarantee. Broker-native attached brackets remain at Coinbase while the worker is unavailable; a stop-limit can remain unfilled during a gap.

Auto-deployment is off to avoid restarting the trading process on the repository's frequent paper-data commits. Deploy reviewed code changes manually. A disk-backed deployment stops the previous process before its replacement; the SQLite lock also prevents two processes from using one ledger. Never run independent workers with separate disks against the same allocation.

## Commissioning and operator activation

1. Create the worker from this repository and its default branch using the blueprint or the matching values above. Keep `MM_MODE=preview` while checking configuration. The start command is `node scripts/live/runner.mjs`; the build command is `node --test tests/live-*.test.mjs`.
2. In Render's private Environment settings, supply `COINBASE_KEY_NAME`, `COINBASE_PRIVATE_KEY`, and `COINBASE_PORTFOLIO_ID` from the intended Coinbase App ECDSA key/portfolio. Keep View and Trade permissions, with transfers disabled. Do not put the key in GitHub, public site configuration, chat, a build command, or a repository file. An initial service without credentials only verifies public feed collection; that is not completion of brokerage setup.
3. Read the service's current outbound IP ranges under Render's Connect/Outbound information. The account owner adds those exact ranges to the Coinbase key allowlist; a key restricted to a home computer cannot authenticate from Render. Do not remove the allowlist or guess IPs. Confirm the deployed process can verify portfolio binding, actual fees and current product availability in preview mode.
4. Provide an available USD balance for the authorized allocation. The supplied deployment caps this test at **$18.85**, with an absolute software ceiling of $20. Funding freezes once at the lesser of the cap and available USD, with a $5 minimum; deposits later do not top up the allocation. BTC and other existing assets are not USD cash and are never automatically converted or adopted as bot inventory. The account owner handles any funding or conversion in Coinbase. Funding/conversion costs incurred outside this ledger are not retroactively fabricated as execution fees.
5. The account owner performs live activation by setting `MM_MODE=live` and `MM_LIVE_ACK=I_ACCEPT_REAL_MONEY_TRADING`, then saving/redeploying. These are separate from paid hosting approval. The software can submit orders after this activation if every runtime gate passes. An assistant should not make that activation change or submit a test trade.

## Limits, evidence and recovery

The runtime bounds new risk to the configured $20 allocation ceiling, $5 absolute order ceiling, 20% maximum position weight, 60% exposure and 1% modeled loss per entry. Venue minimums can make a small test unable to trade. The software must skip such a setup rather than increase the allocation or weaken the risk checks. Profits do not authorize a larger allocation. The $2 trading loss trigger is a control signal, not a guaranteed maximum loss; slippage, gaps, fees and unavailable markets can exceed it. Hosting is outside that trading trigger.

New orders require fresh authenticated books, account fees, tradable USD spot products, sufficient real USD, a current rotation signal and successful Coinbase cost preview. The public paper minimum of $10 does not define the broker minimum; authenticated product increments/minimums do. Protective orders use Coinbase's attached bracket. Stop execution and partial fills must be reconciled rather than inferred from a successful HTTP response.

The execution journal records immutable client IDs before submission. Unknown outcomes are held for reconciliation; they are never retried with a fresh ID. Accounting uses cumulative broker fill quantities, values and actual fees, including partial fills on cancelled orders. Only inventory acquired by recorded bot orders belongs to the bot. Unrelated account holdings and paper balances are not available to sell.

State persists under `/var/data/rotation/execution`; market/preflight evidence lives under `/var/data/rotation/monitor`. Deleting or restoring an old execution journal can lose ownership history while Coinbase orders remain. Do not reset a journal or clear a recovery latch without matching the account's open orders/fills and preserved intent history. When reconciliation cannot establish identity, amounts or protection, new activity stops and the status identifies recovery as required.

Private worker logs and `status.json` expose operating status and aggregate marked trading P&L without credentials, account identifiers or order responses. Marked P&L is available only with complete liquidation marks less than 60 seconds old, and is explicitly distinct from realized profit. Quantities, fills and account identity remain in the private journal. The public Pages/Sites figures continue to be paper results; they do not become this worker's realized profit. Hosting accrual is an estimate, not a Render invoice. Funding, conversion, withdrawal, taxes and any other external costs must be included separately when judging overall profitability.

Turning the worker off stops software reconciliation. Changing it to preview preserves read-only reconciliation when the credentials remain configured; it does not sell positions or cancel broker-native orders. Check and manage those positions in Coinbase when pausing live execution. A persistent loss or recovery latch does not automatically reset after redeployment.

## Verification scope

Tests use synthetic broker responses to exercise order lifecycle failures without moving real money. Public data and authenticated read-only checks can verify feed connectivity, key permissions and current fee contracts, but cannot prove fill quality, returns, cloud IP access, or successful live protection. The setup is an experimental small-allocation test, not evidence of a profitable strategy.

Primary references: [Render background workers](https://render.com/docs/background-workers), [persistent disks](https://render.com/docs/disks), [outbound IPs](https://render.com/docs/outbound-ip-addresses), [Coinbase order management](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders), [order types](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/order-types).
