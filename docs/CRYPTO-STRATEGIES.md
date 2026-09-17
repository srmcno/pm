# Multi-coin directional paper strategies, version 5.4.0

Owner authorization: implement the crypto redesign and retire the losing legacy strategies. No real-money trading is authorized or connected.

## Active versus archived

Primary navigation is Predictions, Crypto Strategies, Activity, Archive. `crypto.html` is the same-site crypto page; `crypto.html#activity` combines current crypto and prediction ledgers without pooling capital. `crypto.html#retired` holds retirement evidence. The old workspace remains accessible through the existing Archive.

Volume breakout and Trend reclaim are permanently exit-only through `scripts/legacy-spot-exit-only.mjs`. Original rules, open positions, closed trades, fees, and balance remain intact. The prior spot account is not reinitialized. At inspection its three closed forward trades were negative and its equity was $969.6864081509837 from $1,000. The dated standalone breakout replay showed 27 trades and -$94.0651647640251; reclaim showed only one replay trade and -$10.915554701010421. These are different samples, not amounts to add together. In particular, one replay trade is not proof of persistent failure. Both are retired at the owner's request rather than falsely described as universally losing. The collector derives and publishes current retirement evidence from the original records.

## New prospective experiments

Two distinctly versioned paper strategies receive independent $1,000 synthetic bankrolls. These are new experiments, not renamed old strategies or recovered capital. No historical profits are seeded.

Relative-strength rotation compares 6h and 24h upward movement, volatility-normalized cross-coin strength and BTC-relative performance. It requires a price above the 20-hour EMA without excessive extension. Unlike the retired Volume breakout, it does not require breaking a 20-bar high with a volume spike and a later confirming hourly breakout. Unlike Trend reclaim, it does not require two rising moving averages and an EMA crossing.

Range recovery tests a confirmed rebound after a drawdown of at least three ATRs or 2%, with two increasing completed closes and room toward the recent range high. It does not enter merely because a coin is down.

The declared Coinbase USD universe is BTC, ETH, SOL, LINK, AVAX, DOGE, XRP, ADA, LTC and DOT. Each cycle verifies each product's current identity, availability and quantity increment, obtains completed hourly candles and fresh public books. Unavailable products are explicitly excluded rather than replaced with made-up prices. Sixty completed contiguous hourly bars are required, not 100 settled trades or a previously profitable model.

## Costs, controls and accounting

The frozen simulation assumes 0.60% fees and 0.10% additional slippage on each side. Actual displayed asks and bids are walked, so spreads and depth costs are included. These fee assumptions do not claim to match a connected user's fee tier. Public product minima and quantity increments apply. Entry and immediate liquidation must fit depth. No real order is submitted.

Maximum initial capital per position is 20% of strategy equity, with 60% total deployed capital and three open positions per strategy. Planned stop risk is 1%; adverse gaps can lose more. Planned net reward/risk must exceed 1.1 after modeled costs. New entries need two qualifying scans 60 to 1,800 seconds apart. A short intervening scan preserves the first timestamp; a missing signal resets confirmation. No same-signal duplicate or re-entry within six hours of closing that coin is allowed.

Exit on observed stop, target, downward momentum reversal, or maximum holding window (72h rotation, 36h recovery). No fill is invented at a price seen only in an unobserved candle. Stale marks retain their original value and block new entries. New entries pause after 3% daily equity loss or 10% peak drawdown; a drawdown pause does not restart automatically. All accounts reconcile initial capital minus entry costs plus exit proceeds, and equity to cash plus liquidation marks. Invalid existing state is refused, never reset.

Automatic permanent retirement requires the most recent 30 closed net trades to span at least 14 days, have negative total P&L and profit factor below one, and lose money in each of three consecutive 10-trade blocks. This is a declared product rule, not a statistical proof of inferiority. Retired accounts still manage existing exits and remain in Activity and Archive.

Spot-only: buying and selling owned synthetic coins. Downward signals sell holdings or keep cash. No fabricated spot shorts, borrowing, leverage or real account eligibility is implied.

## Operation and verification

The existing five-minute opportunity workflow calls the new collector. Its group lock serializes writers and rebase fails on conflicting state updates. `data/crypto-strategies/state.json` is authoritative. The browser is read-only and can be closed. A scheduled scan is not continuous real-time execution. Collector locks, atomic file replacement, per-product error timestamps, validation and retained-data handling are explicit.

Run `node --test tests/crypto-strategies.test.mjs`, full `npm test`, both existing Python suites, `python3 scripts/check_site.py` and `npm run build`. Browser QA uses clearly separate synthetic fixtures offline, never committed as account performance. Check the deployment and actual collector receipt before claiming completion. Preserve `.openai/hosting.json` and do not claim the separate ChatGPT Site has updated without a successful release check.

Official API references:
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
- https://docs.cdp.coinbase.com/exchange/introduction/welcome
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book
