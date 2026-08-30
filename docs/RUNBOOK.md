# Running this with real money

Everything here is verified against live venue APIs and fee schedules as of
30 August 2026. Where a number moves — SEC fee rates reset annually, Kalshi
publishes per-series fee multipliers, state rules on event contracts shift —
the text says so and tells you where to re-check it.

Read the first section before anything else. It is the part that decides
whether this is worth doing at your account size.

---

## 1. What your account size actually permits

The binding constraint on a small US account is not regulation. It is cost,
and one cost dominates: **US regulatory fees are aggregated per day, per fee
type, and rounded up to the cent.** Any day on which you trade equities costs
at least $0.03 (SEC + FINRA TAF + CAT), no matter how small the trade.

Measured on the overnight desk over ten years of real data, charging that
floor:

| Starting capital | After 10 years | CAGR | Sharpe | Fees as % of capital/yr |
|---|---|---|---|---|
| $40 | **$0.00** | — | — | 14.4% |
| $100 | $138 | 3.4% | 0.38 | 6.9% |
| $250 | $513 | 7.9% | 0.80 | 2.7% |
| $500 | $1,139 | 9.1% | 0.91 | 1.4% |
| $1,000 | $2,382 | 9.6% | 0.96 | 0.8% |

A $40 account running a daily equity strategy does not underperform. It goes
to zero, and the strategy itself is fine — the fee floor eats it.

**What this means for you:**

| Capital | What to run | Why |
|---|---|---|
| Under $100 | Kalshi only (`micro` preset) | Contracts are fractional to $0.01 and maker orders are free on 98.7% of series. The only venue where a tiny account is not structurally disadvantaged. |
| $100–$250 | Kalshi + `xsect` | Cross-sectional momentum rebalances monthly — about 12 active days a year, so $0.36/yr in fee floor instead of $7.50. |
| $250–$2,000 | `small` preset: overnight, xsect, Kalshi | Daily equity desks become viable. Still no shorting — under $2,000 an Alpaca account is limited-margin. |
| $2,000+ | `standard` preset: everything | Shorting and 4x intraday buying power unlock. Fee floor is noise. Crypto trend is worth its 25bps taker cost. |

Check your own numbers before funding anything:

```bash
cd scripts
python3 -m desk.cli --equity 500 costs
```

---

## 2. What is actually validated, and what is not

Nothing trades until it passes walk-forward testing on data it never saw
during fitting, with every cost charged. Current verdicts:

| Desk | Out-of-sample | Benchmark | Verdict |
|---|---|---|---|
| `overnight` — hold US ETFs only overnight | Sharpe 0.82, CAGR 8.6%, maxDD -19% | SPY 0.92 / 20% / -36% | validated |
| `trend` — BTC/ETH above a moving average | Sharpe 1.13, CAGR 31.7%, maxDD -28% | BTC 0.87 / 35.7% / -53% | validated |
| `xsect` — monthly ETF momentum | Sharpe 0.64, CAGR 11.6%, maxDD -33% | — | validated |

Read those honestly. **Neither `overnight` nor `trend` beats buy-and-hold on
absolute return.** Both earn a better risk-adjusted return with roughly half
the drawdown. If you want maximum return and can tolerate a 53% drawdown,
buy and hold bitcoin. If you want a smoother path, that is what these buy.

Things tested and found dead — do not let anyone sell you these:

- **Cross-venue crypto arbitrage** between US venues: measured live, best net
  edge **-64bps**. Coinbase, Kraken and Alpaca quote within ~2bps of each
  other; combined taker fees are ~65bps.
- **Triangular arbitrage on Kraken**: median round-trip fee hurdle ~100bps,
  best cycle over 16 days of continuous scanning was -20bps.
- **Kalshi basket arbitrage**: baskets that price below $1 turn out to be
  non-exhaustive (the "none of the above" outcome is not listed) and show
  zero resting liquidity.
- **Intraday crypto→equity lead-lag** (the previous system's flagship): 239
  live paper trades, **-4.2%**, 81% of them stopped out, 23% win rate.

Regenerate all of this yourself:

```bash
python3 -m desk.cli validate          # walk-forward every desk, writes evidence
cat reports/desk-evidence.md
```

---

## 3. Opening the accounts

### Alpaca (US equities + crypto)

1. Sign up at **alpaca.markets**, individual taxable account. There is **no
   minimum funding requirement**.
2. Identity verification is standard brokerage KYC: legal name, address, SSN,
   employment, a photo ID. Approval is usually same-day to two days.
3. Fund by ACH (free). Note two frictions that surprise people:
   - ACH deposits are typically held **six business days** before they can be
     withdrawn again.
   - Withdrawals must return to the **same bank account** that funded it.
4. Generate API keys from the dashboard. **Paper and live keys are separate** —
   the paper environment is free, needs no funding, and is where you start.
5. Crypto is available in 49 states + DC but **not New York**.

Things to know that are not obvious:

- Alpaca has **no cash accounts**. Everything is a margin or limited-margin
  account. Under $2,000 equity you get 1x buying power and cannot short — but
  you *can* trade on unsettled funds, so there are no good-faith violations and
  no T+1 waiting. Two carve-outs: unsettled equity proceeds cannot buy crypto
  and cannot be withdrawn.
- The **pattern day trader rule was repealed** effective 4 June 2026 (SEC
  approval of FINRA Rule 4210 amendments, 14 April 2026). No 3-trades-per-5-days
  limit, no $25,000 threshold. Firms may phase in through October 2027, so
  verify on your own account rather than assuming.
- The **free market data tier gives real-time quotes from IEX only** — about
  2.5% of consolidated volume, and not the NBBO. Historical SIP data is free
  back to 2016 but capped at 15 minutes ago. This is why the equity desks here
  execute in the closing and opening auctions rather than reacting to live
  quotes: auction orders fill at the official print, which the free tier
  reports accurately.

### Kalshi (prediction markets)

1. Sign up at **kalshi.com**. It is a CFTC-regulated exchange (a Designated
   Contract Market), not an offshore book.
2. Minimum funding is **$10** by ACH, debit card, or the usual wallets;
   $1,000 by wire.
3. Generate an API key. Kalshi uses **RSA request signing** — you download a
   PEM private key and it gives you a key id. Keep the PEM file out of the
   repository.
4. State rules: sports contracts are blocked in several states and the map has
   moved repeatedly through 2026. Economics, weather, politics and crypto
   contracts are available essentially everywhere. **Re-check before funding.**

Kalshi's structural advantages for a small account are real: no PDT, no
settlement delay, contracts fractional to 0.01 (so the minimum order is about
a cent), and **maker orders are free on 98.7% of series**.

---

## 4. Wiring it up

Secrets go in the environment, never in the repository.

```bash
# Alpaca — start with PAPER keys
export APCA_API_KEY_ID=...
export APCA_API_SECRET_KEY=...

# Kalshi — read-only paths need no credentials at all
export KALSHI_API_KEY_ID=...
export KALSHI_PRIVATE_KEY_PATH=/secure/path/kalshi.pem
```

For the automated CI shifts, add the same names as **repository secrets** in
GitHub (Settings → Secrets and variables → Actions). The workflows detect them
and switch from paper-only to mirroring automatically.

Configure the account:

```bash
cd scripts
python3 -m desk.cli config --preset small --equity 500
python3 -m desk.cli status
```

---

## 5. The arming sequence

Do not skip steps. Each one exists because of a specific failure mode.

**Step 1 — paper, no venue at all.** The default. Simulated fills at real
quotes with the full cost model.

```bash
python3 -m desk.cli run
```

**Step 2 — paper, through the venue.** Same code path as live, but Alpaca's
paper endpoint. This is where you find out whether your orders are *accepted*:
order-type restrictions, fractional rules, MOC cutoffs. Run it for at least a
week.

```bash
python3 -m desk.cli run --live --i-accept-total-loss
```

Note `--live` here means "mirror to the venue", and `--venue-paper` is the
default. Real money needs an additional explicit flag.

**Step 3 — real money, smallest size that clears the floor.** Only after
step 2 has run clean for a week and you have compared the desk's book to the
broker's statement line by line.

```bash
python3 -m desk.cli run --live --i-accept-total-loss --real-money
```

Every one of these is required simultaneously: credentials in the environment,
`--live`, `--i-accept-total-loss`, `--real-money`, and the **absence** of
`data/desk/STOP`. Missing any one and no order can be produced.

---

## 6. Running it continuously

Two ways.

**GitHub Actions (no machine of your own).** The shift workflows self-chain in
~2-hour blocks. They run paper-only until the secrets exist.

```bash
# dispatch manually, or let the cron schedule start it
gh workflow run desk-shift.yml
```

**Locally / on a VPS.**

```bash
cd scripts
python3 -m desk.cli watch --minutes 600 --seconds 300
```

The `overnight` desk needs to act near the close (submit MOC before 15:50 ET)
and near the open. The `xsect` desk only acts on the last session of the month.
`trend` runs daily on a 24/7 market. A cycle every five minutes covers all of
them without hammering anything.

---

## 7. Kill switches

```bash
python3 -m desk.cli halt      # writes data/desk/STOP — nothing trades
python3 -m desk.cli resume    # removes it
```

The STOP file is checked before every cycle and mid-loop. Automatic halts also
exist and persist across restarts:

- **Daily loss halt** (default 4%): flattens and stops for the session.
- **Weekly loss halt** (10%).
- **Drawdown halt** (25% from peak equity): stops everything and survives a
  restart — it does not reset with a new session.
- **Turnover budget**: refuses trades once the trailing-year traded notional
  exceeds the allowance. This exists because the PDT repeal removed the
  external brake; at 5 round trips a day, spread alone consumes roughly 62% of
  a small account per year regardless of signal quality.

To liquidate everything immediately, use the broker's own interface — do not
rely on the bot to close positions when you are trying to stop it.

---

## 8. Daily operation

```bash
python3 -m desk.cli status        # config, allocations, positions, halts
python3 -m desk.cli validate      # re-run walk-forward (weekly is enough)
python3 -m desk.cli publish       # refresh the dashboard payload
```

The dashboard page is `dashboard/desk.html`, fed by `dashboard/data/desk.json`.

**Reconcile weekly.** Compare the desk's positions and cash against the
broker's statement. They should match to the cent. If they do not, stop and
find out why before trading again — a book that has silently diverged is worse
than no book. The two known sources of legitimate drift:

- Alpaca **crypto fees post at end of day**, not on fill, and are deducted
  from the asset you *received*. Intraday P&L will read optimistic by roughly
  25bps per taker fill.
- Dividends and corporate actions are not modelled by the desks.

---

## 9. Taxes

Automated trading generates a lot of transactions. Practical notes, not tax
advice:

- Alpaca issues a **1099-B** with cost basis. Kalshi event contracts are
  generally reported on a **1099-B** as well but the treatment of prediction
  contracts is less settled — ask a professional if the amounts matter.
- **Wash sales** apply to equities and ETFs: a loss is disallowed if you buy
  the same or a substantially identical security within 30 days either side.
  The `overnight` desk re-enters the same names daily, so realised losses will
  routinely be wash sales. This affects *when* losses are deductible, not
  whether. Crypto is currently not subject to the wash-sale rule.
- Keep `data/desk/journal.jsonl` and the state snapshots. They are your
  independent record if a broker's numbers are ever disputed.

---

## 10. What can go wrong

Ranked by how likely it is to cost you money.

1. **The strategy stops working.** Every edge here is a risk premium or a
   behavioural bias, not an arbitrage. They have all had multi-year periods of
   underperformance and will again. The drawdown limits exist for this; the
   walk-forward evidence is what tells you the size to expect.
2. **You size too large after a good month.** The allocator and position caps
   resist this. Do not override them because recent results were good.
3. **An overnight gap.** The `overnight` desk holds through exactly the window
   where gaps happen — that is the risk it is being paid for. The daily loss
   halt does not catch a gap, because a gap is not an intraday loss.
4. **A venue changes something.** Fee rates reset, order types get deprecated,
   Kalshi adds a price-level structure. The adapters read live fields where
   possible rather than hardcoding, but re-run `validate` after any venue
   announcement.
5. **A bug in this code.** It is tested and reviewed, but the honest statement
   is that no amount of either makes software safe to point at your money
   unsupervised. Start at the smallest size that clears the fee floor, and
   reconcile weekly.

---

## 11. Honest expectations at $500

Running the `small` preset with $500, using the validated out-of-sample
figures and assuming they hold:

- Expected return roughly **8–11% a year**, which is **$40–$55**.
- Expect a **20–30% drawdown** at some point. That is $100–$150 of paper loss,
  and it will feel much worse than the numbers suggest.
- Fees will cost about **$7.50/yr** on the daily desk and about $0.36/yr on the
  monthly one.

The value of running $500 is not the $45. It is proving the whole pipeline —
signal, sizing, execution, reconciliation, tax records — with real money at a
size where being wrong is affordable. Scale only after the book has matched the
broker for a few months.
