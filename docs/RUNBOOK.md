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

Two costs were measured, and together they decide what an account can run.

**The fee floor.** On the overnight desk over ten years, charged in full:

| Starting capital | After 10 years | CAGR | Fees as % of capital/yr |
|---|---|---|---|
| $40 | **$0.00** | — | 14.4% |
| $250 | $513 | 7.9% | 2.7% |
| $1,000 | $2,382 | 9.6% | 0.8% |

A $40 account running a daily equity strategy does not underperform. It
goes to zero on fees while the strategy itself is fine.

**Execution.** That table assumed fractional shares filling at the auction
print — which Alpaca does not offer. Auction orders (market-on-close /
market-on-open) must be whole shares, and the overnight desk does not work
any other way (crossing the spread instead: walk-forward **-1.0% a year**).
Whole shares of $107–$766 ETFs re-set the floor:

| Equity | Overnight desk, whole-share auction | Walk-forward |
|---|---|---|
| $500 | 1.1% CAGR, holds 1.5 names | — |
| $1,000 | 5.5% CAGR | not significant (p 0.17) |
| **$2,000** | 7.9% CAGR, 3.4 names | **validated, Sharpe 0.75** |
| $5,000 | 8.6% CAGR | validated, Sharpe 0.79 |

**What this means for you:**

| Capital | What runs (`preset`) | Why |
|---|---|---|
| Under $100 | Nothing validated | Equity desks need $100+ (monthly) or $2,000+ (daily); the Kalshi study found no edge. Paper-trade and save. |
| $100–$2,000 | `trend` (`micro`/`small`) | Crypto trend on BTC/ETH (validated, floor $100). Monthly ETF momentum (`xsect`) is listed in these presets but marginal — off until you name it in `config.json`. No shorting under $2,000. |
| $2,000+ | + `overnight` (`standard`) | Whole-share auction sizing now holds enough names to work. Account leaves limited-margin status. |
| $25,000+ | same, tighter caps (`scaled`) | Frictions are noise; caps tighten rather than loosen. |

The `reversion` desk is registered but in no preset (see §2). The
`kalshi-bias` desk is registered and rejected. A marginal desk funds only
when it appears in the `desks` list of `data/desk/config.json`; a preset
listing it is not enough.

Check your own numbers before funding anything:

```bash
cd scripts
python3 -m desk.cli --equity 500 costs
```

---

## 2. What is actually validated, and what is not

Nothing trades until it passes walk-forward testing on data it never saw
during fitting, with every cost charged. Current verdicts:

| Desk | Out-of-sample (fixed params, costs charged) | Benchmark | Verdict | Floor |
|---|---|---|---|---|
| `overnight` — hold US ETFs only overnight, whole-share MOC/MOO | Sharpe 0.75, CAGR 6.0%, maxDD -17% (at $2,000) | SPY 0.92 / 20% / -36% | validated | $2,000 |
| `trend` — BTC/ETH above a moving average, vol-scaled | Sharpe 1.13, CAGR 31.7%, maxDD -28% | BTC 0.87 / 35.7% / -53% | validated | $100 |
| `xsect` — monthly ETF momentum, fractional, crossing | Sharpe 0.50, CAGR 8.5%, maxDD -33% on 5 folds at $100 (p 0.16); 0.63 / p 0.087 on 4 folds | equal-weight universe 0.75 / 11.1% / -32% | **marginal**, opt-in | $100 |
| `reversion` — 3 down closes, 5-day hold | Sharpe 0.75, CAGR 10.5% — but not significant in 2016-21, strong only in 2021-26 | SPY 0.79 / 13.4% | **marginal**, opt-in | $500 |
| `kalshi-bias` — buy favorites, hold to settlement | 487 tight-quoted settled markets: favorites +0.9% to +6.6% of stake net, t 0.5–1.25 | — | **rejected** | — |

Read those honestly. **Neither `overnight` nor `trend` beats buy-and-hold on
absolute return.** Both earn a better risk-adjusted return with roughly half
the drawdown. If you want maximum return and can tolerate a 53% drawdown,
buy and hold bitcoin. If you want a smoother path, that is what these buy.

`xsect` is marginal for a specific reason: its significance depends on how
the walk-forward is cut (four folds pass, five do not), and on the five-fold
run the dashboard publishes it earns a worse risk-adjusted return than
simply holding its own seventeen ETFs equal-weighted. The momentum effect
it exploits is among the best-documented in finance; ten years of ETF price
data cannot confirm it here. It is replayed every Monday, and its status
changes only if the five-fold record clears the significance bar every desk
is held to (p at or under 0.10) and beats that equal-weight benchmark.

Tested and found dead — do not let anyone sell you these:

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
- **Kalshi favorite-longshot bias**: directionally present at the favorite
  end after fees, but on 21–29 markets per bucket it is indistinguishable
  from a fair price. The desk ships with that finding encoded as a gate
  that returns nothing; the settled set grows monthly and the question can
  be re-asked with `python3 -m desk.cli backtest kalshi-bias`.

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
broker's statement line by line. First record the decision in the config
file, which is committed, so it is in the repository's history:

```bash
python3 -m desk.cli config --set-live true
git add data/desk/config.json && git commit -m "permit real money"
python3 -m desk.cli run --live --i-accept-total-loss --real-money
```

Every one of these is required simultaneously: credentials in the environment,
`"live": true` in `data/desk/config.json`, `--live`, `--i-accept-total-loss`,
`--real-money`, and the **absence** of `data/desk/STOP`. Missing any one and
no real-money order can be produced. The paper endpoint needs only the two
flags and credentials.

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

The runner reads the venue's clock and only acts in the windows the desks
need: **09:00–09:26 ET** for market-on-open orders (exchange cutoff 09:28)
and **15:30–15:48 ET** for market-on-close (cutoff 15:50). Outside those
windows equity desks hold whatever they have; nothing is flattened because
a cycle happened to run at noon. Crypto trades on any cycle. A cycle every
five minutes covers everything without hammering anything.

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

## 11. Honest expectations

**At $500** (`small`), using the validated out-of-sample figures and
assuming they hold:

- trend is the only desk funded by default. Its cap is half the account,
  so $250 works and $250 sits in cash. Crypto trend has earned 30%+ a year
  in this sample and will also sit flat for months: call it $0–$75.
- If you opt into xsect by naming it in `config.json`, its other half of
  the account has earned 9% a year out of sample (about $22) — but read §2
  first: that record is not significant on five folds and trails an
  equal-weight hold of the same ETFs.
- Expect a **25–35% drawdown** on whatever is funded at some point.
- Fees: about 0.5% on trend's turnover; under $1 a year on xsect (it
  trades about ten days a year).

**At $2,000** (`standard`: + overnight), add roughly 6–8% a year on the
overnight sleeve with a -17% to -19% drawdown, and about $7.50/yr of fee
floor from its daily activity.

The value of running small is not the dollars. It is proving the whole
pipeline — signal, sizing, execution, reconciliation, tax records — with
real money at a size where being wrong is affordable. Scale only after the
book has matched the broker for a few months.
