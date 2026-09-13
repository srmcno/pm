# ETF research declaration — September 13, 2026

Declared before downloading or scoring this new sample. No parameter search or replacing the rule with the best retrospective variant.

## Fixed candidate

Monthly ten-month trend, inspired by published time-series trend and tactical allocation research. Five long-only, unleveraged U.S.-listed ETFs: SPY, EFA, IEF, GLD, VNQ. These represent U.S. stocks, developed international stocks, intermediate Treasuries, gold, and U.S. real estate. Today's selection has survivorship and researcher-selection bias; it is not a point-in-time fund selection study. Each sleeve is 20% when its total-return index is above its last ten completed month-end values' arithmetic mean, otherwise zero. Uninvested cash earns 0%. No ranking, shorts, leverage or fitted return forecasts.

Signal at completed month end; execute the following session's open with adverse cost assumptions. Fractional market execution at an opening-price proxy is not a promise of an auction fill. First allocate after ten full calendar month observations. Never inspect a future bar for a decision. Rebalance only monthly, holding actual share quantities between rebalances.

## Data and accounting

Freeze original Yahoo daily OHLC, adjustments and corporate-action responses from 2005 onward, retaining request URLs, retrieval timestamps and SHA-256. Validate dates, prices and common sessions; do not forward-fill missing bars. Use a causal total-return signal reconstructed from price returns and ex-dividends. Record dividends for pre-ex-date holdings as receivables; reinvest only after an assumed 30-calendar-day delay (payment dates absent in source). Fund expenses are already reflected in traded prices, so do not deduct them twice. Convert split-adjusted vendor prices and dividends to then-current share units, process splits explicitly.

Base: $1,000, 2 bps half-spread + 5 bps slippage each side, zero direct-retail commission, September 2026 Alpaca regulatory schedule as a constant current-cost counterfactual across history. SEC 0.0000206 of sale notional, TAF 0.000195 per sold share capped $9.79 per order, CAT 0.000003 per bought/sold share; aggregate each fee type per account/day and ceil separately to cents. Liquidate at the final close including costs so terminal wealth is spendable cash plus receivables. Taxes are investor-specific and excluded from trading returns; add an explicitly illustrative annual positive-profit haircut, not a tax calculation. Model $5/month operating overhead separately. No paid feed, margin, borrow, funding transfer or FX costs in the base assumption (USD, no transfers, no leverage). These are zero only for this specified setup.

## Comparisons and validation

Same dates, starting cash, costs, dividend accounting and liquidation for the candidate, fixed five-ETF buy-and-hold, and SPY buy-and-hold. Historical return, CAGR, daily net-equity maximum drawdown, volatility, excess-return Sharpe versus a zero-rate reference (not a measured risk-free rate), year returns, all transactions and cost decomposition. Score calendar blocks 2006–2015, 2016–2020 and 2021 onward with warmup from prior data and fresh cash per block. These are retrospective chronological tests, not an untouched holdout: this research began in 2026 and the literature already saw earlier markets.

Sensitivity tests retain every result: 8/12 months (not eligible for selection), 25/50 bps execution friction per side, $100/$10,000 capital, $5 monthly overhead, one extra session of fill delay. Seeded block bootstrap of monthly candidate returns versus the same-window static allocation, retaining paired samples, reports uncertainty rather than a trading permission p-value.

Research eligibility for forward simulated testing: positive full-sample return; positive 2016–2020 and 2021+ returns; positive 25 bps stress return; maximum drawdown below 35%; at least 60 observed rebalance dates. Passing does not prove alpha or future profitability. Never lower thresholds after viewing results. Preserve existing desks and accounts.

Forward account: independently start with $1,000 simulation money at first current observation, record decisions before any eligible fill, do not backfill older profits, retain state across jobs/restarts, reject changed strategy versions and malformed state, publish failed-source receipts while retaining original last successful marks. Real execution remains off. A broker transition requires its own paper integration, fill/fee reconciliation, valid account/data access and explicit real-money activation after testing; do not claim an easy switch has been demonstrated merely because an endpoint exists.

## Sources to verify

- Faber, A Quantitative Approach to Tactical Asset Allocation: https://mebfaber.com/timing-model/
- AQR, A Century of Evidence on Trend-Following Investing: https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing
- Alpaca September 1, 2026 schedule: https://files.alpaca.markets/disclosures/BrokFeeSched.pdf
- Alpaca paper limitations: https://docs.alpaca.markets/us/docs/paper-trading

## Accounting review amendments after the first preliminary run

The strategy and eligibility thresholds remain unchanged. An independent review found that 30 days is not universally conservative (SPY can pay later). Retain the base 30-day assumption and add a 60-day payment-delay stress. The initial hold benchmarks accumulate dividends as idle cash; add separately labeled paid-dividend-reinvestment benchmarks with the same costs. Exclude the last partial month from the paired bootstrap. Its original implementation fixes 2,000 resamples, 12-month circular blocks, seed 20260913; do not retune those after viewing results. Calendar coverage is checked against a pinned XNYS calendar, including exceptional closures.
