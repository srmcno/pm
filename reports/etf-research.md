# Monthly ETF trend: recorded research

Model `2026-09-13-etf-monthly-v1`. Data through 2026-09-11.

Fixed rules were declared in docs/ETF-RESEARCH-PLAN.md before this run. All figures are historical simulation, not promised returns.

| Scenario | CAGR | Net return | Max drawdown | Trades | Regulatory fees |
|---|---:|---:|---:|---:|---:|
| Monthly trend | 5.76% | 218.83% | -15.63% | 902 | $7.48 |
| Five-ETF buy & hold | 7.23% | 324.20% | -32.12% | 10 | $0.11 |
| SPY buy & hold | 9.73% | 582.94% | -52.76% | 2 | $0.16 |
| 25 bps per side | 5.39% | 196.08% | -15.76% | 898 | $7.45 |
| 50 bps per side | 4.86% | 167.07% | -15.94% | 903 | $7.46 |
| One extra session delay | 5.51% | 203.55% | -15.80% | 913 | $7.49 |
| $100 account | 5.66% | 212.56% | -15.44% | 440 | $5.32 |
| $10,000 account | 5.78% | 219.87% | -15.63% | 970 | $15.20 |
| $5 monthly overhead | -0.34% | -6.84% | -35.89% | 975 | $7.20 |
| Illustrative 25% positive-year haircut | 4.10% | 129.80% | -15.63% | 905 | $7.33 |
| 8-month sensitivity (not selected) | 6.11% | 241.38% | -18.06% | 898 | $7.54 |
| 12-month sensitivity (not selected) | 5.87% | 225.62% | -12.39% | 903 | $7.35 |
| 60-day distribution payment lag | 5.77% | 218.94% | -15.63% | 901 | $7.47 |
| Five-ETF hold with distributions reinvested | 8.02% | 393.75% | -34.30% | 203 | $2.03 |
| SPY hold with distributions reinvested | 11.11% | 784.43% | -55.06% | 84 | $1.04 |

## Chronological checks (retrospective, not untouched holdouts)

| Period / strategy | CAGR | Drawdown |
|---|---:|---:|
| 2006–2015 trend | 6.03% | -15.63% |
| 2006–2015 hold | 5.35% | -32.12% |
| 2006–2015 spy | 6.41% | -52.76% |
| 2016–2020 trend | 4.89% | -8.09% |
| 2016–2020 hold | 8.90% | -20.53% |
| 2016–2020 spy | 14.79% | -31.80% |
| 2021–2026 trend | 6.01% | -11.89% |
| 2021–2026 hold | 8.98% | -22.72% |
| 2021–2026 spy | 14.24% | -24.12% |

Paired monthly block bootstrap: 95% interval for annualized log-return difference versus five-ETF hold: -3.60% to 0.98%. This is sample uncertainty, not a forecast.

Paper research gate: passed. Real-money activation: not authorized or validated.

## Limits

- Retrospective study; no untouched holdout or demonstrated future profit.
- Daily Yahoo prices are not broker opening fills; cost/delay stresses model execution uncertainty.
- Dividends use an assumed 30-day cash-payment delay; official payment dates are absent.
- Current selected ETFs survived; fees are a September 2026 counterfactual across all dates.
- Returns are before personal income taxes; the positive-year haircut is only an illustration.
- No leverage, borrow, FX, transfer or paid-data costs in base setup; ETF expenses are embedded in prices.
- Sharpe uses a zero cash reference. Idle cash earns zero. Comparators hold actual shares without daily rebalancing.

## Reproduce

Run `python3 scripts/etf_lab.py research`. Frozen compressed source responses and hashes are in `data/etf/raw/`; full daily curves, transactions, decisions and distributions are in `data/etf/research.json`.

Current fees: [Alpaca September 2026 schedule](https://files.alpaca.markets/disclosures/BrokFeeSched.pdf). Research context: [AQR trend evidence](https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing). These papers do not validate this implementation.
