# Moffitt Money

[Open the app](https://moffitt-money.smoffitt74743.chatgpt.site/) · [GitHub Pages](https://srmcno.github.io/pm/)

**Copy trading, crypto arbitrage and prediction markets**, with built-in simulation and dated evidence. Real orders remain off. These are separate disciplines with separate account records.

## Main sections

- **Copy trading:** 254 researched wallets, a 54-wallet historical cohort, searchable specialties, saved wallets, wallet charts and recent public activity. Consensus signals expose their backing wallets. The paused $50 paper book retains every position and closed trade, exports and historical strategy comparisons.
- **Crypto arbitrage:** same-asset Coinbase Exchange/Kraken Pro comparisons in both directions, plus Kraken three-leg cycles. Change the comparison size and inspect walked prices, both fees, minimums, slippage and inventory requirements. Earlier crypto simulations remain accessible under History. The existing directional spot-paper account is a separate tab.
- **Predictions:** Kalshi and Polymarket US contract research, two independent $100 simulated accounts, official settlement processing and contract comparisons. Prediction contract comparisons are distinct from crypto arbitrage.
- **Research:** the ETF experiment and detailed prediction evidence, with direct links to copy-trading results, crypto history and the separate strategy laboratory.

The copy-wallet analytics and consensus record are dated September 7–8. Its old paper model omitted explicit exchange fees and sometimes inferred settlement from prices, so recorded profits remain provisional. A profile can read its latest 50 public international Polymarket trades without placing or copying orders. The historical cohort is not a current recommendation.

Crypto comparisons use current public depth under explicit assumptions: $100 default buy budget, Coinbase Exchange 0.60% and Kraken Pro spot 0.80% base taker fees reviewed September 13, plus 5 bps slippage per leg. They preserve original receipt/provider timestamps and verify returned asset identities. A positive modeled gap never creates a trade or credits a balance. Actual account fees, funding, simultaneous fills and inventory rebalancing remain unverified.

[Copy and crypto methodology](docs/COPY-CRYPTO.md) · [Copy backtests](reports/backtest-summary.md) · [Prediction controls](docs/PREDICTIONS.md) · [ETF research](reports/etf-research.md)

## Run and verify

```sh
npm test
python3 -m unittest discover -s scripts/tests
python3 -m unittest discover -s tests
python3 scripts/check_site.py
npm run build
python3 -m http.server 8874 --directory dist
```

Python tests require `requests>=2.31,<3`. The frontend needs no package installation. Both Sites and Pages publish the same `dist/` allowlist.

```sh
python3 scripts/publish-copy-research.py
node scripts/collect-crypto-arbitrage.mjs
```

The first command derives the dated publication from preserved source records without network calls. The second makes public market-data GETs and records comparisons, without accessing accounts or submitting orders. Pass `--output /tmp/crypto-check.json` to collect into an isolated file.

## Operation

The existing opportunity workflow updates crypto comparisons and its separate spot simulation about every five minutes. Prediction accounts run about every ten minutes. Schedules are best effort. Copy consensus/paper collectors remain paused; checking a wallet's activity does not restart them. ETF simulation retains its existing schedule.

The browser checks published data once a minute and retains newer valid snapshots on failure. Each section shows its own source date and error state. Saved wallet stars persist on the current browser only.

[Publishing and maintenance](docs/SITES.md) · [Research review](reports/research-review-2026-09-13.md)
