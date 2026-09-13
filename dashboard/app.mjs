import { publishedJson, publicationHealth } from "./data-client.mjs";
import { VENUES, fill } from "./prediction-core.mjs";
import { validPredictions, validResearchSummary } from "./app-schema.mjs";
import { validateResearch, validatePaper } from "./etf-schema.mjs";
import { validCopySnapshot, validCopyStudy } from "./copy-core.mjs";
import { validCryptoSnapshot } from "./crypto-arbitrage-core.mjs";
import { initCopyTrading, renderCopyTrading } from "./copy-trading.mjs";
import { initCryptoTrading, renderCryptoTrading } from "./crypto-arbitrage.mjs";
import { validCryptoHistory, validSpotSnapshot } from "./trading-schema.mjs";
const $ = (id) => document.getElementById(id),
  n = Number.isFinite;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) =>
  n(v)
    ? v.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";
const cents = (v) =>
  n(v) ? `${(v * 100).toFixed(1).replace(/\.0$/, "")}¢` : "—";
const percent = (v) => (n(v) ? `${v.toFixed(2)}%` : "—");
const when = (v) =>
  n(v)
    ? new Date(v * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
const age = (v) =>
  !n(v)
    ? "Unknown age"
    : Date.now() / 1000 - v < 60
      ? "Just now"
      : Date.now() / 1000 - v < 3600
        ? `${Math.floor((Date.now() / 1000 - v) / 60)} min ago`
        : `${Math.floor((Date.now() / 1000 - v) / 3600)} hr ago`;
const name = (v) => (v === "polymarket" ? "Polymarket US" : "Kalshi");
const badge = (label, kind = "") =>
  `<span class="status ${kind}">${esc(label)}</span>`;
const stat = (label, value, kind = "") =>
  `<div class="stat"><small>${esc(label)}</small><strong class="${kind}">${esc(value)}</strong></div>`;
const empty = (title, description) =>
  `<div class="empty"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
const row = (label, value) =>
  `<div><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
const table = (heads, rows) =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
function safeLink(url, label) {
  try {
    const u = new URL(url);
    if (
      u.protocol === "https:" &&
      [
        "polymarket.us",
        "kalshi.com",
        "github.com",
        "docs.kalshi.com",
        "docs.polymarket.us",
      ].includes(u.hostname)
    )
      return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  } catch {}
  return esc(label);
}
let snapshot,
  etf,
  etfPaper,
  archive,
  copySnapshot,
  copyStudy,
  cryptoSnapshot,
  cryptoHistory,
  spotSnapshot,
  desk = "markets",
  study = "predictions",
  limit = 18,
  busy = false;
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("mm-theme-v5") || "light";
} catch {}
function shortQuestion(m) {
  const title =
    m.displayTitle ||
    m.identity?.title ||
    (m.question || "Unnamed contract").replace(
      /^Who will win in the upcoming (?:football|baseball) event (.*?) scheduled for .*?: /,
      "$1 · ",
    );
  return [...new Set(title.split(" · ").map((s) => s.trim()))].join(" · ");
}
function legName(leg, pair) {
  const m = pair.markets.find((m) => m.venue === leg.venue);
  const labels = pair.markets[0].identity?.labels || {};
  const yes = m.yesLabel || labels[m.identity?.yesId] || "the selected outcome";
  return `${name(leg.venue)} · ${leg.side.toUpperCase()} on ${yes}`;
}

function decisions(m) {
  return snapshot.decisions
    .filter((d) => d.marketId === m.id)
    .sort((a, b) => (b.plan?.edge ?? -2) - (a.plan?.edge ?? -2));
}
function statusFor(m) {
  const ds = decisions(m),
    d = ds[0];
  if (m.sourceError) return ["Book unavailable", "caution"];
  if (!n(m.closeAt)) return ["Cutoff unavailable", "caution"];
  if (m.closeAt <= Date.now() / 1000) return ["Entry closed", ""];
  if (d?.plan?.status === "candidate")
    return ["Qualified in last scan", "positive"];
  if (!d?.forecast?.eligible) return ["Collecting evidence", ""];
  return ["Costs or risk hold", ""];
}
function selectStudy(value) {
  study = value;
  document
    .querySelectorAll("[data-study]")
    .forEach((el) =>
      el.setAttribute("aria-pressed", String(el.dataset.study === study)),
    );
  $("prediction-study").hidden = study !== "predictions";
  $("etf-study").hidden = study !== "etf";
  drawETF();
}
function route() {
  const [requested, subview] = location.hash.slice(1).split("/");
  const view = ["copy", "crypto", "desk", "trades", "research"].includes(
    requested,
  )
    ? requested
    : "copy";
  if (
    view === "copy" &&
    ["wallets", "signals", "paper", "evidence"].includes(subview)
  )
    document.querySelector(`[data-copy-tab="${subview}"]`).click();
  if (
    view === "crypto" &&
    ["cross", "triangles", "history", "spot"].includes(subview)
  )
    document.querySelector(`[data-crypto-tab="${subview}"]`).click();
  if (view === "research" && subview === "etf") selectStudy("etf");
  document
    .querySelectorAll("[data-view]")
    .forEach((el) => (el.hidden = el.dataset.view !== view));
  document.querySelectorAll("[data-route]").forEach((el) => {
    if (el.dataset.route === (view === "trades" ? "desk" : view))
      el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  $("page-title").textContent = {
    copy: "Copy trading",
    crypto: "Crypto arbitrage",
    desk: "Prediction desk",
    trades: "Paper trades",
    research: "Research & results",
  }[view];
  $("page-description").textContent = {
    copy: "Wallet research, consensus signals and the trades that followed.",
    crypto:
      "The same crypto asset, different prices. Follow the gap through every cost.",
    desk: "Kalshi and Polymarket US, with the costs in view.",
    trades: "The positions, payouts and costs behind every result.",
    research: "Studies, recorded outcomes and results after costs.",
  }[view];
  document.title = `Moffitt Money — ${$("page-title").textContent}`;
  $("portfolio").hidden = !["desk", "trades"].includes(view);
}
function renderPortfolio() {
  const accounts = VENUES.map((v) => snapshot.accounts[v]),
    total = accounts.reduce((s, a) => s + a.equity, 0),
    open = accounts.reduce((s, a) => s + a.positions.length, 0);
  $("portfolio").innerHTML =
    `<div class="portfolio-total"><small>Prediction paper equity</small><strong>${money(total)}</strong></div>${VENUES.map((v) => `<div class="portfolio-venue"><span class="venue-icon ${v}">${v === "polymarket" ? "P" : "K"}</span><div><small>${name(v)}</small><strong>${money(snapshot.accounts[v].equity)}</strong></div></div>`).join("")}<div class="portfolio-outcome"><strong>${open} open ${open === 1 ? "position" : "positions"}</strong>${money(accounts.reduce((s, a) => s + a.realizedPnl, 0))} realized P&amp;L</div>`;
}
function renderDesk() {
  if (!snapshot) return;
  const query = $("search").value.trim().toLowerCase(),
    venue = $("venue").value;
  const allPairs = snapshot.arbitrage?.pairs || [];
  const games = new Map();
  for (const p of allPairs) {
    const key = p.markets[0].id;
    const previous = games.get(key);
    if (
      !previous ||
      (p.best?.normalNetPerContract ?? -9) >
        (previous.best?.normalNetPerContract ?? -9)
    )
      games.set(key, p);
  }
  const pairs = [...games.values()];
  $("market-total").textContent = snapshot.markets.length;
  $("pair-total").textContent = pairs.length;
  $("venue").disabled = desk === "pairs";
  $("sort").disabled = desk === "pairs";
  for (const id of ["venue", "sort"])
    $(id).closest("label").hidden = desk === "pairs";
  if (desk === "pairs") {
    const rows = pairs.filter((p) => p.title?.toLowerCase().includes(query));
    $("scan-summary").textContent =
      `${rows.length} matched games · best of both Kalshi team-strike books`;
    $("scan-time").textContent = when(snapshot.arbitrage?.generatedAt);
    $("more").hidden = true;
    $("market-surface").innerHTML = rows.length
      ? rows
          .map((p) => {
            const b = p.best;
            return `<article class="pair-row"><div><button data-pair="${esc(p.id)}">${esc(p.title)}</button><div class="market-meta">${esc(p.league.toUpperCase())} · ${when(p.startAt)} · book ${age(p.observedAt)}</div></div><div class="pair-prices">${b ? b.legs.map((l) => `<div><small>${esc(legName(l, p))} × ${l.quantity}</small><strong>${money(l.cost)}</strong></div>`).join("") : '<p class="muted">Package cannot be priced</p>'}</div><div class="pair-result"><strong class="${b?.normalNet > 0 ? "positive" : "negative"}">${b ? cents(b.normalNet / b.quantity) : "—"}</strong>${badge(Date.now() / 1000 - p.observedAt > 30 ? "Dated quote" : p.status === "conditional-gap" ? "Rule review" : p.status === "held" ? "Review hold" : "No net gap")}</div></article>`;
          })
          .join("")
      : empty(
          "No matched books in this scan",
          snapshot.arbitrage?.errors?.[0]?.message ||
            "The scanner compares upcoming NFL and MLB games. Unmatched events are not treated as equivalent contracts.",
        );
    $("desk-note").textContent =
      "Scanned gap is per equal-quantity package after fees and 1¢ slippage on each leg, assuming the same normal outcome. Exceptional settlements can differ. These packages are not certified arbitrage.";
    return;
  }
  let markets = snapshot.markets.filter(
    (m) =>
      (venue === "all" || m.venue === venue) &&
      (!query || `${m.question} ${m.venueId}`.toLowerCase().includes(query)),
  );
  const spread = (m) =>
    (m.sides?.yes?.asks?.[0]?.[0] ?? 2) - (m.sides?.yes?.bid ?? 0);
  const evidence = (m) => decisions(m)[0]?.forecast?.samples || 0;
  markets.sort((a, b) =>
    $("sort").value === "spread"
      ? spread(a) - spread(b)
      : $("sort").value === "evidence"
        ? evidence(b) - evidence(a)
        : (a.closeAt < Date.now() / 1000) - (b.closeAt < Date.now() / 1000) ||
          a.closeAt - b.closeAt,
  );
  const eligible = snapshot.decisions.filter(
    (d) => d.plan?.status === "candidate",
  ).length;
  $("scan-summary").textContent =
    `${markets.length} markets · ${eligible} qualifying outcomes in the last scan`;
  $("scan-time").textContent = `Scan ${age(snapshot.generatedAt)}`;
  $("market-surface").innerHTML = markets.length
    ? `<table class="market-table"><thead><tr><th>Question</th><th>Venue</th><th class="num">Buy Yes</th><th class="num">Buy No</th><th>Decision</th></tr></thead><tbody>${markets
        .slice(0, limit)
        .map(
          (m) =>
            `<tr><td><button class="market-title" data-market="${esc(m.id)}">${esc(shortQuestion(m))}</button><div class="market-meta">${esc(m.category)} · ${when(m.closeAt)}</div></td><td><span class="venue-name"><span class="venue-initial ${m.venue}">${m.venue === "polymarket" ? "P" : "K"}</span>${m.venue === "polymarket" ? "Polymarket" : "Kalshi"}</span></td><td class="num price">${cents(m.sides?.yes?.asks?.[0]?.[0])}</td><td class="num price">${cents(m.sides?.no?.asks?.[0]?.[0])}</td><td>${badge(...statusFor(m))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : empty(
        "No markets match these filters",
        "Try another search or select both venues.",
      );
  $("more").hidden = markets.length <= limit;
  $("desk-note").textContent =
    "Ask prices are dated scan observations, before fees. Open a contract for total cost, evidence and the reason it is held.";
}
function inspectMarket(id) {
  const m = snapshot.markets.find((m) => m.id === id);
  if (!m) return;
  const d = decisions(m)[0],
    f = d?.forecast;
  const min = Math.max(1, Math.ceil(m.minQuantity || 1)),
    yes = fill(m.sides.yes.asks, min, m.feeRate),
    no = fill(m.sides.no.asks, min, m.feeRate);
  $("inspector-label").textContent = `${name(m.venue)} · Contract details`;
  $("inspector-content").innerHTML =
    `<h2>${esc(shortQuestion(m))}</h2><p class="detail-meta">${m.yesLabel ? `YES refers to ${esc(m.yesLabel)}. ` : ""}Entry cutoff ${when(m.closeAt)} · ${esc(m.cutoffKind)}</p><div class="detail-prices"><div><small>Buy Yes · before costs</small><strong>${cents(m.sides.yes.asks[0]?.[0])}</strong></div><div><small>Buy No · before costs</small><strong>${cents(m.sides.no.asks[0]?.[0])}</strong></div></div><h3>Total acquisition cost · ${min} ${min === 1 ? "contract" : "contracts"}</h3><div class="cost-lines">${row("Yes: principal / fee / slippage", yes ? `${money(yes.principal)} / ${money(yes.fees)} / ${money(yes.slippage)}` : "Insufficient depth or unknown fees")}${row("No: principal / fee / slippage", no ? `${money(no.principal)} / ${money(no.fees)} / ${money(no.slippage)}` : "Insufficient depth or unknown fees")}${row("All-in Yes / No", `${money(yes?.cost)} / ${money(no?.cost)}`)}</div><div class="decision-note"><h3>${esc(statusFor(m)[0])}</h3><p>${esc(d?.plan?.reasons?.[0] || "The collector applies the current account and evidence policy.")}</p><p>${f?.samples || 0} comparable outcomes · ${f?.binSamples || 0} in this price band · ${f?.validation || 0} scored prior forecasts.</p></div><details class="disclosure"><summary>Settlement rules</summary><p class="contract-rules">${esc(m.rules || "Rules unavailable; no entry allowed.")}</p></details><p class="detail-meta">Book ${when(m.quoteAt)} (${age(m.quoteAt)}). ${esc(m.quoteTimeKind)}. Current fee estimate: ${esc(m.feeSource)}.</p><p style="margin-top:18px">${safeLink(m.url, "Open the exchange contract")}</p>`;
  $("inspector").showModal();
}
function inspectPair(id) {
  const p = snapshot.arbitrage?.pairs.find((p) => p.id === id);
  if (!p) return;
  const b = p.best;
  $("inspector-label").textContent = "Matched contracts · Price-gap research";
  $("inspector-content").innerHTML =
    `<h2>${esc(p.title)}</h2><p class="detail-meta">${when(p.startAt)} · Exact start and named team-provider IDs match.</p>${b ? `<div class="cost-lines">${b.legs.map((l) => row(legName(l, p) + " × " + l.quantity, money(l.cost))).join("")}${row("Both legs before fees", money(b.principal))}${row("Both venue fees", money(b.fees))}${row("Modeled slippage on both legs", money(b.slippage))}${row("Total cash required", money(b.cost))}${row("Payout if the normal outcomes agree", money(b.quantity))}${row("Normal-outcome net", money(b.normalNet))}</div>` : ""}<div class="decision-note"><h3>Not certified arbitrage</h3><p>${esc(p.settlement.reason)}</p><p>${p.reasons.map(esc).join(" ")}</p></div><h3 class="pair-payoff">What the package can pay per contract</h3>${table(
      ["Outcome", "Minimum", "Maximum"],
      p.settlement.scenarios.map((s) => [
        esc(s.name),
        money(s.minimum),
        money(s.maximum),
      ]),
    )}<p class="safety-note">Worst modeled settlement net: ${money(p.worstCaseNet)}. If only one leg fills, current-book unwind loss is ${money(b?.failedHedgeLoss)}; an outage or moving book can make it worse. No cross-venue orders are submitted.</p>${p.markets.map((m) => `<details class="disclosure"><summary>${name(m.venue)} contract and rules</summary><p class="contract-rules">${esc(m.rules)}</p><p>${safeLink(m.url, "Open contract")}</p><p class="detail-meta">Book ${when(m.quoteAt)}. ${esc(m.ruleHash)}</p></details>`).join("")}`;
  $("inspector").showModal();
}
function renderTrades() {
  const accounts = VENUES.map((v) => snapshot.accounts[v]),
    positions = accounts.flatMap((a) =>
      a.positions.map((t) => ({ ...t, venue: a.venue })),
    ),
    trades = accounts
      .flatMap((a) => a.trades.map((t) => ({ ...t, venue: a.venue })))
      .sort((a, b) => b.closedAt - a.closedAt);
  $("trade-summary").innerHTML =
    stat(
      "Realized net P&L",
      money(accounts.reduce((n, a) => n + a.realizedPnl, 0)),
    ) +
    stat("Settled trades", String(trades.length)) +
    stat(
      "Winning trades",
      trades.length
        ? `${trades.filter((t) => t.pnl > 0).length} of ${trades.length}`
        : "Not yet measured",
    ) +
    stat("Modeled entry fees", money(accounts.reduce((n, a) => n + a.fees, 0)));
  $("position-count").textContent = `${positions.length} open`;
  $("positions").innerHTML = positions.length
    ? table(
        ["Contract", "Venue / side", "Cost", "Mark", "Recorded"],
        positions.map((t) => [
          esc(t.question),
          `${name(t.venue)} / ${esc(t.side)}`,
          money(t.cost),
          money(t.markValue),
          when(t.openedAt),
        ]),
      )
    : empty(
        "No open positions",
        "Both accounts are collecting evidence. A scan or a resolved research observation is not a trade.",
      );
  $("closed-trades").innerHTML = trades.length
    ? table(
        ["Contract", "Venue / side", "Cost", "Payout", "Net result"],
        trades.map((t) => [
          esc(t.question),
          `${name(t.venue)} / ${esc(t.side)}`,
          money(t.cost),
          money(t.payout),
          `<strong class="${t.pnl >= 0 ? "positive" : "negative"}">${money(t.pnl)}</strong>`,
        ]),
      )
    : empty(
        "No settled prediction trades yet",
        "Win rate and realized trading performance will appear after actual simulated positions settle.",
      );
  const cycles = snapshot.automation?.recentCycles || [];
  $("scan-activity").innerHTML = table(
    ["Completed scan", "Markets checked", "Opened", "Settled"],
    cycles
      .slice(-12)
      .reverse()
      .map((c) => [
        when(c.at),
        String(c.venues.reduce((s, v) => s + v.checked, 0)),
        String(c.venues.reduce((s, v) => s + v.opened.length, 0)),
        String(c.venues.reduce((s, v) => s + v.settled.length, 0)),
      ]),
  );
}
function renderResearch() {
  if (!snapshot) return;
  $("learning-summary").innerHTML = VENUES.map((v) => {
    const s = snapshot.studies[v];
    return `<article class="study-box"><h3>${name(v)}</h3><div class="study-numbers"><div><strong>${s.observations}</strong><small>Recorded events</small></div><div><strong>${s.resolved}</strong><small>Resolved</small></div><div><strong>${s.forecasts}</strong><small>Scored forecasts</small></div></div><p>${s.forecasts ? "Model Brier score " + s.brier.toFixed(4) + "; the same-event market baseline is " + s.baselineBrier.toFixed(4) + ". Lower is better." : "There are no validated model forecasts yet. Market outcomes are being recorded before any win-rate claim."}</p></article>`;
  }).join("");
  const research = snapshot.research;
  $("research-report").innerHTML =
    `<section class="research-panel"><h3>Price calibration from recorded outcomes</h3><p>One observation per event in this overview. YES frequency is an outcome statistic, not a betting win rate. Small samples and correlated events limit what it tells us.</p>${
      research
        ? table(
            [
              "Venue / price band",
              "Events",
              "Average market probability",
              "YES frequency",
              "99% interval",
            ],
            research.venues.flatMap((v) =>
              v.bins
                .filter((b) => b.events)
                .map((b) => [
                  `${name(v.venue)} · ${b.label}`,
                  String(b.events),
                  percent(b.baseline * 100),
                  percent(b.frequency * 100),
                  `${percent(b.lower * 100)} to ${percent(b.upper * 100)}`,
                ]),
            ),
          )
        : "<p>Detailed price-bin diagnostics will appear with the next completed research scan.</p>"
    }</section>${archive?.pairedHistory ? `<section class="research-panel"><h3>When an apparent price gap disappears</h3><p>${esc(archive.pairedHistory.summary)}</p><div class="evidence-grid">${stat("Paired historical observations", String(archive.pairedHistory.observations))}${stat("Below $1 before costs", String(archive.pairedHistory.grossPositive))}${stat("Below $1 after modeled costs", String(archive.pairedHistory.netPositive))}</div><p>${esc(archive.pairedHistory.limitations)}</p>${safeLink(archive.pairedHistory.reportUrl, "Read the complete study")}</section>` : ""}`;
  $("earlier-results").innerHTML = archive?.experiments
    ? table(
        ["Experiment", "Recorded result", "Conclusion"],
        archive.experiments.map((r) => [
          esc(r.name),
          esc(r.result),
          esc(r.conclusion),
        ]),
      )
    : '<p class="muted">Historical study summaries are loading.</p>';
}
function renderETF() {
  if (!etf || !etfPaper) {
    $("etf-account").innerHTML = empty(
      "ETF data unavailable",
      "The saved simulation has not been reset. Refresh to retry the dated research and account snapshots.",
    );
    return;
  }
  const a = etfPaper.account,
    base = etf.runs[0];
  $("etf-account").innerHTML = a
    ? `<div class="trade-summary">${stat("Simulated equity", money(a.equity))}${stat("Forward gain / loss", money(a.equity - a.initial))}${stat("Cash", money(a.cash))}${stat("Forward fills", String(etfPaper.ledger.length))}</div><p class="table-note">Account recorded ${when(etfPaper.generatedAt)} · market data through ${esc(etfPaper.sourceAsOf)}. ${etfPaper.error ? esc(etfPaper.error) : etfPaper.pending ? "Next eligible fill: " + esc(etfPaper.pending.eligibleSession) + ". Recorded after the completed daily session." : "Holding the recorded positions until the next monthly decision."}</p>`
    : empty(
        "ETF account unavailable",
        etfPaper.error || "The account has not been reset.",
      );
  $("etf-results").innerHTML =
    `<section class="research-panel"><h3>Historical results, after modeled costs</h3><p>${base.start} to ${base.end}. The fixed monthly rule earned less than buy-and-hold, with a smaller worst drawdown. Historical gains do not establish a future edge.</p><div class="evidence-grid">${stat("Annualized return", percent(base.cagrPct))}${stat("Worst drawdown", percent(base.maxDrawdownPct))}${stat("Final $1,000", money(base.finalEquity))}</div><div id="etf-chart"></div><div class="chart-legend"><span><i class="legend-line" style="background:var(--blue)"></i>Monthly trend</span><span><i class="legend-line" style="background:var(--green)"></i>Five-ETF hold</span><span><i class="legend-line" style="background:var(--amber)"></i>SPY hold</span></div><details class="disclosure"><summary>Cost and timing stress tests</summary>${table(
      ["Scenario", "Annualized", "Worst drawdown", "Final value"],
      etf.runs.map((r) => [
        esc(r.name),
        percent(r.cagrPct),
        percent(r.maxDrawdownPct),
        money(r.finalEquity),
      ]),
    )}<p class="muted">Personal taxes are not modeled as tax lots. Idle cash earns zero. The $5/month operating-cost case loses money. Distribution payment dates are assumptions.</p><p><a href="etf-transactions.csv" download>Download historical transactions</a></p></details></section>`;
  $("etf-results").insertAdjacentHTML("beforeend", etfAudit());
  drawETF();
}
function etfAudit() {
  if (!etfPaper.account) return "";
  const a = etfPaper.account;
  return `<details class="disclosure"><summary>Forward account, transactions and checks</summary><p class="table-note">${money(a?.receivablesUsd)} distributions receivable · ${money(a?.feesUsd)} fees · ${money(a?.slippageUsd)} slippage. Research data through ${esc(etf.sourceAsOf)}.</p>${
    a?.positions?.length
      ? table(
          ["ETF", "Shares", "Value"],
          a.positions.map((p) => [
            esc(p.symbol),
            String(p.qty),
            money(p.value),
          ]),
        )
      : empty(
          "No ETF holdings yet",
          "The next eligible simulated fill is recorded after its completed daily session.",
        )
  }<h3>Recorded forward transactions</h3>${
    etfPaper.ledger.length
      ? table(
          ["Date", "ETF", "Side", "Shares", "Fill / fees"],
          etfPaper.ledger.map((t) => [
            esc(t.date),
            esc(t.symbol),
            esc(t.side),
            String(t.qty),
            money(t.fill) + " / " + money(t.fees),
          ]),
        )
      : '<p class="table-note">No forward fills recorded.</p>'
  }<h3>Validation and remaining steps</h3>${table(
    ["Check", "Recorded status"],
    etfPaper.readiness.map((c) => [
      esc(c.label),
      c.pass ? "Passed" : "Not completed",
    ]),
  )}<p class="table-note">Block-bootstrap historical CAGR interval: ${percent(etf.uncertainty.lowerPct)} to ${percent(etf.uncertainty.upperPct)} from ${etf.uncertainty.samples} samples. Historical sensitivity does not establish future profits.</p><p>${safeLink("https://github.com/srmcno/pm/blob/claude/polymarket-wallets-analysis-m81p4j/reports/etf-research.md", "Full ETF study and uncertainty estimates")}</p></details>`;
}
function drawETF() {
  const host = $("etf-chart");
  if (!host || !etf) return;
  const runs = etf.runs.slice(0, 3),
    width = Math.max(host.clientWidth, 310),
    height = 240,
    left = 54,
    right = 15,
    top = 20,
    bottom = 28,
    max = Math.max(...runs.flatMap((r) => r.curve.map((p) => p.equity))) * 1.05;
  const x = (i) =>
      left + (i / (runs[0].curve.length - 1)) * (width - left - right),
    y = (v) => height - bottom - (v / max) * (height - top - bottom);
  host.innerHTML = `<svg class="equity-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical trend account compared with five-ETF and SPY hold"><title>Historical account equity</title>${[0, 0.5, 1].map((k) => `<line x1="${left}" x2="${width - right}" y1="${y(max * k)}" y2="${y(max * k)}" stroke="var(--line)"/><text x="${left - 8}" y="${y(max * k) + 4}" text-anchor="end">${Math.round(max * k).toLocaleString()}</text>`).join("")}${runs.map((r, j) => `<path d="${r.curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ")}" fill="none" stroke="${["var(--blue)", "var(--green)", "var(--amber)"][j]}" stroke-width="2"/>`).join("")}<text x="${left}" y="${height - 2}">${runs[0].start.slice(0, 4)}</text><text x="${width - right}" y="${height - 2}" text-anchor="end">${runs[0].end.slice(0, 4)}</text></svg>`;
}
function renderHealth() {
  if (!snapshot) return;
  $("health-content").innerHTML =
    snapshot.sources
      .map(
        (s) =>
          `<div class="source-row"><strong>${name(s.venue)} ${badge(s.status === "ok" ? "Source read" : "Source issue", s.status === "ok" ? "" : "caution")}</strong><p>${s.sampled} books sampled from ${s.discovered} discovered contracts. Book collection ${when(s.observedAt)}.</p>${s.error ? `<p>${esc(s.error)}</p>` : ""}</div>`,
      )
      .join("") +
    `<div class="source-row"><strong>Automatic simulation</strong><p>Both venue accounts are checked about every ten minutes, even with this page closed. Scheduled runs can be delayed. Quote and risk checks happen before each simulated entry.</p></div><div class="source-row"><strong>Paired-contract scan</strong><p>${esc(snapshot.arbitrage?.scope?.description || "Upcoming full-game NFL and MLB moneylines. No cross-venue orders.")}</p><p>${snapshot.arbitrage?.errors?.length || 0} recorded collection errors. Last result ${when(snapshot.arbitrage?.generatedAt)}.</p></div>`;
  if (copySnapshot)
    $("health-content").insertAdjacentHTML(
      "afterbegin",
      `<div class="source-row"><strong>Copy trading ${badge(copyStudy ? "Forward simulation" : "Historical record", "caution")}</strong><p>Wallet analytics ${when(copySnapshot.analytics.observedAt)}; consensus and paper ${when(copySnapshot.consensus.observedAt)}. ${copyStudy ? `New forward study observed ${when(copyStudy.generatedAt)}; ${copyStudy.coverage.filter((c) => c.complete).length}/${copyStudy.cohort.length} wallet feeds complete.` : ""} Profiles can separately read recent public wallet activity. Saved wallet stars are local to this browser.</p></div>`,
    );
  if (cryptoSnapshot)
    $("health-content").insertAdjacentHTML(
      "afterbegin",
      `<div class="source-row"><strong>Crypto arbitrage ${badge(cryptoSnapshot.errors.length ? "Source issues" : "Public books recorded")}</strong><p>Last scan ${when(cryptoSnapshot.generatedAt)}; ${cryptoSnapshot.errors.length} source errors. Comparisons share the existing five-minute schedule and never credit profits or place orders.</p></div>`,
    );
  $("health-content").insertAdjacentHTML(
    "beforeend",
    `<details class="disclosure"><summary>Snapshot sources and last checks</summary>${table(
      ["Snapshot", "Loaded from", "Source date"],
      [...publicationHealth].map(([file, h]) => [
        esc(file.replace("data/", "").replace(".json", "")),
        esc(h.source),
        when(h.updatedAt),
      ]),
    )}</details>`,
  );
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  const errors = [];
  const requests = [
    ["data/predictions.json", validPredictions, "Prediction accounts"],
    ["data/etf-research.json", validateResearch, "ETF research"],
    ["data/etf-paper.json", validatePaper, "ETF account"],
    ["data/research-summary.json", validResearchSummary, "Historical research"],
    ["data/copy-trading.json", validCopySnapshot, "Copy trading"],
    ["data/crypto-arbitrage.json", validCryptoSnapshot, "Crypto arbitrage"],
    ["data/crypto-history.json", validCryptoHistory, "Crypto history"],
    ["data/opportunities.json", validSpotSnapshot, "Crypto spot account"],
    ["data/copy-study.json", validCopyStudy, "Forward copy study"],
  ];
  try {
    const results = await Promise.allSettled(
      requests.map(([path, validator]) => publishedJson(path, validator)),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected")
        errors.push(
          requests[i][2] +
            " unavailable. Saved account records have not been reset.",
        );
    });
    if (results[0].status === "fulfilled") snapshot = results[0].value;
    if (results[1].status === "fulfilled") etf = results[1].value;
    if (results[2].status === "fulfilled") etfPaper = results[2].value;
    if (results[3].status === "fulfilled") archive = results[3].value;
    if (results[4].status === "fulfilled") copySnapshot = results[4].value;
    if (results[5].status === "fulfilled") cryptoSnapshot = results[5].value;
    if (results[6].status === "fulfilled") cryptoHistory = results[6].value;
    if (results[7].status === "fulfilled") spotSnapshot = results[7].value;
    if (results[8].status === "fulfilled") copyStudy = results[8].value;
    try {
      if (copySnapshot) renderCopyTrading(copySnapshot, copyStudy);
    } catch {
      errors.push("Copy trading could not display its data. Try refreshing.");
    }
    try {
      renderCryptoTrading(cryptoSnapshot, cryptoHistory, spotSnapshot);
    } catch {
      errors.push("Crypto trading could not display its data. Try refreshing.");
    }
    for (const render of [
      renderPortfolio,
      renderDesk,
      renderTrades,
      renderResearch,
      renderHealth,
    ])
      if (snapshot) {
        try {
          render();
        } catch {
          errors.push(
            "A prediction view could not display its data. Try refreshing.",
          );
        }
      }
    try {
      renderETF();
    } catch {
      errors.push("The ETF view could not display its data. Try refreshing.");
    }
    const retained = requests.filter(([path]) => {
      const h = publicationHealth.get(path);
      return h && h.source !== "repository" && h.source !== "unavailable";
    });
    if (retained.length)
      errors.push(
        `Saved snapshots shown for ${retained.length} sources. See Data status for dates and details.`,
      );
  } catch {
    errors.push("The refresh did not complete. Try again.");
  } finally {
    $("load-notice").textContent = errors.join(" ");
    $("load-notice").hidden = !errors.length;
    $("footer-status").textContent =
      "Each section shows its source date. Display refreshes every minute; accounts remain separate.";
    busy = false;
    $("refresh").disabled = false;
  }
}
function exportTrades() {
  if (!snapshot) return;
  const fields = [
    "venue",
    "id",
    "marketId",
    "question",
    "side",
    "quantity",
    "cost",
    "fees",
    "slippage",
    "payout",
    "pnl",
    "openedAt",
    "closedAt",
  ];
  const rows = VENUES.flatMap((v) =>
    [...snapshot.accounts[v].positions, ...snapshot.accounts[v].trades].map(
      (t) => ({ ...t, venue: v }),
    ),
  );
  const cell = (v) => {
    let s = String(v ?? "");
    if (typeof v === "string" && /^[=+@\-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const csv = [
    fields.join(","),
    ...rows.map((t) => fields.map((f) => cell(t[f])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    a = document.createElement("a");
  a.href = url;
  a.download = "moffitt-prediction-trades.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("export-status").textContent =
    `Exported ${rows.length} recorded trades and positions.`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.desk) {
    desk = b.dataset.desk;
    document
      .querySelectorAll("[data-desk]")
      .forEach((el) => el.setAttribute("aria-pressed", String(el === b)));
    limit = 18;
    renderDesk();
  }
  if (b.dataset.study) {
    study = b.dataset.study;
    document
      .querySelectorAll("[data-study]")
      .forEach((el) => el.setAttribute("aria-pressed", String(el === b)));
    selectStudy(study);
  }
  if (b.dataset.market) inspectMarket(b.dataset.market);
  if (b.dataset.pair) inspectPair(b.dataset.pair);
  if (b.dataset.close) $(b.dataset.close).close();
});
$("theme").addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("mm-theme-v5", next);
  } catch {}
});
$("health-button").addEventListener("click", () => {
  $("health-dialog").showModal();
});
$("refresh").addEventListener("click", refresh);
$("export-trades").addEventListener("click", exportTrades);
$("more").addEventListener("click", () => {
  limit += 18;
  renderDesk();
});
for (const id of ["search", "venue", "sort"])
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    limit = 18;
    renderDesk();
  });
initCopyTrading();
initCryptoTrading();
window.addEventListener("hashchange", route);
window.addEventListener("resize", drawETF);
route();
await refresh();
setInterval(refresh, 60000);
