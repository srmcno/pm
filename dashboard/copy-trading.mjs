import {
  $,
  esc,
  money,
  compact,
  pct,
  when,
  badge,
  stat,
  empty,
  table,
  reportLink,
  inspect,
  curve,
  downloadCsv,
} from "./trading-ui.mjs";
import { fetchWalletActivity } from "./copy-core.mjs";
let data,
  study,
  tab = "wallets",
  limit = 20,
  selectedWallet,
  activityRequest = 0;
const saved = new Set();
try {
  const values = JSON.parse(localStorage.getItem("mm-copy-wallets") || "[]");
  if (Array.isArray(values))
    for (const v of values) if (/^0x[0-9a-f]{40}$/i.test(v)) saved.add(v);
} catch {}
const fraction = (v) => pct(Number.isFinite(v) ? v * 100 : NaN);
const category = (w) =>
  Object.entries(w.categoryVol || {}).sort((a, b) => b[1] - a[1])[0]?.[0] ||
  "Other";
const pin = (w) =>
  `<button class="save-wallet" data-save-wallet="${esc(w.wallet)}" aria-pressed="${saved.has(w.wallet)}" aria-label="${saved.has(w.wallet) ? "Unsave" : "Save"} ${esc(w.name)}">${saved.has(w.wallet) ? "★" : "☆"}</button>`;
function wallets() {
  if (!data) return;
  const query = $("wallet-search").value.toLowerCase().trim(),
    scope = $("wallet-scope").value,
    cat = $("wallet-category").value;
  const rows = data.analytics.wallets.filter(
    (w) =>
      (scope === "all" ||
        (scope === "tracked" && w.tracked) ||
        (scope === "saved" && saved.has(w.wallet))) &&
      (cat === "all" || category(w) === cat) &&
      (!query ||
        `${w.name} ${w.wallet} ${w.archetype}`.toLowerCase().includes(query)),
  );
  const key = $("wallet-sort").value;
  rows.sort(
    (a, b) =>
      (Number.isFinite(b[key]) ? b[key] : -Infinity) -
      (Number.isFinite(a[key]) ? a[key] : -Infinity),
  );
  $("wallet-count").textContent =
    `${rows.length} wallets · 90-day record through ${when(data.analytics.observedAt)}`;
  $("wallet-list").innerHTML = rows.length
    ? table(
        [
          "Wallet / specialty",
          "Research score",
          "90-day P&L",
          "Drawdown",
          "Cohort",
          "Save",
        ],
        rows
          .slice(0, limit)
          .map((w) => [
            `<button class="wallet-name" data-wallet="${esc(w.wallet)}"><span class="wallet-avatar">${esc(w.name.slice(0, 2))}</span><span>${esc(w.name)}<small>${esc(category(w))} · ${compact(w.distinctMarkets)} markets</small></span></button>`,
            `<strong>${Number.isFinite(w.researchScore) ? w.researchScore.toFixed(1) : "—"}</strong><small class="cell-note">${w.eligible ? "Passes research gates" : "Outside study rules"}</small>`,
            `<strong class="${w.pnl90 >= 0 ? "positive" : "negative"}">${money(w.pnl90)}</strong>`,
            money(w.maxDrawdown90),
            badge(
              w.truncated
                ? "Incomplete history"
                : w.tracked
                  ? "Forward cohort"
                  : "Outside cohort",
              w.truncated ? "caution" : "",
            ),
            pin(w),
          ]),
      )
    : empty(
        scope === "saved" ? "No saved wallets yet" : "No wallets match",
        "Save a wallet with the star, or change the search and filters.",
      );
  $("wallet-more").hidden = rows.length <= limit;
}
function showWallet(address) {
  const w = data?.analytics.wallets.find((w) => w.wallet === address);
  if (!w) return;
  selectedWallet = address;
  activityRequest++;
  inspect(
    "Copy trading · Wallet profile",
    `<div class="wallet-profile-heading"><div><h2>${esc(w.name)}</h2><p class="muted">${esc(w.archetype)} · ${esc(category(w))}</p></div>${pin(w)}</div><p class="wallet-address">${esc(w.wallet)}</p><div class="trade-summary">${stat("90-day P&L", money(w.pnl90))}${stat("Profitable days", fraction(w.winDayRate))}${stat("Peak-to-trough loss", money(w.maxDrawdown90))}</div>${walletScore(w)}${curve(w.history, "Historical cumulative wallet P&L")}<p class="table-note">Analytics observed ${when(data.analytics.observedAt)}. Profitable days count days with a P&L change greater than $1, not winning trades. ${w.truncated ? "This wallet’s trade history is incomplete." : ""}</p><div class="rule-grid"><p><strong>${compact(w.trades90)} recorded trades</strong>${compact(w.activeDays)} active days; ${money(w.medianTradeUsd)} median trade.</p><p><strong>${fraction(w.top5EventShare)} in five events</strong>Share of traded volume concentrated in the wallet’s five largest events.</p></div><details class="disclosure"><summary>Category mix and largest recorded positions</summary>${table(
      ["Category", "Traded volume"],
      Object.entries(w.categoryVol || {}).map(([k, v]) => [esc(k), money(v)]),
    )}${table(
      ["Position", "Outcome", "Recorded value", "Position P&L"],
      (w.topPositions || []).map((p) => [
        esc(p.title),
        esc(p.outcome),
        money(p.value),
        money(p.cashPnl),
      ]),
    )}${table(
      ["Largest recorded events", "Traded volume"],
      (w.topEvents || []).map((e) => [esc(e.title), money(e.vol)]),
    )}<p class="table-note">Positions and events belong to this wallet’s dated analytics snapshot.</p></details><div class="section-heading"><h3>Recent public activity</h3><button class="quiet-button" id="wallet-activity">Check recent trades</button></div><div id="wallet-activity-results"><p class="table-note">Read the latest 50 public trades for this Polymarket international wallet. This does not copy or submit orders.</p></div><p class="table-note"><a href="https://polymarket.com/profile/${esc(w.wallet)}" target="_blank" rel="noopener noreferrer">View wallet on Polymarket</a></p>`,
  );
}
async function activity() {
  const wallet = selectedWallet,
    id = ++activityRequest,
    button = $("wallet-activity");
  const host = $("wallet-activity-results");
  if (!wallet || !button || !host) return;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const response = await fetchWalletActivity(wallet);
    if (
      id !== activityRequest ||
      selectedWallet !== wallet ||
      !host.isConnected
    )
      return;
    host.innerHTML =
      `<p class="table-note">Public read ${when(response.receivedAt)}. ${response.rows.length} recent trades; ${response.omitted} invalid rows omitted. This is a bounded activity sample.</p>` +
      (response.rows.length
        ? table(
            ["Observed", "Market / outcome", "Side", "Price", "Amount"],
            response.rows.map((t) => [
              when(t.at),
              `${esc(t.title)}<small class="cell-note">${esc(t.outcome)}</small>`,
              esc(t.side),
              fraction(t.price),
              money(t.amount),
            ]),
          )
        : empty(
            "No recent trades returned",
            "The public endpoint returned no usable activity in this sample.",
          ));
  } catch (e) {
    if (id === activityRequest && host.isConnected)
      host.innerHTML = `<p class="notice">${esc(e.message)}. The saved wallet research is still available. Try again.</p>`;
  } finally {
    if (id === activityRequest && $("wallet-activity")) {
      $("wallet-activity").disabled = false;
      $("wallet-activity").textContent = "Check recent trades";
    }
  }
}
function signals() {
  if (study) return forwardSignals();
  const s = data.consensus;
  $("copy-signals").innerHTML =
    `<p class="notice">Consensus feed paused. These ${s.signals.length} signals were recorded ${when(s.observedAt)} and are not current entries.</p><div class="trade-summary">${stat("Wallets watched", s.watchlistSize)}${stat("Minimum backers", s.minBackers)}${stat("Activity window", `${s.hours} hours`)}</div>` +
    s.signals
      .map(
        (s, i) =>
          `<article class="signal-row"><div><span class="muted">${esc(s.category)}</span><h3>${esc(s.title)}</h3><p>${esc(s.outcome)} · ${fraction(s.currentPrice)} recorded price</p></div><div><strong>${s.backerCount} backing wallets</strong><p>${money(s.totalNetUsd)} net buying</p><button class="quiet-button" data-copy-signal="${i}">Inspect backers</button></div></article>`,
      )
      .join("") +
    `<details class="disclosure"><summary>How the copy strategy works</summary><div class="rule-grid"><p><strong>Qualify wallets first</strong>The saved cohort excludes market makers and incomplete histories. It requires at least $100,000 historical P&L and 50% profitable days.</p><p><strong>Look for agreement</strong>Require at least three backing wallets; subtract hedged buying, cap conviction and discount older activity. Wallet count does not prove independent ownership.</p><p><strong>Check the entry</strong>Price drift, real book depth, current fees and event resolution must be checked before a new simulation can qualify.</p><p><strong>Measure what followed</strong>Compare delayed fills, losses and concentrated winners. The historical priority score is not a probability of winning.</p></div></details>`;
}
function signalDetail(i) {
  const s = data?.consensus.signals[i];
  if (!s) return;
  inspect(
    "Copy trading · Consensus signal",
    `<h2>${esc(s.title)}</h2><p>${esc(s.outcome)} · observed ${when(data.consensus.observedAt)}</p><div class="trade-summary">${stat("Recorded price", fraction(s.currentPrice))}${stat("Backers’ average entry", fraction(s.backersAvgEntry))}${stat("Price drift", fraction(s.driftSinceEntry))}</div>${table(
      ["Backing wallet", "Net buying", "Average entry", "Age at scan"],
      s.backers.map((b) => [
        `<button class="text-action" data-wallet="${esc(b.wallet)}">${esc(b.name)}</button>`,
        money(b.netUsd),
        fraction(b.avgPrice),
        `${b.lastTradeAgoH} h`,
      ]),
    )}<p class="notice">Saved signal; the feed is paused. Named wallets can be inspected individually, including their recent public activity.</p>`,
  );
}
function legacyAccount() {
  const p = data.paper,
    unrealized = p.positions.reduce((s, t) => s + (t.valueUsd - t.costUsd), 0);
  $("copy-paper").innerHTML =
    `<p class="notice">Paper account paused at ${when(p.updatedAt)}. The old model included 1¢ slippage but omitted explicit exchange fees and sometimes inferred settlement from price. Its recorded results are provisional.</p><div class="trade-summary">${stat("Recorded equity", money(p.equity))}${stat("Starting balance", money(p.bankrollStart))}${stat("Cash", money(p.cash))}${stat("Recorded realized P&L", money(p.realizedPnl))}</div><div class="account-curve">${curve(
      p.equityCurve.map((v) => [v.t, v.equity]),
      "Copy-paper account equity since account creation",
    )}</div><p class="table-note">Chart starts at the recorded $50 opening cash baseline, ${when(p.curveStartAt)}. Earlier account and funding points are excluded. ${money(unrealized)} recorded unrealized P&L.</p><div class="section-heading"><h3>Open copy positions</h3><button class="quiet-button" id="export-copy-legacy">Export paper trades</button></div>${table(
      ["Market", "Outcome", "Entry", "Recorded mark", "Invested"],
      p.positions.map((t) => [
        esc(t.question),
        esc(t.outcome),
        fraction(t.entryPrice),
        fraction(t.markPrice),
        money(t.costUsd),
      ]),
    )}<div class="section-heading"><h3>Recorded closed trades</h3><span class="muted">${p.wins} positive / ${p.closed.length - p.wins} negative</span></div>${table(
      ["Market / outcome", "Closed", "Invested", "P&L"],
      [...p.closed]
        .sort((a, b) => b.settledAt - a.settledAt)
        .map((t) => [
          `${esc(t.question)}<small class="cell-note">${esc(t.outcome)}</small>`,
          when(t.settledAt),
          money(t.costUsd),
          `<strong class="${t.pnl >= 0 ? "positive" : "negative"}">${money(t.pnl)}</strong>`,
        ]),
    )}<p id="copy-legacy-export-status" role="status" class="table-note"></p>`;
}
function evidence() {
  const variants = [
    ["2backers-1h", "Two backers / 1 h", -1.9, 21, 43, 46],
    ["2backers-3h", "Two backers / 3 h", -26.2, 17, 36, 66],
    ["3backers-1h", "Three backers / 1 h", 42.3, 18, 34, 51],
  ];
  $("copy-evidence").innerHTML =
    `${forwardEvidence()}<div class="research-intro"><h2>What happened when we copied?</h2><p>The same test window produced very different outcomes when the delay and required agreement changed.</p></div>${table(
      [
        "Historical variant",
        "Marked return",
        "Settled wins",
        "Top 3 profit share",
        "Study",
      ],
      variants.map(([id, label, ret, w, n, share]) => [
        esc(label),
        `<strong class="${ret > 0 ? "positive" : "negative"}">${pct(ret)}</strong>`,
        `${w} / ${n}`,
        pct(share),
        reportLink(`backtest-${id}.md`, "Read trades"),
      ]),
    )}<div class="research-panel"><h3>Stricter agreement is worth studying further</h3><p>The three-backer test had 44 entries, 34 settlements and 10 positions still open. Three winners generated 51% of gross profit. These are simulated results from June 28–August 12, using later observed prices plus 1¢ slippage; explicit exchange fees were not included.</p><p>Other train/test splits reused overlapping dates, so they do not constitute independent confirmation. The next useful evidence is fresh, fee-complete forward simulation with verified final outcomes.</p>${reportLink("backtest-summary.md", "Compare every recorded test")}</div>`;
}
function walletScore(w) {
  const r = w.research;
  if (!r) return "";
  return `<div class="research-panel"><h3>${r.score.toFixed(1)} / 100 research score</h3><p>${r.eligible ? "Passes coverage, consistency and diversification rules." : "Held: " + esc(r.reasons.join("; ")) + "."} ${w.tracked ? "Selected for the frozen forward cohort." : ""}</p>${table(
    ["Component", "Score contribution"],
    Object.entries(r.components).map(([k, v]) => [
      {
        pathEfficiency: "Gains relative to daily P&L swings",
        drawdownRecovery: "Gains relative to drawdown",
        persistence: "Positive recent time blocks",
        breadth: "Event diversification",
      }[k],
      `${(v * 25).toFixed(1)} / 25`,
    ]),
  )}<p class="table-note">${r.materialDays} material P&L days; ${r.positiveBlocks} of three recent 20-change blocks positive. This is a research priority score, not a win probability. Analytics frozen ${when(study.source.analyticsAt)}.</p></div>`;
}
function forwardSignals() {
  const s = study,
    complete = s.coverage.filter((c) => c.complete).length;
  $("copy-signals").innerHTML =
    `<div class="research-intro"><h2>Follow agreement. Check the entry.</h2><p>Three backing wallets, balanced influence and confirmation in a later scan. Every copied position is simulated at a subsequently observed ask, with fees and a ½¢ per-share buffer.</p></div>
    <div class="trade-summary">${stat("Complete wallet feeds", `${complete} / ${s.cohort.length}`)}${stat("Candidates this scan", s.candidates.length)}${stat("Activity lookback", `${s.rules.windowHours} hours`)}</div>
    ${s.errors.length ? `<p class="notice">${esc(s.errors.map((e) => e.source + ": " + e.message).join(" · "))}</p>` : ""}
    ${
      s.candidates.length
        ? table(
            ["Market / outcome", "Backing", "Decision"],
            s.candidates.map((c) => {
              const d = s.lastDecisions?.find(
                (d) => d.condition === c.condition && d.token === c.token,
              );
              return [
                `<button class="route-name" data-study-signal="${esc(c.id)}"><strong>${esc(c.title)}</strong><small>${esc(c.outcome)}</small></button>`,
                `${c.backerCount} wallets<small class="cell-note">${c.effectiveBackers.toFixed(1)} effective · ${fraction(c.dominance)} of weighted flow</small>`,
                `${badge(d?.status === "simulated-entry" ? "Copied in simulation" : "Held", d?.status === "simulated-entry" ? "positive" : "")}<small class="cell-note">${esc(d?.reasons[0] || "Entry recorded with costs")}</small>`,
              ];
            }),
          )
        : empty(
            "No overlapping buying yet",
            "A quiet scan is a valid result. The study waits for agreement instead of manufacturing trades.",
          )
    }
    <details class="disclosure"><summary>Recent decisions and entry rules</summary><div class="section-heading"><h3>All candidates, including holds</h3><button class="quiet-button" id="export-copy-decisions">Export decisions</button></div>
      ${table(
        ["Observed", "Market / outcome", "Decision"],
        [...s.decisions]
          .reverse()
          .slice(0, 25)
          .map((d) => [
            when(d.at),
            `${esc(d.title)}<small class="cell-note">${esc(d.outcome)}</small>`,
            esc(
              d.status === "held"
                ? d.reasons.join("; ")
                : "Simulated entry · " + money(d.cost),
            ),
          ]),
      )}
      <p id="copy-decision-export-status" class="table-note" role="status"></p><p class="table-note">${money(s.rules.stake)} maximum per entry, ${money(s.rules.maxExposure)} total exposure, ${money(s.rules.maxEventExposure)} per event. Maximum spread 5¢; entry drift 3¢. At most 10% of each recorded ask level. A 20% drawdown stops new entries.</p>
      <p class="table-note">Effective backers measures vote concentration; wallets may share ownership. Trade flow excludes transfers, splits and redemptions. Overlap reads can detect delayed indexing; identical fills without a unique log ID may be deduplicated.</p></details>`;
}
function studySignal(id) {
  const c = study?.candidates.find((c) => c.id === id);
  if (!c) return;
  const d = study.lastDecisions?.find(
    (d) => d.condition === c.condition && d.token === c.token,
  );
  inspect(
    "Copy trading · Forward candidate",
    `<h2>${esc(c.title)}</h2><p>${esc(c.outcome)} · observed ${when(study.generatedAt)}</p><div class="trade-summary">${stat("Backing wallets", c.backerCount)}${stat("Effective backers", c.effectiveBackers.toFixed(2))}${stat("Net-flow entry reference", fraction(c.avgEntry))}</div>${table(
      ["Wallet", "Net buying", "Entry reference", "Last buy"],
      c.backers.map((b) => [
        `<button class="text-action" data-wallet="${esc(b.wallet)}">${esc(b.name)}</button>`,
        money(b.netUsd),
        fraction(b.avgPrice),
        when(b.lastTradeAt),
      ]),
    )}<p class="notice">${esc(d?.reasons.join("; ") || "Entry recorded in the paper account.")}</p><p class="table-note">Backer prices use share-weighted principal, with remaining net flow determining each wallet’s influence. Recent sells reduce backing; they do not refresh the age of earlier buys.</p>`,
  );
}
function account() {
  legacyAccount();
  if (!study) return;
  const old = $("copy-paper").innerHTML,
    s = study;
  $("copy-paper").innerHTML =
    `<div class="research-intro"><h2>The forward paper account</h2><p>A separate ${money(s.rules.bankroll)} simulation started ${when(s.createdAt)}. Ranking inputs and entry rules were frozen before the first observation.</p></div>
    <div class="trade-summary">${stat(s.equityComplete ? "Simulated equity" : "Equity with retained marks", money(s.equity))}${stat("Cash", money(s.cash))}${stat("Realized P&L", money(s.closed.reduce((v, p) => v + p.pnl, 0)))}${stat("Complete scans", s.counters.completeScans)}</div>
    ${s.entryPaused ? '<p class="notice">Drawdown stop active. Settlement and position monitoring continue.</p>' : ""}
    ${!s.equityComplete ? '<p class="notice">A position has no current liquidation mark. Its last value is retained and new entries are held.</p>' : ""}
    ${curve(
      s.curve.map((p) => [p.at, p.equity]),
      "Forward copy simulation equity",
    )}
    <div class="section-heading"><h3>Copied positions</h3><button class="quiet-button" id="export-copy">Export forward trades</button></div>
    ${
      s.positions.length
        ? table(
            ["Market / outcome", "Cost / fees", "Liquidation value", "Mark"],
            s.positions.map((p) => [
              `${esc(p.title)}<small class="cell-note">${esc(p.outcome)} · ${p.shares.toFixed(4)} shares</small>`,
              `${money(p.cost)}<small class="cell-note">${money(p.entryFee)} fees · ${money(p.entrySlippage)} buffer</small>`,
              money(p.value),
              `${esc(p.markStatus)}<small class="cell-note">${when(p.markedAt)}</small>`,
            ]),
          )
        : empty(
            "No copied positions yet",
            "Candidates must pass two complete scans and the entry checks. Cash stays available while the study waits.",
          )
    }
    <div class="section-heading"><h3>Officially settled simulated trades</h3></div>${
      s.closed.length
        ? table(
            ["Market / outcome", "Entry cost", "Payout per share", "Net P&L"],
            [...s.closed]
              .reverse()
              .map((p) => [
                `${esc(p.title)}<small class="cell-note">${esc(p.outcome)}</small>`,
                money(p.cost),
                fraction(p.payout),
                money(p.pnl),
              ]),
          )
        : '<p class="table-note">No final outcomes recorded yet. A price near $1 does not settle this account.</p>'
    }
    <p id="copy-export-status" class="table-note" role="status"></p><details class="disclosure"><summary>Earlier $50 account · paused historical record</summary>${old}</details>`;
}
function forwardEvidence() {
  if (!study) return "";
  const s = study,
    closed = s.closed,
    wins = closed.filter((p) => p.pnl > 0),
    profits = wins.map((p) => p.pnl).sort((a, b) => b - a),
    gross = profits.reduce((a, b) => a + b, 0);
  const pnl = closed.map((p) => p.pnl).sort((a, b) => a - b),
    n = pnl.length,
    median = n
      ? (pnl[Math.floor((n - 1) / 2)] + pnl[Math.floor(n / 2)]) / 2
      : null;
  return `<div class="research-panel"><h2>Evidence collected from here forward</h2><div class="trade-summary">${stat("Settled trades", n)}${stat("Positive outcomes", n ? `${wins.length} / ${n}` : "Awaiting outcomes")}${stat("Median trade P&L", n ? money(median) : "—")}${stat("Top three share of gross profit", gross ? fraction(profits.slice(0, 3).reduce((a, b) => a + b, 0) / gross) : "—")}</div><p>${s.counters.candidates} candidate decisions across ${s.counters.completeScans} complete scans. ${n < 30 ? "The outcome sample is too small to judge repeatable performance." : ""} The wallet cohort came from previously profitable accounts, so selection bias remains.</p><p class="table-note">New records include observed entry depth, fee curves, costs and official final payouts. The studies below use the earlier model and remain separately labeled.</p></div>`;
}
function select(value) {
  tab = value;
  document
    .querySelectorAll("[data-copy-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.copyTab === tab)),
    );
  document
    .querySelectorAll("[data-copy-panel]")
    .forEach((e) => (e.hidden = e.dataset.copyPanel !== tab));
}
export function renderCopyTrading(snapshot, forward) {
  study = forward;
  const ranking = new Map((study?.ranking || []).map((w) => [w.wallet, w])),
    cohort = new Set(study?.cohort.map((w) => w.wallet) || []);
  data = {
    ...snapshot,
    analytics: {
      ...snapshot.analytics,
      wallets: snapshot.analytics.wallets.map((w) => {
        const r = ranking.get(w.wallet.toLowerCase());
        return {
          ...w,
          ...(r
            ? { researchScore: r.score, eligible: r.eligible, research: r }
            : {}),
          tracked: study ? cohort.has(w.wallet.toLowerCase()) : w.tracked,
        };
      }),
    },
  };
  $("copy-summary").innerHTML =
    `<div><strong>${data.analytics.wallets.length} researched wallets</strong><span>${data.analytics.watchlistSize} in the historical copy cohort</span></div><div><strong>${data.paper.closed.length} recorded closed trades</strong><span>${data.paper.positions.length} positions still in the paused book</span></div><div><strong>Public wallet research</strong><span>Polymarket international · simulation only</span></div>`;
  if (study)
    $("copy-summary").innerHTML =
      `<div><strong>${study.cohort.length} wallets in the forward study</strong><span>${study.ranking.filter((w) => w.eligible).length} pass the research rules · ${study.ranking.length} reviewed</span></div><div><strong>${money(study.equity)} simulated equity</strong><span>${study.positions.length} open · ${study.closed.length} settled · ${money(study.cash)} cash</span></div><div><strong>${study.coverage.filter((w) => w.complete).length} / ${study.cohort.length} wallet feeds complete</strong><span>Observed ${when(study.generatedAt)}</span></div>`;
  const selected = $("wallet-category").value;
  $("wallet-category").innerHTML =
    '<option value="all">All specialties</option>' +
    [...new Set(data.analytics.wallets.map(category))]
      .sort()
      .map((c) => `<option>${esc(c)}</option>`)
      .join("");
  $("wallet-category").value = selected;
  wallets();
  signals();
  account();
  evidence();
  select(tab);
}
export function initCopyTrading() {
  $("wallet-filter-toggle").addEventListener("click", () => {
    const button = $("wallet-filter-toggle"),
      expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.closest(".wallet-filters").dataset.expanded = String(expanded);
    button.textContent = expanded ? "Hide filters" : "Filters";
  });
  for (const id of [
    "wallet-search",
    "wallet-category",
    "wallet-scope",
    "wallet-sort",
  ])
    $(id).addEventListener(id === "wallet-search" ? "input" : "change", () => {
      limit = 20;
      wallets();
    });
  $("wallet-more").addEventListener("click", () => {
    limit += 20;
    wallets();
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copyTab) select(b.dataset.copyTab);
    if (b.dataset.wallet) showWallet(b.dataset.wallet);
    if (b.dataset.studySignal !== undefined) studySignal(b.dataset.studySignal);
    if (b.dataset.copySignal !== undefined)
      signalDetail(Number(b.dataset.copySignal));
    if (b.dataset.saveWallet) {
      const address = b.dataset.saveWallet;
      if (saved.has(address)) saved.delete(address);
      else saved.add(address);
      try {
        localStorage.setItem("mm-copy-wallets", JSON.stringify([...saved]));
      } catch {}
      wallets();
      document.querySelectorAll("[data-save-wallet]").forEach((el) => {
        if (el.dataset.saveWallet === address) {
          el.setAttribute("aria-pressed", String(saved.has(address)));
          el.textContent = saved.has(address) ? "★" : "☆";
        }
      });
      $("copy-action-status").textContent = saved.has(address)
        ? "Wallet saved on this browser."
        : "Wallet removed from saved list.";
    }
    if (b.id === "wallet-activity") activity();
    if (b.id === "export-copy" && study) {
      const count = downloadCsv(
        "moffitt-copy-forward.csv",
        [
          "id",
          "status",
          "title",
          "outcome",
          "shares",
          "cost",
          "entryPrice",
          "entryFee",
          "entrySlippage",
          "openedAt",
          "settledAt",
          "proceeds",
          "pnl",
        ],
        [
          ...study.positions.map((p) => ({ ...p, status: "open" })),
          ...study.closed.map((p) => ({ ...p, status: "settled" })),
        ],
      );
      $("copy-export-status").textContent =
        `Exported ${count} forward simulated trades.`;
    }
    if (b.id === "export-copy-decisions" && study) {
      const count = downloadCsv(
        "moffitt-copy-decisions.csv",
        [
          "at",
          "title",
          "outcome",
          "status",
          "backerCount",
          "effectiveBackers",
          "avgEntry",
          "cost",
          "reasons",
        ],
        study.decisions.map((d) => ({ ...d, reasons: d.reasons.join("; ") })),
      );
      $("copy-decision-export-status").textContent =
        `Exported ${count} recent decisions, including holds.`;
    }
    if (b.id === "export-copy-legacy" && data) {
      const rows = [
        ...data.paper.positions.map((p) => ({ ...p, status: "open" })),
        ...data.paper.closed.map((p) => ({ ...p, status: "closed" })),
      ].map((p) => ({
        ...p,
        sourceAsOf: data.paper.updatedAt,
        feeComplete: false,
        settlementVerified: false,
      }));
      const count = downloadCsv(
        "moffitt-copy-paper.csv",
        [
          "status",
          "question",
          "outcome",
          "shares",
          "entryPrice",
          "costUsd",
          "markPrice",
          "pnl",
          "openedAt",
          "settledAt",
          "sourceAsOf",
          "feeComplete",
          "settlementVerified",
        ],
        rows,
      );
      $("copy-legacy-export-status").textContent =
        `Exported ${count} recorded positions and trades.`;
    }
  });
}
