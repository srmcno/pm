# One-day cross-venue moneyline screen

Window: 2026-09-12T20:09:00+00:00 through 2026-09-13T20:09:00+00:00.

At each Kalshi minute end use its bid/ask closes and latest Polymarket stored observation no later than that end, aged at most 60 seconds. One contract on each leg, current fee counterfactual, round each fee up to cents, add 1 cent per leg slippage. No future match, forward-fill beyond 60s, depth, fills, or realized profit.

| Game / Kalshi team contract | PM points | Kalshi bars | Aligned minute ends | Directional samples | Gross below $1 | Net below $1 | Strongest net gap |
|---|---:|---:|---:|---:|---:|---:|---:|
| nfl / DEN | 914 | 1355 | 862 | 1724 | 0 | 0 | $-0.0650 |
| nfl / KC | 914 | 1023 | 632 | 1264 | 0 | 0 | $-0.0650 |
| mlb / NYY | 1538 | 161 | 113 | 226 | 21 | 0 | $-0.0300 |
| mlb / MIN | 1538 | 181 | 130 | 260 | 37 | 0 | $-0.0400 |

The two game histories are reused across team contracts; do not add PM point counts across these rows.

Same scheduled game and team orientations verified. Both state tie payout 0.50. Polymarket: delayed/postponed/suspended game rescheduled within two calendar days; Kalshi: game must BEGIN within 48 hours. Fair-market settlement determined independently. Full pathwise equivalence is not established.
Same Sep14 19:40 ET game verified. Material mismatch: Polymarket permits rescheduling within TWO WEEKS, Kalshi within TWO DAYS; fair-value fallback can differ. Not a guaranteed complementary payout package.

- Screening only: PM display prices are normally best-ask-derived, but there is no historical depth or executable order confirmation.
- Kalshi minute close quote can have stale underlying updates; minute end is an availability boundary, not an authenticated quote timestamp.
- Repeated observations and complementary directions are correlated, not independent trades. Missing bars are excluded and no coverage beyond the observed sample is asserted.
- Current fee coefficients are a counterfactual across this one-day window, not proof every historical fill had that fee. Future overrides not applied early.
- Both games remain unresolved at study time; no realized profit or outcomes follow. Rule mismatch independently blocks arbitrage eligibility.

Primary documentation: https://docs.polymarket.us/api-reference/price-history/get-price-history and https://docs.kalshi.com/api-reference/market/get-market-candlesticks . Raw responses, URLs, retrieval timestamps and SHA-256 are in provenance.json and discovery-provenance.json. Full directional observations are in matched-screen.json.

## Reproduce

Run `python3 scripts/study-paired-history.py --output /tmp/paired-reproduction` from this checkout. The frozen input responses and their SHA-256 values are in [data/research/paired-2026-09-13](../data/research/paired-2026-09-13). The script verifies each input before use. Compare its `analysis.json` with the committed result. No account state is touched.

## Contract and cost review

The screen uses Polymarket **US**, a separate venue from the international wallet archive. Its displayed price history is a quote-derived screen, not a trade tape. We reviewed the [price history contract](https://docs.polymarket.us/api-reference/price-history/get-price-history), [current U.S. fee coefficient](https://docs.polymarket.us/fees), [sports settlement FAQ](https://docs.polymarket.us/faqs/sports-faqs), [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding), [Kalshi NFL terms](https://assets.kalshi.com/contract_terms/FOOTBALLGAMEWIN.pdf), and [Kalshi MLB terms](https://assets.kalshi.com/contract_terms/BASEBALLGAMEWIN.pdf). These are dated findings from September 13, 2026; future rule and fee changes need a fresh review.

Neither a same-game identity match nor a sub-dollar quote package certifies arbitrage. The forward scanner records both books, explicit team-strike orientation, original quote times, fees and rule hashes, then holds execution. Exceptional settlements are modeled with a conservative 0–2 dollar package payout interval until equivalence is established.

Dated matching receipts for both team strikes are retained in [identity-review.json](../data/research/paired-2026-09-13/identity-review.json), including provider IDs, milestone/target source URLs, rules and rule hashes. These corroborating forward observations are separate from the historical quote sample.
