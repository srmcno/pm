# Desk evidence

Generated 2026-09-02 16:17 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.763 | 6.116% | -16.607% | 0.03132 | 0.938 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.724 | 10.085% | -26.491% | 0.04095 | 0.725 | $500 | $500 |
| trend | not-significant | marginal | 0.904 | 22.948% | -30.811% | 0.10121 | 0.705 | $100 | $100 |
| xsect | not-significant | marginal | 0.498 | 8.284% | -33.213% | 0.15943 | 0.753 | $100 | $100 |
