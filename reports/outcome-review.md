# Outcome analysis

No tested strategy is profitable after modeled costs. Do not promote either variant as a validated trading improvement.

## Predeclared changes

1. `minNetR: 2`: raise the eligibility threshold from 1.25 to 2 units of planned net reward per unit of modeled loss. No other behavior changes.
2. `maxHoldingHours: 168`: extend the time exit from 48 to 168 hours. No other behavior changes. This required replacing the fixed timeout expression with `now - x.openedAt >= (model.maxHoldingHours ?? 48) * 3600`, plus the corresponding exit-reason label, in a scratch copy of the model.

Both changes were declared before either variant was executed. Fees, sizing, risk caps, confirmation, stops, targets, halts, timestamps, missing intervals and final liquidation were unchanged. All four baseline ledgers and returns were reproduced exactly. Source checkout files were not edited.

| Variant | Period | Net return | Max drawdown | Trades | Win rate | Profit factor | Fees | Exposure |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | Full 90 days | -13.28% | -15.06% | 39 | 25.64% | 0.305 | $109.28 | 19.89% |
| baseline | First 30 days | -10.66% | -12.49% | 31 | 29.03% | 0.345 | $88.23 | 52.60% |
| baseline | Middle 30 days | -5.49% | -5.98% | 14 | 21.43% | 0.115 | $40.81 | 28.78% |
| baseline | Last 30 days | -10.21% | -13.51% | 31 | 29.03% | 0.420 | $86.97 | 63.94% |
| net-r-two | Full 90 days | -13.73% | -14.00% | 28 | 21.43% | 0.238 | $77.02 | 22.64% |
| net-r-two | First 30 days | -1.87% | -3.53% | 8 | 37.50% | 0.412 | $23.58 | 23.95% |
| net-r-two | Middle 30 days | -2.10% | -2.10% | 2 | 0.00% | 0.000 | $5.85 | 8.09% |
| net-r-two | Last 30 days | -10.20% | -11.86% | 18 | 16.67% | 0.233 | $49.64 | 35.88% |
| seven-day-exit | Full 90 days | -10.42% | -15.02% | 29 | 20.69% | 0.422 | $82.42 | 39.92% |
| seven-day-exit | First 30 days | -7.35% | -12.09% | 18 | 16.67% | 0.431 | $52.30 | 69.90% |
| seven-day-exit | Middle 30 days | -2.94% | -4.01% | 10 | 30.00% | 0.430 | $29.63 | 46.17% |
| seven-day-exit | Last 30 days | -5.47% | -11.14% | 22 | 31.82% | 0.625 | $63.93 | 80.42% |

## Diagnosis

- Baseline expectancy is −$3.41 per trade. Mean winner is $5.83; mean loss is $6.59. The observed payoff distribution requires a 53.06% win rate to break even, versus 25.64% achieved. This is a retrospective descriptive statistic, not a forecast.
- The median trade began with just 1.449 planned reward/risk after costs, a 2.04% price stop and a 6.23% price target. Time exits make realized payoff materially smaller than planned target payoff.
- Twenty-one stops cost $164.83. Thirteen time exits gained $18.16; only two targets gained $23.99. Three portfolio-halt exits cost $10.15.
- Recorded entry/exit fees total $109.28 of $132.83 net loss (82.27%). Adding back recorded fees to this fixed ledger still leaves −$23.55 with spread/slippage included. This is not a simulated zero-fee strategy.
- The full account halted on July 20, 49.33 days before the final date. Thirty-day slice accounts restart capital and halts, and are not additive.
- Repeated scans reuse the same completed-hour signal. They check persistence across time, not independent signal corroboration.

## Interpretation

The stricter reward/risk gate reduces trade count and fees but worsens the full return and profit factor. It is rejected. Longer holding loses less in all slices, but remains negative everywhere, increases full-period exposure from 19.89% to 39.92%, and still triggers the drawdown halt. It is retained as a negative research result, not evidence for enabling trading.

Use the outcome failure to gate entries and describe scans as research candidates. Planned reward/risk is an eligibility calculation and must not substitute for demonstrated net profitability. No recommendation here changes execution fees or disables loss halts.

## Limits

These are retrospective sensitivity checks on already-reviewed history, not untouched holdouts. The five-minute replay approximates quotes with actual opens and modeled spread; only previously completed hourly candles inform signals. Stops can use prior completed-hour touches whereas targets require observed scan quotes, a conservative asymmetric exit convention. No ticks or historical order books exist in the input. AVAX coverage is limited; existing high-coverage baseline also lost money. Ninety days of correlated assets are insufficient to establish durable edge.

## Reproduce

Run `node scripts/outcome-research/run.mjs` from the repository. It uses the frozen research model and the committed source candles, and verifies the baseline ledgers exactly before reporting the two variants. Output is an ignored local results file. These research copies are separate from the deployed model.
