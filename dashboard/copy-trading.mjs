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
          "90-day P&L",
          "Profitable days",
          "Drawdown",
          "Cohort",
          "Save",
        ],
        rows
          .slice(0, limit)
          .map((w) => [
            `<button class="wallet-name" data-wallet="${esc(w.wallet)}"><span class="wallet-avatar">${esc(w.name.slice(0, 2))}</span><span>${esc(w.name)}<small>${esc(category(w))} · ${compact(w.distinctMarkets)} markets</small></span></button>`,
            `<strong class="${w.pnl90 >= 0 ? "positive" : "negative"}">${money(w.pnl90)}</strong>`,
            fraction(w.winDayRate),
            money(w.maxDrawdown90),
            badge(
              w.truncated
                ? "Incomplete history"
                : w.tracked
                  ? "Tracked in study"
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
    `<div class="wallet-profile-heading"><div><h2>${esc(w.name)}</h2><p class="muted">${esc(w.archetype)} · ${esc(category(w))}</p></div>${pin(w)}</div><p class="wallet-address">${esc(w.wallet)}</p><div class="trade-summary">${stat("90-day P&L", money(w.pnl90))}${stat("Profitable days", fraction(w.winDayRate))}${stat("Peak-to-trough loss", money(w.maxDrawdown90))}</div>${curve(w.history, "Historical cumulative wallet P&L")}<p class="table-note">Analytics observed ${when(data.analytics.observedAt)}. Profitable days count days with a P&L change greater than $1, not winning trades. ${w.truncated ? "This wallet’s trade history is incomplete." : ""}</p><div class="rule-grid"><p><strong>${compact(w.trades90)} recorded trades</strong>${compact(w.activeDays)} active days; ${money(w.medianTradeUsd)} median trade.</p><p><strong>${fraction(w.top5EventShare)} in five events</strong>Share of traded volume concentrated in the wallet’s five largest events.</p></div><details class="disclosure"><summary>Category mix and largest recorded positions</summary>${table(
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
function account() {
  const p = data.paper,
    unrealized = p.positions.reduce((s, t) => s + (t.valueUsd - t.costUsd), 0);
  $("copy-paper").innerHTML =
    `<p class="notice">Paper account paused at ${when(p.updatedAt)}. The old model included 1¢ slippage but omitted explicit exchange fees and sometimes inferred settlement from price. Its recorded results are provisional.</p><div class="trade-summary">${stat("Recorded equity", money(p.equity))}${stat("Starting balance", money(p.bankrollStart))}${stat("Cash", money(p.cash))}${stat("Recorded realized P&L", money(p.realizedPnl))}</div><div class="account-curve">${curve(
      p.equityCurve.map((v) => [v.t, v.equity]),
      "Copy-paper account equity since account creation",
    )}</div><p class="table-note">Chart starts at the recorded $50 opening cash baseline, ${when(p.curveStartAt)}. Earlier account and funding points are excluded. ${money(unrealized)} recorded unrealized P&L.</p><div class="section-heading"><h3>Open copy positions</h3><button class="quiet-button" id="export-copy">Export paper trades</button></div>${table(
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
    )}<p id="copy-export-status" role="status" class="table-note"></p>`;
}
function evidence() {
  const variants = [
    ["2backers-1h", "Two backers / 1 h", -1.9, 21, 43, 46],
    ["2backers-3h", "Two backers / 3 h", -26.2, 17, 36, 66],
    ["3backers-1h", "Three backers / 1 h", 42.3, 18, 34, 51],
  ];
  $("copy-evidence").innerHTML =
    `<div class="research-intro"><h2>What happened when we copied?</h2><p>The same test window produced very different outcomes when the delay and required agreement changed.</p></div>${table(
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
export function renderCopyTrading(snapshot) {
  data = snapshot;
  $("copy-summary").innerHTML =
    `<div><strong>${data.analytics.wallets.length} researched wallets</strong><span>${data.analytics.watchlistSize} in the historical copy cohort</span></div><div><strong>${data.paper.closed.length} recorded closed trades</strong><span>${data.paper.positions.length} positions still in the paused book</span></div><div><strong>Public wallet research</strong><span>Polymarket international · simulation only</span></div>`;
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
    if (b.id === "export-copy" && data) {
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
      $("copy-export-status").textContent =
        `Exported ${count} recorded positions and trades.`;
    }
  });
}
