# Scanner historical replay

2026-06-10T00:00:00.000Z through 2026-09-08T00:00:00.000Z. Model 2026-09-08-scanner-v2.

| Scenario | Net return | Max drawdown | Trades | Win rate | Profit factor | Fees | Buy and hold |
|---|---:|---:|---:|---:|---:|---:|---:|
| Combined · 90 days | -13.28% | -15.06% | 39 | 25.64% | 0.31 | $109.28 | 36.41% |
| Breakout only | -13.36% | -15.16% | 40 | 22.50% | 0.29 | $112.70 | 36.41% |
| Reclaim only | -14.96% | -14.96% | 27 | 14.81% | 0.07 | $74.52 | 36.41% |
| Higher costs | -14.29% | -14.55% | 30 | 23.33% | 0.35 | $132.81 | 34.92% |
| 15-minute scans | -12.56% | -15.02% | 36 | 22.22% | 0.25 | $101.90 | 36.41% |
| First 30 days | -10.66% | -12.49% | 31 | 29.03% | 0.35 | $88.23 | 0.80% |
| Middle 30 days | -5.49% | -5.98% | 14 | 21.43% | 0.11 | $40.81 | 0.33% |
| Last 30 days | -10.21% | -13.51% | 31 | 29.03% | 0.42 | $86.97 | 30.59% |
| High-coverage markets only | -13.46% | -15.24% | 45 | 24.44% | 0.31 | $126.52 | 39.76% |

## Data coverage

- BTC-USD: 100.0000% of five-minute intervals, 0 missing. Hourly coverage 100.00%.
- ETH-USD: 100.0000% of five-minute intervals, 0 missing. Hourly coverage 100.00%.
- SOL-USD: 100.0000% of five-minute intervals, 0 missing. Hourly coverage 100.00%.
- LINK-USD: 99.9961% of five-minute intervals, 1 missing. Hourly coverage 100.00%.
- AVAX-USD: 94.7338% of five-minute intervals, 1365 missing. Hourly coverage 100.00%.
- DOGE-USD: 99.9846% of five-minute intervals, 4 missing. Hourly coverage 100.00%.

The full-universe replay is data-limited. The high-coverage comparison includes BTC-USD, ETH-USD, SOL-USD, LINK-USD, DOGE-USD. No prices were filled into the gaps.

## Method

- Fixed rules with no parameter search or selection of the best result.
- Actual five-minute opens drive scheduled scans. Only completed hourly candles inform entries.
- Two distinct scans confirm an entry. The same paper-account function controls sizing, fees, halts and exits.
- Default costs: 60 bps fees and 10 bps slippage per side, plus an assumed 10 bps bid/ask spread.
- End-of-window positions are liquidated with modeled costs. Three 30-day slices each start with $1,000.
- The benchmark equally holds all six assets with the same modeled costs. It has higher exposure than this strategy.

## Limits

- This is a historical scan replay, not tick or order-book execution. Intrabar events and actual spread/depth are unknown.
- Missing five-minute intervals are skipped, never filled with invented prices. Missing hourly history can suppress signals.
- The present six-asset universe was fixed before this replay; delisted assets are not included.
- Ninety days and correlated crypto markets cannot establish a durable edge. These are not calibrated forecasts.
- No historical Pump.fun strategy was tested. Current token profiles cannot reconstruct failed or vanished tokens.

Inputs: `data/opportunities/backtest-inputs.json.gz`. SHA-256: `cb9f51f14deecd39a11c81911422a04ee9bfbd63d24330011b72efb1b88f2975`.

Source: [Coinbase candle API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).
