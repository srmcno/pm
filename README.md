# Moffitt Money

**September 19:** Art Deco redesign, repaired forward collection, three new experiments, fee-stressed readiness and an Oklahoma platform review. [Funding setup](https://srmcno.github.io/pm/readiness.html) · [Cleanup record](docs/CLEANUP-2026-09-19.md) · [Private broker-preview guide](docs/FUNDING.md)

[Open the app](https://moffitt-money.smoffitt74743.chatgpt.site/) · [GitHub Pages](https://srmcno.github.io/pm/)

Autonomous paper accounts with an activity-first main screen. Real orders remain off. Account balances and ledgers are separate; historical results are never presented as current performance.

## Main app

- **Overview:** the two existing $100 Polymarket US and Kalshi paper accounts, actual open positions, current collector status and expandable entry decisions.
- **Crypto Tournament:** up to 40 dynamically selected Coinbase USD spot markets feed eleven independent, cost-aware paper strategies. Existing crypto ledgers are preserved through migration.
- **Activity:** recorded prediction and crypto paper positions with account/status filters and CSV export. Scans are not counted as trades.
- **Archive:** auxiliary research, arbitrage comparisons, retired strategies, historical studies and diagnostics. No ledger is deleted or reset.

The prediction overview includes a compact tournament summary. The full crypto page shows strategy equity, fee drag, open positions, selected markets, candidate/hold reasons and retirement evidence.

## Paper entry

The versioned experimental paper policy can evaluate entries after 20 resolved cohort events and 10 similar-price events, without waiting for the strict 100/50/30 calibration screen. It uses a market-anchored estimate and an explicit experimental buffer, while retaining the original cost, quote, depth, two-scan, position-size, exposure and drawdown checks. This is a prospective experiment, not a proven edge. No trade is forced and real execution remains locked.

[Current paper policy and archive design](docs/ACTIVE-PAPER.md) · [Original accounting and calibration controls](docs/PREDICTIONS.md)

Prediction collection runs about every ten minutes, best effort, without a browser. The five-minute opportunity workflow advances the eleven-strategy crypto tournament, retains separate arbitrage comparisons, while the international copy study is settlement-only every six hours. Crypto tournament fills use a versioned U.S. Coinbase Advanced taker-cost profile plus walked spread/depth and extra slippage. Retired international collectors and the original $50 copy account remain paused. The ETF experiment retains its own schedule.

[Crypto tournament design and operating rules](docs/CRYPTO-STRATEGIES.md)

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
