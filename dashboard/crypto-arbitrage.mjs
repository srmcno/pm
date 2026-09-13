import {
  $,
  esc,
  money,
  compact,
  pct,
  price,
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
import {
  CRYPTO_ASSETS,
  CRYPTO_MODEL,
  CRYPTO_FEES,
  optimizeCryptoRoute,
  checkCryptoDelay,
  priceCryptoTriangle,
} from "./crypto-arbitrage-core.mjs";
let data,
  history,
  spot,
  tab = "cross",
  routes = [],
  triangles = [];
const venue = (v) => CRYPTO_FEES[v]?.label || v;
const budget = () => Number($("crypto-budget").value);
const rankRoute = (a, b) =>
  ((b.profitableQuantity > 0 ? b.net : b.comparison?.net) ?? -Infinity) -
  ((a.profitableQuantity > 0 ? a.net : a.comparison?.net) ?? -Infinity);
function calculate() {
  routes = [];
  triangles = [];
  if (!data) return;
  // Reprice the recorded snapshot at its original observation time, never at a fabricated live time.
  const options = {
    budget: budget(),
    now: data.evaluatedAt ?? data.generatedAt,
  };
  for (const a of CRYPTO_ASSETS) {
    const cb = data.books.find(
        (b) => b.venue === "coinbase" && b.base === a.base,
      ),
      kr = data.books.find(
        (b) => b.venue === "kraken" && b.base === a.base && b.quote === "USD",
      );
    for (const [buy, sell] of [
      [cb, kr],
      [kr, cb],
    ])
      if (buy && sell) routes.push(optimizeCryptoRoute(buy, sell, options));
  }
  for (const r of routes) {
    const [buy, sell] = r.books.map((b) =>
      data.followUpBooks?.find((n) => n.marketId === b.marketId),
    );
    r.delayCheck = checkCryptoDelay(r, buy, sell, { now: data.generatedAt });
  }
  for (const base of ["ETH", "SOL"]) {
    const find = (base, quote) =>
        data.books.find(
          (b) => b.venue === "kraken" && b.base === base && b.quote === quote,
        ),
      btc = find("BTC", "USD"),
      cross = find(base, "BTC"),
      usd = find(base, "USD");
    if (btc && cross && usd) {
      triangles.push(
        priceCryptoTriangle(
          [
            { book: btc, side: "buy" },
            { book: cross, side: "buy" },
            { book: usd, side: "sell" },
          ],
          options,
        ),
      );
      triangles.push(
        priceCryptoTriangle(
          [
            { book: usd, side: "buy" },
            { book: cross, side: "sell" },
            { book: btc, side: "sell" },
          ],
          options,
        ),
      );
    }
  }
}
function delayLabel(d) {
  return (
    {
      survived: "Positive gap persisted",
      erased: "Gap disappeared",
      "initially-unprofitable": "No initial gap",
      unavailable: "Held after recheck",
    }[d?.status] || "Awaiting recheck"
  );
}
function drawCross() {
  if (!data) return;
  calculate();
  const all = $("crypto-direction").value === "all";
  let rows = routes;
  if (!all)
    rows = CRYPTO_ASSETS.map(
      (a) => routes.filter((r) => r.base === a.base).sort(rankRoute)[0],
    ).filter(Boolean);
  rows = [...rows].sort(rankRoute);
  $("crypto-scan-time").textContent =
    `Books observed ${when(data.generatedAt)} · ${routes.length} directions checked`;
  const priced = routes.filter((r) => Number.isFinite(r.net));
  $("crypto-summary").innerHTML =
    `<div><strong>${priced.filter((r) => r.net > 0).length} modeled gaps after costs</strong><span>${priced.length} priced directions in the recorded scan</span></div><div><strong>Up to ${money(budget())} buy capital</strong><span>Best size within depth, fees and 5 bps per-leg buffer</span></div><div><strong>Coinbase Exchange ↔ Kraken Pro</strong><span>Same crypto asset and USD quote currency</span></div>`;
  $("crypto-cross").innerHTML = rows.length
    ? table(
        [
          "Asset / route",
          "Profitable size",
          "Budget comparison",
          "Fee hurdle",
          "Delayed check",
        ],
        rows.map((r) => {
          const d = r.comparison || r,
            delay = r.delayCheck;
          return [
            `<button class="route-name" data-crypto-route="${esc(r.id)}"><strong>${esc(r.base)}</strong><small>${esc(venue(r.buyVenue))} → ${esc(venue(r.sellVenue))}</small></button>`,
            r.profitableQuantity > 0
              ? `<strong class="positive">${money(r.totalBuyCost)}</strong><small class="cell-note">${price(r.profitableQuantity)} ${r.base} · ${money(r.net)} net</small>`
              : `<strong>${r.candidatesChecked ? "No profitable size" : "Cannot evaluate"}</strong><small class="cell-note">${r.candidatesChecked ? `${r.candidatesChecked} valid sizes checked` : esc(r.reasons[0] || "Book unavailable")}</small>`,
            Number.isFinite(d.net)
              ? `<strong class="${d.net > 0 ? "positive" : "negative"}">${money(d.net)}</strong><small class="cell-note">${d.netBps.toFixed(1)} bps at ${money(d.totalBuyCost)}</small>`
              : badge(d.reasons[0] || "Held", "caution"),
            Number.isFinite(d.requiredGrossBps)
              ? `${d.requiredGrossBps.toFixed(1)} bps<small class="cell-note">${d.grossBps.toFixed(1)} bps recorded gross gap</small>`
              : "—",
            `${esc(delayLabel(delay))}<small class="cell-note">${Number.isFinite(delay?.net) ? `${delay.minDelaySeconds.toFixed(1)}–${delay.maxDelaySeconds.toFixed(1)} sec · same quantity` : "Follow-up not usable"}</small>`,
          ];
        }),
      )
    : empty(
        "No comparable books available",
        "The public sources did not return a valid pair. Source errors are shown below; no profit is credited.",
      );
  $("crypto-source-notice").textContent = data.errors.length
    ? data.errors.map((e) => `${e.source}: ${e.message}`).join(" · ")
    : "Public order-book snapshots. Scheduled observations are not executable quotes.";
  $("crypto-triangles").innerHTML = triangles.length
    ? table(
        [
          "Kraken cycle",
          "Starting USD",
          "Returning USD",
          "Net after costs",
          "Details",
        ],
        triangles.map((t, i) => [
          esc(t.path.join(" → ")),
          money(t.budget),
          money(t.proceeds),
          Number.isFinite(t.net)
            ? `<strong class="${t.net > 0 ? "positive" : "negative"}">${money(t.net)}</strong>`
            : badge("Held", "caution"),
          `<button class="quiet-button" data-crypto-triangle="${i}">Inspect legs</button>`,
        ]),
      )
    : empty(
        "Triangle books unavailable",
        "This scan needs BTC/USD, the crypto/BTC cross and crypto/USD to price every leg.",
      );
  $("crypto-history-scans").innerHTML = data.history?.length
    ? table(
        [
          "Scan time",
          "Priced routes",
          "Profitable routes",
          "Delayed checks",
          "Gaps surviving",
        ],
        [...data.history]
          .reverse()
          .slice(0, 20)
          .map((s) => [
            when(s.at),
            `${s.priced} / ${s.routes}`,
            String(s.positive),
            s.delayedChecked == null
              ? "Earlier model"
              : String(s.delayedChecked),
            s.modelVersion !== CRYPTO_MODEL ? "—" : String(s.survived ?? 0),
          ]),
      )
    : empty(
        "No observation history yet",
        "Future completed scans will appear here.",
      );
}
function showRoute(id) {
  const route = routes.find((r) => r.id === id);
  if (!route) return;
  const r = route.profitableQuantity > 0 ? route : route.comparison || route;
  inspect(
    "Crypto arbitrage · Cost breakdown",
    `<h2>${esc(r.base)}: ${esc(venue(r.buyVenue))} → ${esc(venue(r.sellVenue))}</h2><p class="muted">Book receipts ${r.books.map((b) => `${esc(venue(b.venue))}: ${when(b.receivedAt)}`).join("; ")}</p>${
      Number.isFinite(r.net)
        ? `<div class="trade-summary">${stat("Same quantity on both legs", `${price(r.quantity)} ${r.base}`)}${stat("Net modeled gap", money(r.net), r.net > 0 ? "positive" : "negative")}${stat("Net on buy capital", `${r.netBps.toFixed(1)} bps`)}</div>${table(
            ["Cash flow", "USD"],
            [
              ["Sell proceeds before costs", money(r.sellPrincipal)],
              ["Buy principal", money(-r.buyPrincipal)],
              [`${venue(r.buyVenue)} taker fee`, money(-r.buyFee)],
              [`${venue(r.sellVenue)} taker fee`, money(-r.sellFee)],
              ["Additional slippage buffer", money(-r.slippage)],
              ["Net modeled result", money(r.net)],
            ],
          )}<p class="table-note">${money(r.depthImpact)} of depth impact is already included in the walked prices. It is not charged twice. Requires ${money(r.totalBuyCost)} on the buy venue and ${price(r.quantity)} ${esc(r.base)} on the sell venue.</p>`
        : ""
    }<div class="research-panel"><h3>${route.profitableQuantity > 0 ? "Best net-dollar size" : route.candidatesChecked ? "No profitable size in this book" : "Cannot evaluate this route"}</h3><p>${route.candidatesChecked} valid quantities were compared at depth breakpoints, minimum orders and the budget boundary. ${route.profitableQuantity > 0 ? `The best recorded size uses ${money(route.totalBuyCost)} for ${money(route.net)} modeled net.` : "The cash-flow table shows the selected budget for comparison; it is not an entry."}</p><p>${Number.isFinite(r.requiredGrossBps) ? `This fee model needs a ${r.requiredGrossBps.toFixed(1)} bps gross spread. The recorded spread is ${r.grossBps.toFixed(1)} bps.` : ""} ${Number.isFinite(r.equalFeeCeiling) ? (r.equalFeeCeiling < 0 ? "Even zero fees would not clear the slippage buffer." : `At this quantity, equal taker fees on both venues must each be below ${(r.equalFeeCeiling * 100).toFixed(4)}%.`) : ""}</p></div><div class="research-panel"><h3>${esc(delayLabel(route.delayCheck))}</h3><p>${esc(route.delayCheck?.reason || "No follow-up observation available")}. ${Number.isFinite(route.delayCheck?.net) ? `At the original quantity, net changed from ${money(route.delayCheck.initialNet)} to ${money(route.delayCheck.net)} over ${route.delayCheck.minDelaySeconds.toFixed(1)}–${route.delayCheck.maxDelaySeconds.toFixed(1)} seconds.` : ""}</p></div><p class="notice">${esc(r.reasons.join(". "))}. Account funding, simultaneous fills and later inventory rebalancing are unverified. No orders or simulated profit credits are created by this comparison.</p>${table(
      ["Book", "Best bid", "Best ask", "Quantity minimum", "Fee model"],
      r.books.map((b) => [
        esc(b.marketId),
        price(b.bids[0]?.[0]),
        price(b.asks[0]?.[0]),
        `${price(b.minQuantity)} ${b.base}`,
        pct(b.fee * 100),
      ]),
    )}`,
  );
}
function showTriangle(i) {
  const t = triangles[i];
  if (!t) return;
  inspect(
    "Crypto arbitrage · Three-leg cycle",
    `<h2>${esc(t.path.join(" → "))}</h2><div class="trade-summary">${stat("Start", money(t.budget))}${stat("Modeled return", money(t.proceeds))}${stat("Net", money(t.net), t.net > 0 ? "positive" : "negative")}</div>${table(
      ["Market", "Action", "Quantity", "Fee in quote currency", "Unused input"],
      t.legs.map((l) => [
        esc(l.marketId),
        esc(l.side),
        price(l.quantity),
        `${price(l.fee)} ${esc(l.feeCurrency)}`,
        `${price(l.unspent)} ${esc(l.inputAsset)}`,
      ]),
    )}<p class="notice">${esc(t.reasons.join(". "))}. Each leg walks depth and honors order minimums. Rounding dust has zero modeled liquidation value. These REST snapshots do not establish that three sequential fills will succeed.</p>`,
  );
}
function drawHistory() {
  if (!history) return;
  const depth = history.depthStudy;
  $("crypto-earlier").innerHTML =
    (depth
      ? `<div class="research-panel"><h3>What the earlier scans actually show</h3>${table(
          [
            "Earlier venue",
            "Recorded scans",
            "Positive depth receipts",
            "Top two route share",
            "Screen-to-recheck reduction",
          ],
          depth.map((d) => [
            esc(d.name),
            compact(d.scans),
            `${compact(d.positiveDepthReceipts)} across ${d.distinctRoutes} routes`,
            Number.isFinite(d.topTwoShare) ? pct(d.topTwoShare * 100) : "—",
            Number.isFinite(d.medianDepthDeteriorationBps)
              ? `${d.medianDepthDeteriorationBps.toFixed(1)} bps`
              : "No paired receipts",
          ]),
        )}<p>Kraken’s two leading routes produced 87% of its positive depth receipts. Repeated quotes in the same route do not establish independent wins. This is why the new scan searches size and rechecks the same quantity after a delay.</p><p class="table-note">September 2–8 archives. Changes combine depth, price movement between reads and different trade sizes. Positive receipts were selected by the old model; no full historical depth or synchronized venue timestamps survive. These are not realized fills.</p></div>`
      : "") +
    history.experiments
      .map(
        (e) =>
          `<details class="disclosure"><summary>${esc(e.name)} · saved ${when(e.observedAt)}</summary><p class="notice">Earlier simulation using assumed atomic fills. ${e.name.startsWith("Kraken") ? "Its older fee assumptions are superseded by the current comparison above." : "This international venue collector remains paused."} These modeled credits are not realized trading returns.</p><div class="trade-summary">${stat("Starting model value", money(e.paper.bankrollStart))}${stat("Ending model value", money(e.paper.equity))}${stat("Credited cycles", compact(e.paper.tradeCount))}</div>${table(
            ["Recorded route", "Size", "Modeled profit", "Observed"],
            e.paper.trades
              .slice(0, 25)
              .map((t) => [
                esc(t.path),
                money(t.sizeUsd),
                money(t.profitUsd),
                when(t.t),
              ]),
          )}<p class="table-note">Delayed replay: ${e.replay.edges} edges, ${e.replay.refillable} refillable at the next recorded scan. Positive-cycle selection and atomic fills limit this evidence.</p></details>`,
      )
      .join("");
}
function drawSpot() {
  if (!spot) return;
  const p = spot.paper;
  $("crypto-spot").innerHTML =
    `<div class="research-intro"><h2>Separate crypto spot simulation</h2><p>The existing directional paper account follows Coinbase trend setups. It remains separate from arbitrage comparisons.</p></div><div class="trade-summary">${stat("Paper equity", money(p.equity))}${stat("Starting balance", money(p.start))}${stat("Open positions", p.positions.length)}${stat("Closed trades", p.closed.length)}</div><p class="table-note">Saved ${when(spot.generatedAt)}. This account uses its own recorded entry policy.</p>${table(
      ["Asset", "Setup", "Recorded decision"],
      spot.signals.map((s) => [
        esc(s.product),
        esc(s.strategy),
        esc(s.reasons.join("; ")),
      ]),
    )}<div class="section-heading"><h3>Positions and recent closes</h3><button class="quiet-button" id="export-spot">Export spot trades</button></div>${table(
      ["Asset", "Opened", "Status", "Entry", "Recorded P&L"],
      [
        ...p.positions.map((t) => ({ ...t, state: "Open" })),
        ...p.closed
          .slice(-25)
          .reverse()
          .map((t) => ({ ...t, state: t.reason || "Closed" })),
      ].map((t) => [
        esc(t.product),
        when(t.openedAt),
        esc(t.state),
        money(t.entry),
        money(t.pnl),
      ]),
    )}<p id="spot-export-status" class="table-note" role="status"></p>`;
}
function select(value) {
  tab = value;
  document
    .querySelectorAll("[data-crypto-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.cryptoTab === tab)),
    );
  document
    .querySelectorAll("[data-crypto-panel]")
    .forEach((p) => (p.hidden = p.dataset.cryptoPanel !== tab));
  $("crypto-sizing").hidden = !["cross", "triangles"].includes(tab);
  $("crypto-direction-label").hidden = tab !== "cross";
}
export function renderCryptoTrading(snapshot, earlier, opportunities) {
  if (snapshot) data = snapshot;
  if (earlier) history = earlier;
  if (opportunities) spot = opportunities;
  drawCross();
  drawHistory();
  drawSpot();
  select(tab);
}
export function initCryptoTrading() {
  $("crypto-budget").addEventListener("change", drawCross);
  $("crypto-direction").addEventListener("change", drawCross);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.cryptoTab) select(b.dataset.cryptoTab);
    if (b.dataset.cryptoRoute) showRoute(b.dataset.cryptoRoute);
    if (b.dataset.cryptoTriangle !== undefined)
      showTriangle(Number(b.dataset.cryptoTriangle));
    if (b.id === "export-spot" && spot) {
      const rows = [
        ...spot.paper.positions.map((t) => ({ ...t, status: "open" })),
        ...spot.paper.closed.map((t) => ({ ...t, status: "closed" })),
      ];
      const count = downloadCsv(
        "moffitt-crypto-spot-paper.csv",
        [
          "product",
          "strategy",
          "status",
          "quantity",
          "entry",
          "entryFee",
          "exit",
          "exitFee",
          "pnl",
          "openedAt",
          "closedAt",
          "reason",
        ],
        rows,
      );
      $("spot-export-status").textContent =
        `Exported ${count} spot trades and positions.`;
    }
  });
}
