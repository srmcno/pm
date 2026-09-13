# Copy trading and crypto arbitrage improvements

Purpose: improve selection, accounting, realistic sizing and evidence while keeping Copy trading and Crypto arbitrage separate from Kalshi/Polymarket prediction accounts. Built-in simulation remains the selected mode.

## Findings and changes

- Copy research: 254 accounts reviewed; 52 pass fixed history, consistency and diversification rules. Freeze the top 20 before forward observations. Scores measure the shape of historical results, not absolute profit or a fitted win probability. August 12 inferred-resolution profiles are too dated and incomplete to be current verified labels.
- Correct principal/share VWAP: two $100 buys at 20¢ and 80¢ acquire 625 shares at a 32¢ average. Weight the aggregate reference by remaining net buying; an exited whale must not dominate entry drift. A recent sale must not rejuvenate old buying.
- Add a separate $100 copy simulation with two-scan confirmation, fee-inclusive ask-depth sizing, position limits, bid liquidation marks, cash reconciliation and official final payouts. Preserve the old $50 record and its provisional labels.
- Crypto: optimize net dollars at both books' quantity breakpoints, minimums and the budget boundary. The independent fixture has +$1.576 at one unit but −$10.876 at two units. A full-budget-only check misses the profitable slice.
- Reprice the exact initial route and quantity after a second book read, retaining cash and slippage assumptions. A missing, repeated, stale or mismatched recheck never counts as survival.
- Expose required gross spread, account-tier fee sensitivity, profitable capacity and delayed observations in the existing screens.

## Reproducible historical evidence

`python3 scripts/study-trading-history.py` reads September 2–8 archives. Kraken: 16,375 scans, 273 selected positive-depth receipts across 12 routes; its top two routes generated 87.18% of receipts. The median screen-to-recheck reduction was 42.7 bps, combining depth, price movement between reads and changed sizing. MEXC: 38,148 scans, 4,594 selected positive-depth receipts across 240 routes; median deterioration 91.1 bps. These are repeated selected quotes, not independent wins or realized fills. Full historical depth and synchronized venue timestamps were not retained.

The prior copy tests share a June 28–August 12 window and omit explicit fees. Three backers / one-hour delay showed +42.3% marked return, versus −1.9% for two backers / one hour and −26.2% for two backers / three hours. The best variant had 34 settled trades and ten open positions; three winners supplied 51% of gross profit. These results motivate forward measurement; they do not establish repeatable edge.

## Progress

- [x] Public API contracts checked against primary documentation and current responses.
- [x] Independent ranking calculation and 500-case crypto brute-force comparison.
- [x] Isolated real-data cycles: complete 20-wallet reads and delayed checks for 12 crypto routes.
- [x] Integrated checks: 111 Node tests, 307 script Python tests and 115 other Python tests passed; static integrity/build and desktop/mobile workflows passed.
- [x] Published app 5.2.0 to the same private Site (saved version 8) and GitHub Pages; both build identities verified at `0be06a33c0ca6306ff3ce25e3674593ae1635d94`. Public desktop/mobile flows and private HTTP/module checks passed.

See [copy study operation](../docs/COPY-TRADING.md) for formulas, limits and primary references. No real trading or profit guarantees are implied by simulated or archived results.

Publication: [Site](https://moffitt-money.smoffitt74743.chatgpt.site), [Pages](https://srmcno.github.io/pm/), [CI](https://github.com/srmcno/pm/actions/runs/34787661714), [first scheduled study cycle](https://github.com/srmcno/pm/actions/runs/34787661713). The hosted cycle completed all public collectors and published 11 held copy candidates with the $100 account intact; no forward trades had settled at verification.
