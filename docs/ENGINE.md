# Specialty-weighted consensus engine

A redesign of the copy-trading pipeline: domain-aware signal generation,
fractional-Kelly capital allocation, latency-bounded execution, and active
exit management.

Everything below that states a number was measured — against the 237-wallet
cohort in `data/analyzed.json`, or against live Polymarket and Polygon
mainnet on 2026-08-13. Where a fact could not be verified it is marked as
unverified rather than assumed.

---

## 1. Architecture

```
                    ┌──────────────────────────────────────────┐
   Polygon logs ───▶│ INGESTION            pmx/feed.py         │
   (0–2 s)          │  OnChainFeed   eth_getLogs OrderFilled   │
                    │  DataApiFeed   /activity per wallet      │
   /activity ──────▶│  DualFeed      dedupe → Fill events      │
   (4–14 s)         │  TokenMap      tokenId → market identity │
                    └───────────────────┬──────────────────────┘
                                        │ Fill
                    ┌───────────────────▼──────────────────────┐
   edge_profiles ──▶│ SIGNAL SCORING   pmx/consensus.py        │
   (pmx/profiles)   │  W_i  = (skill · scale · consistency)^⅓  │
                    │  v_i  = W_i · √(conv/2) · 2^(−age/τ)     │
                    │  Σ    = Σ v_i        N_eff = Σ²/Σv²      │
                    │  fire iff Σ ≥ Θ ∧ N_eff ≥ 2 ∧ dominance  │
                    └───────────────────┬──────────────────────┘
                                        │ Candidate
                    ┌───────────────────▼──────────────────────┐
   order book ─────▶│ SIZING           pmx/sizing.py           │
                    │  w   = calibrated logit shift (λ fitted) │
                    │  f*  = (w·b − (1−w))/b,  b from net cost │
                    │  stake = min(γf*B, 5%B, cluster, cash    │
                    │           reserve, depth, daily, $cap)   │
                    └───────────────────┬──────────────────────┘
                                        │ SizingDecision
                    ┌───────────────────▼──────────────────────┐
                    │ EXECUTION        pmx/execute.py          │
                    │  drift guard (absolute ∧ log-odds)       │
                    │  depth-walked fill, FOK at bounded limit │
                    │  fee-aware EV gate before dispatch       │
                    └───────────────────┬──────────────────────┘
                                        │ position
                    ┌───────────────────▼──────────────────────┐
                    │ EXIT MANAGEMENT  pmx/exits.py            │
                    │  capital-efficiency take-profit          │
                    │  weighted consensus reversal             │
                    │  log-odds stop, max-hold rail            │
                    │  maker-first limit sells (zero fee)      │
                    └──────────────────────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `pmx/config.py` | Every tunable, with validation that refuses unsafe combinations |
| `pmx/profiles.py` | Per-wallet, per-category settled record; wash/MM exclusion |
| `pmx/consensus.py` | Vote weights, consensus score, effective backers, drift guard |
| `pmx/calibrate.py` | Fits λ mapping consensus → probability; refuses overfits |
| `pmx/sizing.py` | Fee-aware fractional Kelly under every exposure rail |
| `pmx/fees.py` | Published fee curve and per-category taker rates |
| `pmx/book.py` | Order book normalization, depth walking, tick rounding |
| `pmx/execute.py` | Bounded-slippage entries, maker-first exits |
| `pmx/exits.py` | Take-profit, reversal, stop, time rails |
| `pmx/feed.py` | Dual feed and market identity resolution |
| `pmx/engine.py` | Stage orchestration |
| `pmx/cli.py` | `preflight` · `scan` · `watch` · `explain` |

---

## 2. Mathematical formulation

### 2.1 Vote weight `W_i`

The requested form is

$$W_i = \text{WinRate}_{\text{cat}} \times \log_{10}(\text{PnL}_{90d}) \times \text{Sharpe}$$

It is implemented as `weights.mode = "raw"`. It is **not** the default,
because measured against this cohort it fails three ways:

| Failure | Measurement on `data/analyzed.json` |
|---|---|
| `log₁₀(PnL)` undefined or negative | **77 of 235** wallets have 90-day PnL ≤ 0; the 25th percentile is exactly $0 |
| Negative Sharpe flips a vote's sign | **47 of 192** wallets have negative Sharpe — their buys would count as sells |
| Unbounded product lets one wallet outvote a room | `log₁₀(PnL)` spans **0.00 → 7.24**; Sharpe spans **−8.21 → 28.29** |

The default `robust` mode keeps the multiplicative intent — a wallet must be
good on *all three* axes, not merely enormous on one — using a geometric mean
of three terms each bounded to [0, 1]:

$$W_i = \bigl(q_{i,c} \cdot s_i \cdot k_i\bigr)^{1/3} \in [0,1]$$

**Category skill** $q_{i,c}$ blends price-adjusted ROI with win-rate lift,
both shrunk toward the cohort's base rate for that category:

$$\hat{q} = \frac{w_{i,c} + \kappa\bar{q}_c}{n_{i,c} + \kappa}, \qquad
q_{i,c} = \beta\,\mathrm{clamp}\!\left(\frac{\hat{r}}{r_{\text{ref}}}\right) + (1-\beta)\,\mathrm{clamp}\!\left(\frac{\hat{q}-\bar{q}_c}{1-\bar{q}_c}\right)$$

ROI carries most of the blend ($\beta = 0.65$) because win rate alone is not
skill: buying 92¢ favorites wins ~92% of the time and earns nothing after
fees. The cohort contains 24 "Favorite grinder" wallets that would score
highly on raw win rate.

**Scale** $s_i$ replaces the unbounded logarithm with a saturating one:

$$s_i = \mathrm{clamp}\!\left(\frac{\log_{10}\max(\text{PnL},\,P_{\min}) - \log_{10}P_{\min}}{\log_{10}P_{\text{ref}} - \log_{10}P_{\min}},\,0,\,1\right)$$

with $P_{\min} = \$25\text{k}$, $P_{\text{ref}} = \$1\text{M}$. A $17M whale
and a $1M trader receive identical scale credit — size stops buying votes.

**Consistency** $k_i$ shrinks Sharpe by sample size and clamps it, never
below zero:

$$k_i = \mathrm{clamp}\!\left(\frac{\text{Sh}_i \cdot \frac{n}{n+n_0}}{\text{Sh}_{\text{ref}}},\,0,\,1\right)$$

$\text{Sh}_{\text{ref}} = 3$, $n_0 = 30$ days. The cohort's Sharpe is computed
on a mark-to-market series and is badly inflated — median 2.27, p95 13.45 —
so the level is not trusted, only the ordering.

### 2.2 Consensus score

$$v_i = W_i \cdot \sqrt{\tfrac{\min(\text{conv}_i,\,10)}{2}} \cdot 2^{-\Delta t_i/\tau}, \qquad
\Sigma = \sum_i v_i$$

$$N_{\text{eff}} = \frac{\left(\sum_i v_i\right)^2}{\sum_i v_i^2}$$

A signal fires only when **all** of:

$$\Sigma \ge \Theta \;\wedge\; N_{\text{eff}} \ge 2 \;\wedge\; k \ge 2 \;\wedge\; \Sigma \ge 1.5\,\Sigma_{\text{opposing}}$$

$N_{\text{eff}}$ is the inverse Herfindahl of the vote and is the rail that
makes "consensus" mean consensus. Three equal backers give 3.00; one whale
of weight 10 beside two minnows of 0.1 gives **1.04** and is refused, even
though its Σ of 10.2 clears any threshold. This is the property the flat
3-backer rule was reaching for, expressed correctly.

### 2.3 Consensus → probability (the part that must be fitted)

Σ is a score in arbitrary units, not a probability. Kelly scales linearly in
the claimed edge, so inventing $w$ is the most expensive error available.
The engine defines it as a one-parameter correction to the market price in
log-odds:

$$\operatorname{logit}(w) = \operatorname{logit}(p) + \lambda\,(\Sigma - \Theta), \qquad |w-p| \le 0.10$$

$\lambda$ is fitted by `pmx/calibrate.py` — single-parameter logistic
regression with $\operatorname{logit}(p)$ as a fixed offset, L2 prior chosen
by walk-forward CV, accepted only if the paired improvement over "trust the
book" clears **t ≥ 2** out of sample.

**Until λ is fitted, λ = 0, so w = p, so Kelly sizes nothing** and every
stake falls back to the flat minimum. This is deliberate.

Measured detection power of that gate (8 seeds per cell):

| true λ | n = 300 | n = 600 | n = 1500 | n = 3000 |
|---|---|---|---|---|
| 0.00 (no edge) | 0/8 | 0/8 | 0/8 | 0/8 |
| 0.10 | 0/8 | 1/8 | 0/8 | 1/8 |
| 0.15 | 0/8 | 1/8 | 2/8 | 4/8 |
| 0.40 (strong) | 1/8 | 7/8 | 8/8 | 8/8 |

Zero false positives at every sample size. **A strong edge needs ~600
settled signals to confirm; a weak one needs ~3,000.** At the current signal
rate that is the real timeline before Kelly can legitimately be switched on.

### 2.4 Fractional Kelly

$$b = \frac{(1-\phi_{\text{exit}}) - c}{c}, \qquad
f^{*} = \frac{w\,b - (1-w)}{b}, \qquad
f = \gamma f^{*} \cdot \frac{1}{1+\rho(n_{\text{cluster}})}$$

where $c$ is the depth-walked fill plus entry fee. With zero costs this
reduces **exactly** to the specified $f^{*} = (w-p)/(1-p)$ — asserted in
`tests/test_pmx.py`. With costs it does not: at a 90¢ entry with a 2¢ round
trip the naive form claims $f^*=0.500$ against a true $0.381$, a **31%
oversize** on precisely the favorite trades this strategy takes most.

Final stake is the minimum of every rail, and the binding one is recorded:

$$\text{stake} = \min\bigl(\gamma f^{*}B,\; 0.05B,\; \text{cluster},\; \text{category},\; C - 0.20B,\; \text{daily},\; 0.25\,\text{depth},\; \$4\bigr)$$

Bankroll $B$ is cash **plus** marked open positions; sizing off cash alone
shrinks every bet as the book fills.

### 2.5 Net EV gate

$$EV_{\text{net}} = w - P_{\text{fill}} - \text{fee}, \qquad
\text{fee} = \text{rate}_{\text{cat}} \cdot p\,(1-p)$$

Slippage is inside $P_{\text{fill}}$ because it is depth-walked, not assumed.
Orders with $EV_{\text{net}} \le 0$ are refused before dispatch.

### 2.6 Drift guardrail

$$\text{reject if } (P_{\text{now}} - P_{\text{entry}}) > 0.03 \;\vee\; \bigl(\operatorname{logit}P_{\text{now}} - \operatorname{logit}P_{\text{entry}}\bigr) > 0.20$$

The absolute rule is as specified. The log-odds rule is what makes it correct
across the price range: 3¢ is a 60% relative move at a nickel and a 3% move
at 90¢, so an absolute-only rule waves through exactly the cheap-outcome
chases that hurt most. $P_{\text{entry}}$ is weighted by each backer's vote,
not averaged flat.

### 2.7 Exits

Capture fraction and hold return:

$$\text{captured} = \frac{p - e}{1 - e}, \qquad
R_{\text{ann}} = \left(\tfrac{1}{p}\right)^{365/T} - 1$$

Sell when `p ≥ 0.96` (hard), **or** when captured ≥ 70% *and*
$R_{\text{ann}} <$ hurdle. The second clause is what a flat "sell at 96¢"
rule gets wrong: a 96¢ position resolving tomorrow annualizes at thousands
of percent and should be held; the same position 120 days out annualizes at
21% and should be sold. Buying "No" at 80¢ and selling at 96¢ captures
exactly 80% of maximum gain, as specified.

Consensus reversal is weighted, not counted:

$$\text{exit if } \#\{\text{reversed}\} \ge 2 \;\wedge\; \frac{\sum_{i \in \text{reversed}} v_i}{\Sigma_{\text{open}}} \ge 0.5$$

with a wallet counting as reversed only if its net stance crosses zero or
falls by ≥50%. Two minnows leaving is not the consensus reversing; a whale
trimming 20% into a rally is taking profit, not changing its mind.

---

## 3. What was measured against the live venue

Each of these silently produces a catastrophic answer if handled from stale
documentation.

### 3.1 Feed latency — the dominant finding

| Source | Lag behind block time |
|---|---|
| `data-api /trades` (global) | **260 s** |
| `data-api /activity?user=` | **4–14 s** |
| Polygon `eth_getLogs` | **0–2 s** (one block) |

The timestamps `/trades` returns are correct — they match block time to the
second — but the endpoint serves a cached window minutes old and **does not
advance between rapid polls**: three polls two seconds apart returned
identical rows ageing 224.9 s → 227.0 s → 229.1 s.

`scripts/watch.py` polls this endpoint every 30–45 s and the README describes
it as reacting "within about a minute". It is structurally **~4 minutes
behind** before any consensus logic runs. Given this repo's own backtest —
−1.9% at 1 h of copy delay, −26.2% at 3 h — detection lag is the single
largest controllable cost in the strategy, and this is where it comes from.

### 3.2 The exchange contract moved

| Address | OrderFilled logs, 10-minute sample |
|---|---|
| `0x4bFb41d5…` (in most published guides) | **32** |
| `0xE111180000d2663C0091e4f400237545B87B996B` | **29,138** |
| `0xe2222d279d744050d28e00520010520000310F59` (Neg Risk) | **6,051** |

The current event is

```
OrderFilled(bytes32 indexed orderHash, address indexed maker,
            address indexed taker, uint8 side, uint256 tokenId,
            uint256 makerAmountFilled, uint256 takerAmountFilled,
            uint256 fee, bytes32 builder, bytes32 metadata)
topic0 = 0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee
```

confirmed as the dominant topic on both live exchanges. The older
8-parameter form hashes to a topic that no longer appears. An engine built
from the older docs sees nothing and reports no error.

**`maker` is the wallet.** Sampling live logs and resolving each maker
against the data API returned a matching Polymarket account for **6 of 6**,
with prices matching seconds apart. Both sides of a match emit their own
`OrderFilled` (the counterparty shows the exchange itself as `taker`), so
indexing on `maker` alone catches a tracked wallet whether it took or made.

### 3.3 The CLOB user WebSocket cannot watch other wallets

> "The user stream delivers order changes and trade updates for the
> authenticated account."

It shows your own fills and nobody else's. Reading the chain is the only
sub-second path to somebody else's flow.

### 3.4 Order book arrays run worst-price-first

```
bids[0]  = 0.001 @ 2,069,778      bids[-1] = 0.230 @ 2,925
asks[0]  = 0.999 @ 3,016,566      asks[-1] = 0.231 @ 2,447
```

Bids ascend, **asks descend**. Reading `asks[0]` as the best ask returns
0.999 on a market trading at 0.231 — an **82.8¢ error** that makes any depth
check pass and any market order a donation. `/price?side=BUY` returns the
best *bid* and `side=SELL` the best *ask*: the endpoint names the side of the
resting order it reads, not the side you take.

### 3.5 Fees

$$\text{fee} = C \cdot \text{rate} \cdot p \cdot (1-p)$$

— the curve is $p(1-p)$, **not** $\min(p, 1-p)$; at 50¢ those differ by a
factor of two. Makers are never charged. Published taker rates: Crypto 0.07,
Sports/Economics/Culture/Weather 0.05, Politics/Finance/Mentions/Tech 0.04,
Geopolitics 0.

Round-trip taker cost as a share of notional:

| price | Sports | Crypto | Politics |
|---|---|---|---|
| 0.05 | 13.75% | 19.25% | 11.00% |
| 0.25 | 7.95% | 11.13% | 6.36% |
| 0.50 | 4.98% | 6.97% | 3.98% |
| 0.90 | 0.76% | 1.07% | 0.61% |

Cheap outcomes are brutally expensive to trade, which justifies the price
floor. Because only takers pay, a resting limit sell for a take-profit costs
nothing — `execute.py` posts exits passively and crosses only when urgent.

> **Unverified:** the CLOB `/markets` endpoint returns integer
> `maker_base_fee` / `taker_base_fee` fields (1000 on 924 of 1000 live
> markets, 0 on the rest) whose denomination is not documented in any primary
> source found. They are logged but **not** used in arithmetic. If you can
> confirm their units, set `execution.fallback_fee_bps` explicitly.

### 3.6 `outcomeIndex` is sometimes a sentinel

The global `/trades` feed returns `outcomeIndex: 999` — a placeholder, not an
index. Frequency is bursty: two samples minutes apart measured **54%** and
**2.8%** of rows, the high one dominated by 5-minute BTC up/down markets.
Consumed as an index it buckets flow under an outcome that does not exist and
every downstream price lookup fails `index < len(prices)`, dropping the
signal silently. The per-wallet `/activity` endpoint returned **0 of 1,800**
rows affected. `resolve_outcome_index()` repairs it from the outcome name.

### 3.7 Gamma omits closed markets unless asked

`/markets?condition_ids=<id>` returns **0 rows** for a settled market and 1
row with `closed=true` added. Since settled markets are the only ones
carrying a result, a single-pass prefetch caches thousands of useless open
markets and none of the evidence. `prefetch_markets()` does both passes.

---

## 3a. What the engine actually does on live data

Built against 40 of the 75 eligible wallets — **13,728 settled round trips**
across 10 categories — then run over a 24-hour live window (28,690 fills,
45 active wallets, 340 markets with weighted backing).

### Win rate is not skill, measured

The cohort's own settled record, which is why the skill term is ROI-weighted:

| category | settled | win rate | ROI |
|---|---|---|---|
| Weather | 1,049 | **89.1%** | **−0.4%** |
| Economics | 164 | 72.6% | +25.8% |
| Politics | 510 | 64.1% | +11.9% |
| Sports | 8,843 | **51.8%** | **+29.8%** |
| Esports | 2,711 | 49.0% | +2.5% |

Weather specialists won 89% of a thousand settled bets and still lost money;
Sports specialists won a coin flip and made 30%. A win-rate-only weight ranks
these in exactly the wrong order. (The ROI levels are inflated by
survivorship — this cohort is leaderboard-seeded and then filtered to
profitable wallets — so they are a reference for *lift within the pool*, not
a market-wide base rate.)

The resulting weights are well-spread and bounded: 31 (wallet, category)
voting rights, `W_i` from 0.123 to 0.903, median 0.623. `Mysaria` in Weather
receives the lowest weight in the cohort. `dv-pm` holds a 0.68 skill score in
Esports and gets **no vote there** — 0.02% of its volume, below the specialty
gate.

### Θ was calibrated against that sample, not guessed

Σ peaked at 1.71 over the window (p90 = 1.04, median = 0.27). At the initial
Θ = 1.35 the engine fired **once** in 24 h; at Θ = 0.80 it fires about three
times, which is the rate that reaches ~600 settled observations inside a year
rather than a decade. Below 0.80 nothing changes — `min_effective_backers`
becomes the binding rail, and only **3 of 341** markets reached N_eff ≥ 2.

### The finding that matters most for how you run it

Of the 22 markets that drew two or more specialist backers in the window,
**20 had already closed.** The sharps' consensus concentrates in same-day
tennis and football matches that resolve within hours of the flow that
signals them.

Shortening the vote window does not fix this — measured across window
lengths, the count of *still-open* multi-backer markets never exceeded 2:

| max vote age | half-life | candidates | multi-backer | still open |
|---|---|---|---|---|
| 48 h | 6 h | 338 | 22 | 2 |
| 12 h | 4 h | 219 | 6 | 1 |
| 6 h | 3 h | 131 | 1 | 1 |
| 2 h | 1.5 h | 78 | 0 | 0 |

The conclusion is not that the consensus rule is too strict. It is that **a
backward-looking scan is the wrong instrument**: it looks back at markets
that are already resolved. In `watch` mode the signal fires the moment the
second backer's fill lands, while the match is still running. That is the
entire argument for sub-second detection, and §3.1 is why the old polling
path could not deliver it.

Use `scan` to inspect and tune. Use `watch` to trade.

### Widening the voter pool

Only 31 voting rights exist today, which is why overlap is rare. The gates
trade off against evidence quality:

| `min_category_trades` | `specialty_min_share` | voting rights | wallets |
|---|---|---|---|
| 10 | 0.35 (default) | 31 | 29 |
| 10 | 0.10 | 51 | 30 |
| 5 | 0.20 | 43 | 34 |
| 3 | 0.10 | 57 | 35 |

The right lever is **not** loosening these — it is profiling more wallets.
Profiles here cover 40 of 75 eligible; running
`python3 -m pmx.profiles --fetch --max-wallets 75` adds voters without
lowering the evidentiary bar.

---

## 4. A constraint conflict in the requested rails

The specified rails are individually reasonable and jointly unsatisfiable at
the configured bankroll:

- max position **5% of bankroll**
- exchange minimum **5 shares** (confirmed live: `minimum_order_size: 5`)

Together they require $5 \cdot p \le 0.05B$, i.e.

$$B \ge 100p$$

**$56 to buy a 56¢ outcome, $90 to buy a 90¢ one.** At the current $40
bankroll the engine can only size positions priced under **$0.40**, and every
signal above that is rejected as under-minimum — silently, forever, unless
something says so. `ConsensusEngine.preflight()` says so at startup.

Three ways out, in order of preference:

1. Raise the bankroll to ≥ $90 (covers the whole 5–90¢ band).
2. Lower `execution.max_price` to the computed ceiling and accept a
   cheap-outcome-only book — noting §3.5, where fees are worst.
3. Raise `max_position_frac` and accept the concentration.

---

## 5. Running it

```bash
# 1. Per-category settled record for the watchlist (needs network)
python3 -m pmx.profiles --fetch --max-wallets 40
#    or, from a full local cohort dump:  python3 -m pmx.profiles
#    or, metadata only (no wallet may vote): python3 -m pmx.profiles --degraded

# 2. Check the rails before anything trades
python3 -m pmx.cli preflight

# 3. One-shot: detect → score → size → plan (dry run, no keys needed)
python3 -m pmx.cli scan --hours 24

# 4. Continuous, with sub-second on-chain detection
python3 -m pmx.cli watch --minutes 60 --rpc https://polygon-bor-rpc.publicnode.com

# 5. Why does this wallet's vote weigh what it does?
python3 -m pmx.cli explain 0x03805a13a0b3e058f55f6c6af95389d4f431073d

# 6. Close the calibration loop: turn resolved signals into observations.
#    Run this on a schedule. Without it observations never accumulate, lambda
#    is never fitted, and the engine stays on bootstrap stakes forever.
python3 -m pmx.cli settle

# 7. Once ~600 signals have settled
python3 -m pmx.calibrate

# Tests
python3 -m unittest discover -s scripts/tests -v
```

Arming real orders requires, simultaneously: `PM_PRIVATE_KEY`,
`PM_PROXY_ADDRESS`, `PM_SIGNATURE_TYPE`, `PMX_ARMED=yes-i-accept-total-loss`,
both CLI flags, and no `data/live/STOP` file. `dry_run=True` is the default
everywhere.

---

## 6. Honest limitations

- **No live edge is demonstrated here.** This redesign fixes measurable
  defects — detection lag, an unbounded weight function, uncosted Kelly, a
  dead contract address. Whether the underlying signal is profitable after
  fees remains exactly as unproven as before, and §2.3 is the machinery for
  answering that question rather than assuming it.
- **λ = 0 until fitted.** The engine ships unable to size on conviction, by
  design. Until then it stakes the *smallest legal position* — enough to
  generate the settled observations calibration needs, capped at
  `min_stake_usd` or the 5-share exchange minimum, whichever binds. Sizing
  Kelly off an unfitted λ would be worse; refusing to trade at all would
  deadlock the loop that produces the data.
- **Signal rate is low and that is the honest finding.** Three signals in a
  24-hour window cleared every rail, and only one had a still-open market.
  Reaching the ~600 settled observations Kelly needs is a matter of months,
  not days. Anyone impatient with that is choosing to size on noise.
- **The wash filter changes nothing today.** It flags 5 wallets
  (`cc9999` at a 1,686× volume-to-PnL ratio, `-Malfunction`, `Sharky6999`,
  `asd147`, `Anjun`), but all 5 already fall below the $100k PnL floor, so
  the current 60-wallet watchlist is unchanged. It matters if you lower the
  floor or rank by volume.
- **Category evidence depends on resolved history.** Wallets trading markets
  that have not settled inside the 90-day window carry no record and cannot
  vote, which biases the watchlist toward short-horizon markets.
- **Sharpe is computed on a mark-to-market series** and is inflated and
  autocorrelated. It is used as an ordering, shrunk and clamped, never as a
  level.
- **The `p(1−p)` fee curve and category rates are transcribed from published
  documentation**, not observed in settlement. Fee fields on the CLOB
  `/markets` endpoint remain of unknown denomination (§3.5).
