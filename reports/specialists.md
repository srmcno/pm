# Specialist desks — tested and rejected (for now)

Hypothesis: since specialist *wallets* outperform generalists, a specialist
*copier* (per-category watchlists and signals) should outperform the unified
strategy. Same out-of-sample protocol as always: watchlist from first-half
PnL, trades on the second half, real price-history fills after a 1h delay.

| desk | watchlist | result | settled | win rate | top-3 share |
|---|---|---|---|---|---|
| **Unified strict** (all categories, ≥3 backers) | 43 | **+42.3%** | 34 | 53% | 51% |
| Sports only, ≥3 backers | 25 | +7.8% | 19 | 37% | 71% |
| Sports only, ≥2 backers | 25 | −2.0% | 88 | 49% | 22% |
| News (Politics+Econ+Mentions), ≥2 | 7 | −17.9% | 15 | 40% | 90% |
| Esports only, ≥2 | 7 | −8.0% | 1 | 0% | — |

## Why siloing hurt

1. **The unified desk already captures specialist consensus.** When three
   sports specialists in the mixed watchlist buy the same game, that *is* a
   sports-specialist signal — no silo needed to detect it.
2. **Silos shrink the pool.** The news desk had 7 qualified wallets and the
   esports desk 7; with pools that small, "consensus" is two people agreeing,
   and the strategy either barely trades (esports: 1 trade) or trades noise.
3. **Silos remove choice.** The unified desk takes the strongest signal on
   the board each cycle, whatever its domain. A desk locked to one category
   must take that category's best signal even on days when it's weak.

## Conclusion

Specialization belongs in the **watchlist** (which wallets qualify — already
enforced), not in the **copier**. The live configuration stays unified:
all categories, ≥3 independent backers, ≤3-day resolution. Revisit if the
cohort ever grows enough to give a single category a 25+ wallet pool with
deep consensus.
