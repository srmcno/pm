# Desk evidence

Generated 2026-09-08 16:14 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.798 | 6.629% | -16.415% | 0.02439 | 0.946 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.724 | 10.061% | -26.274% | 0.04085 | 0.724 | $500 | $500 |
| trend | validated | marginal | 0.913 | 23.278% | -28.588% | 0.09792 | 0.664 | $100 | $100 |
| xsect | not-significant | marginal | 0.514 | 8.502% | -32.164% | 0.14678 | 0.756 | $100 | $100 |
