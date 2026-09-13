# Monthly U.S. ETF research and forward simulation

This is the active monthly ETF experiment, separate from the older `desk` simulations and the prediction/crypto accounts. It starts with $1,000 of **simulated money**, as requested. Existing accounts were not reset. No broker account was funded and no real order was submitted.

## Strategy and evidence

Read [the declaration](ETF-RESEARCH-PLAN.md) and [the generated results](../reports/etf-research.md). The fixed ten-month rule is retained even when an eight- or twelve-month sensitivity looks better. Positive backtested returns coexist with lower returns than buy-and-hold and uncertainty about any advantage. The forward record, begun September 13, 2026, has no imported historical profit. Its first decision uses August 31 completed monthly information; its earliest fill is September 14's open, observed after that session finishes.

The base model assumes no operating charge. The $5/month sensitivity loses money on the $1,000 starting account over the tested history. Do not buy a subscription or hosting service and assume the zero-overhead result still applies.

## Commands (Python 3.12+, standard library)

```sh
python3 scripts/etf_lab.py research   # reproduce fixed frozen inputs, never download silently
python3 -m unittest discover -s tests -p test_etf_lab.py
python3 scripts/etf_lab.py paper      # refresh inputs, then advance the separate forward account
npm test
python3 scripts/check_site.py
npm run build
```

`data/etf/raw/` holds the original compressed Yahoo responses and SHA-256 manifest. It is never overwritten by paper collection. `data/etf/research.json` contains full daily equity, every trade, every monthly decision and distribution. `dashboard/data/etf-research.json` has compact monthly curves; `dashboard/etf-transactions.csv` exposes the base historical transactions. Reported daily drawdown is computed from the full daily series, not the compact chart.

The pinned XNYS calendar in `data/etf/calendar.json` was generated with `exchange-calendars==4.11.2`, contains known exceptional closures, and extends through 2030. Daily operation is standard-library only. Reconcile new exchange holidays/closures against a newer calendar before changing it; unexpected missing sessions halt updates. The calendar is a scheduling assumption, not a guarantee no future emergency closure will happen.

## Forward state and scheduled operation

`Monthly ETF paper cycle` runs on weekdays at 22:15 UTC, best effort, and can be dispatched manually. `data/etf/paper.json` is the authoritative persisted account. It includes the original decision timestamp, pending eligible session, cost ledger, shares, cash, receivables, source fingerprints and integrity digest. `dashboard/data/etf-paper.json` is the published read-only view, checked by the page every minute. Closing the page does not stop the workflow.

Five independent ETF histories must match the expected exchange sessions. A session is considered complete 45 minutes after its calendar close. The actual decision clock is taken after the network refresh; a slow request cannot backdate a decision before an opening print. Each fill must occur after a persisted decision. A missed job may later observe the fill of an already recorded order, but the system does not create historical decisions it never recorded. This is an EOD observation model of standing simulated orders, not an intraday broker fill service.

Monthly targets use completed month-end observations. Between rebalances the account holds actual share quantities. Dividends belong to the previous session's holder and are receivables on the ex-date. They are not buying power until the assumed payment day. Thirty days is only an assumption, with a sixty-day research sensitivity. The fund's actual dividend payment may differ. Fractional opening-price fills are a proxy; the backtest and forward simulation include adverse friction but cannot establish actual broker fills.

Account reads validate the digest, cash/holdings reconciliation, fee totals, distribution records and execution chronology. Source changes to any accounted session fail for review. A malformed account is never reset to $1,000. A source failure preserves its book and publishes an error receipt with the original last successful mark; a publication failure after account commit uses that committed account in the receipt. Missing/error receipts never assert that current quotes or broker readiness passed.

## Stop and recovery

Disable `Monthly ETF paper cycle` in GitHub Actions to stop the simulation. A stopped simulation is not an instruction to liquidate a broker account; no broker account is connected. The local `.cycle.lock` prevents overlapping processes; a killed local process can leave its directory. Confirm the old process has ended before removing only that empty lock directory. CI jobs use separate checkouts and a non-canceling concurrency group.

For corruption or a vendor revision, preserve both versions. Review the account's Git history, affected corporate actions and decisions. Restore a verified prior account revision only after reconciliation. Do not manually recompute an integrity digest to hide an unexplained balance difference. The workflow refuses conflicting account writes instead of silently winning a merge.

## Broker transition: not yet completed

The user chose the built-in simulation for now. There are no Alpaca Actions secrets configured. `scripts/etf_broker.py` now implements a **dormant, paper-only controller** for this experiment, using its shared monthly signal function. It has passed offline failure and accounting scenarios, but has not connected to a broker or submitted an actual paper order. The older desk adapter is separate; its caller enforces its arming checks, and its evidence does not authorize this strategy.

The new controller binds a dedicated paper account to a private SQLite journal, records each intent durably before submission, and reconciles incremental fill activities, holdings and cash before another order. Lost responses recover by the original client order ID; missing orders never trigger an automatic second submission. Partial orders wait, failed or canceled orders require review, and late cash activities are fetched from the original baseline rather than just the current trading day. Unexplained transfers, corporate actions, revised source history, account changes and stale quotes hold execution.

It caps the strategy's allocation at $1,000 even when the broker's paper account contains more cash. Remaining allocated cash, a $1 reserve and the full limit price constrain buys. Sells precede buys. Broker cash and a separate modeled regulatory-fee overlay are distinct records; the overlay is never described as an actual broker debit. The controller does not synthesize broker dividends or produce a validated net performance report. Keep the cost-inclusive built-in simulation alongside any future broker experiment.

Read [ETF-BROKER.md](ETF-BROKER.md) for the dormant controller's operation and recovery boundaries. The existing automated simulation does not import or invoke it.

Remaining transition work:

1. When broker-paper testing is requested, configure a dedicated paper account and exercise the new controller against the actual service. Verify its accepted fractional limits, account eligibility, cash reservation, restart behavior and broker calendar responses. Never copy simulated holdings into a broker account.
2. Observe actual broker-paper orders and reconcile broker fills, cash, fees, distributions and restart behavior. Broker paper omits some real effects, including regulatory fees and dividends; keep the independent cost ledger. Public Yahoo prices do not establish an executable broker quote.
3. Review forward outcomes across multiple monthly decisions, cost/slippage observations and account eligibility. Passing the historical gate alone is insufficient for real funding.
4. Only with separate explicit authorization, select a live account and small capital cap, using distinct credentials and a kill switch. Keep simulation and broker books separate; no browser switch may bypass account/evidence checks.

Until those steps are demonstrated, the correct readiness status is **simulation running, broker connection incomplete, real execution off**. An endpoint change alone is not a verified transition.

## Research task status

- [x] Locate canonical app and preserve existing accounts.
- [x] Declare fixed strategy, freeze and validate sources.
- [x] Implement cost-inclusive distribution/split-aware replay and matched benchmarks.
- [x] Run regime, cost, capital, delay and operating-overhead sensitivities; retain failures.
- [x] Start isolated $1,000 simulated account and persist its first real-time decision.
- [ ] Observe first forward fill and later monthly outcomes (future sessions required).
- [ ] Demonstrate broker paper integration and real-money transition before activation.
- [ ] Establish a repeatable net edge; current evidence does not prove future profitability.

Deployment evidence is recorded with each release in docs/ETF-RELEASE.md.
