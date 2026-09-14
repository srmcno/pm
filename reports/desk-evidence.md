# Desk evidence

Generated 2026-09-14 07:02 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.8 | 6.666% | -16.376% | 0.02395 | 0.947 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.721 | 10.031% | -26.273% | 0.04175 | 0.726 | $500 | $500 |
| trend | validated | marginal | 0.969 | 25.205% | -27.876% | 0.07892 | 0.665 | $100 | $100 |
| xsect | not-significant | marginal | 0.491 | 8.016% | -32.164% | 0.16605 | 0.758 | $100 | $100 |
