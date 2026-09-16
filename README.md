# Moffitt Money

[Open the app](https://moffitt-money.smoffitt74743.chatgpt.site/) · [GitHub Pages](https://srmcno.github.io/pm/)

Autonomous paper accounts with an activity-first main screen. Real orders remain off. Account balances and ledgers are separate; historical results are never presented as current performance.

## Main app

- **Overview:** the two existing $100 Polymarket US and Kalshi paper accounts, actual open positions, current collector status and expandable entry decisions.
- **Activity:** recorded paper entries and official settlements, with venue/status filters and CSV export. Scans are not counted as trades.
- **Archive:** one entry for auxiliary research tools, historical studies and diagnostics. Active copy, spot and ETF workflows are distinguished from retired experiments. No ledger is deleted or reset.

The focused entry requests only prediction data initially. Wallet research, crypto comparisons, ETF studies and the strategy laboratory remain accessible through Archive or the compact active-tools links.

## Paper entry

The versioned experimental paper policy can evaluate entries after 20 resolved cohort events and 10 similar-price events, without waiting for the strict 100/50/30 calibration screen. It uses a market-anchored estimate and an explicit experimental buffer, while retaining the original cost, quote, depth, two-scan, position-size, exposure and drawdown checks. This is a prospective experiment, not a proven edge. No trade is forced and real execution remains locked.

[Current paper policy and archive design](docs/ACTIVE-PAPER.md) · [Original accounting and calibration controls](docs/PREDICTIONS.md)

Prediction collection runs about every ten minutes, best effort, without a browser. The opportunity workflow retains its existing crypto comparisons, separate spot simulation and forward copy study. Retired international collectors and the original $50 copy account remain paused. Crypto price comparisons do not execute paired trades or credit balances. The ETF experiment retains its own schedule.

## Build and verify

```sh
npm test
python3 -m unittest discover -s scripts/tests
python3 -m unittest discover -s tests
python3 scripts/check_site.py
npm run build
python3 -m http.server 8874 --directory dist
```

The frontend needs no package installation. Python tests require `requests>=2.31,<3`. Both Sites and Pages must publish the same `dist/` artifact. `dashboard/focus.html` becomes the published root; the original `dashboard/index.html` becomes `archive-workspace.html`, with a return-to-main link. Serve the built artifact when reviewing the full product.

The browser checks published prediction data once a minute and retains newer valid snapshots on failures. Data-only commits do not require an interface deployment. Saved wallet stars remain local to their browser. No credentials are placed in the static output.

[Publishing and maintenance](docs/SITES.md) · [Forward copy study](docs/COPY-TRADING.md) · [Copy and crypto methodology](docs/COPY-CRYPTO.md) · [Copy backtests](reports/backtest-summary.md) · [ETF research](reports/etf-research.md)
