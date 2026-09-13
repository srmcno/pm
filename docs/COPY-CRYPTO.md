# Copy trading and crypto arbitrage

These remain core product features. Prediction-contract comparisons under Kalshi/Polymarket are a separate research tool. Built-in simulation is selected; the interface cannot place real orders.

## Copy trading

`scripts/publish-copy-research.py` derives `dashboard/data/copy-trading.json` from `data/analyzed.json`, `data/signals/latest.json` and `data/paper/state.json`. It preserves each source's original timestamp. The existing `pmlib.build_watchlist` supplies historical cohort membership and priority, excluding incomplete histories and market makers. Priority combines historical P&L rank and profitable-day rate; it is not a calibrated win probability.

Wallet P&L curves are cumulative changes from their source period baseline. Missing statistics remain missing. Profitable days exclude changes of $1 or less; that denominator is not the number of settled trades. The paper chart starts at the recorded all-cash $50 opening baseline, before the current book's first trade. An inherited earlier $5.27 point is retained in raw history but excluded from that chart.

The old paper model omitted explicit exchange fees and sometimes inferred settlement from a closed market's extreme price. Its balances, closed records and win counts are marked provisional. The consensus feed and old simulator remain paused. Historical variants retain their own identities and reports; the strict three-backer report must not be substituted with the unrelated latest one-trade test.

Profiles can fetch at most 50 recent trades from the [public international Polymarket activity API](https://docs.polymarket.com/api-reference/core/get-user-activity). These observations are separate from Polymarket US. The reader verifies wallet address, TRADE type, transaction/token identity and finite values. It uses the named outcome instead of trusting an occasional `outcomeIndex:999` sentinel. It does not build new consensus, copy trades or access private accounts. Saved wallets are browser-local preferences.

## Crypto arbitrage

`scripts/collect-crypto-arbitrage.mjs` reads public Coinbase Exchange and Kraken Pro metadata and books for BTC, ETH, SOL, LINK, AVAX and DOGE against USD. Explicit aliases map XBT to BTC and XDG to DOGE. Returned metadata and Kraken book keys must match the requested market. ETH/BTC and SOL/BTC additionally support four three-leg Kraken cycles. No deposit, withdrawal, account, order or international execution endpoint is called.

The existing opportunity workflow records these comparisons about every five minutes. `dashboard/data/crypto-arbitrage.json` retains up to 288 scan summaries. These are observations, never paper trades or profits credited to an account.

- Walk enough ask depth for the selected all-in buy budget, rounded down to compatible quantity increments. Walk sell bids for exactly the same base-asset quantity.
- Include quote-denominated fees on both legs and 5 bps additional slippage per leg. Depth impact is already inside walked prices and is not charged again.
- Enforce source market status, increments and minimum orders. Reject absent fees, invalid times, provider timestamps older than 30 seconds when supplied, receipt age above 30 seconds or receipt skew above five seconds.
- Current fee assumptions, reviewed September 13, 2026: [Coinbase Exchange base taker 0.60%](https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees), [Kraken Pro spot base taker 0.80%](https://www.kraken.com/features/fee-schedule). These are product-specific base assumptions, not connected account tiers. Kraken's missing `AssetPairs.fees` array is never interpreted as zero or the older 0.40% fallback.
- The browser reprices recorded books at their original scan time when comparison size changes. It labels the source date instead of implying those are current executable quotes.
- Three-leg cycles walk each book in order with quote fees, rounding and minimums. Unused rounding dust receives zero liquidation value.

Cross-venue execution requires USD on one venue and existing crypto on the other. Actual funding, concurrent fills, partial execution, later rebalancing and transfer costs remain unverified. All results carry `executable:false`; there is no fill path. Provider timestamps are retained where supplied; Kraken level-update timestamps are not promoted to a whole-book snapshot time.

Primary API contracts: [Coinbase product book](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book), [Kraken depth](https://docs.kraken.com/api-reference/market-data/get-order-book).

`dashboard/data/crypto-history.json` exposes dated earlier Kraken/MEXC studies from preserved snapshots. Their positive-cycle credits and assumed atomic fills do not establish realized returns. The active directional Coinbase spot account remains independently visible under Spot paper with its existing ledger and entry policy.
