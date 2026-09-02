# Desk evidence

Generated 2026-09-02 16:37 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.806 | 6.485% | -16.778% | 0.02291 | 0.938 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.73 | 10.187% | -26.486% | 0.03921 | 0.725 | $500 | $500 |
| trend | not-significant | marginal | 0.906 | 23.009% | -30.811% | 0.10059 | 0.705 | $100 | $100 |
| xsect | not-significant | marginal | 0.565 | 9.692% | -33.212% | 0.11071 | 0.753 | $100 | $100 |
