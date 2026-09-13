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
  CRYPTO_FEES,
  compareCryptoBooks,
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
function calculate() {
  routes = [];
  triangles = [];
  if (!data) return;
  // Reprice the recorded snapshot at its original observation time, never at a fabricated live time.
  const options = { budget: budget(), now: data.generatedAt };
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
      if (buy && sell) routes.push(compareCryptoBooks(buy, sell, options));
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
function drawCross() {
  if (!data) return;
  calculate();
  const all = $("crypto-direction").value === "all";
  let rows = routes;
  if (!all)
    rows = CRYPTO_ASSETS.map(
      (a) =>
        routes
          .filter((r) => r.base === a.base)
          .sort((a, b) => (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity))[0],
    ).filter(Boolean);
  rows = [...rows].sort(
    (a, b) => (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity),
  );
  $("crypto-scan-time").textContent =
    `Books observed ${when(data.generatedAt)} · ${routes.length} directions checked`;
  const priced = routes.filter((r) => Number.isFinite(r.net));
  $("crypto-summary").innerHTML =
    `<div><strong>${priced.filter((r) => r.net > 0).length} modeled gaps after costs</strong><span>${priced.length} priced directions in the recorded scan</span></div><div><strong>${money(budget())} comparison size</strong><span>Walked depth and 5 bps slippage on each leg</span></div><div><strong>Coinbase Exchange ↔ Kraken Pro</strong><span>Same crypto asset and USD quote currency</span></div>`;
  $("crypto-cross").innerHTML = rows.length
    ? table(
        [
          "Asset / route",
          "Buy average",
          "Sell average",
          "Fees + buffer",
          "Net after costs",
        ],
        rows.map((r) => [
          `<button class="route-name" data-crypto-route="${esc(r.id)}"><strong>${esc(r.base)}</strong><small>${esc(venue(r.buyVenue))} → ${esc(venue(r.sellVenue))}</small></button>`,
          Number.isFinite(r.buyPrice) ? `$${price(r.buyPrice)}` : "—",
          Number.isFinite(r.sellPrice) ? `$${price(r.sellPrice)}` : "—",
          money(r.buyFee + r.sellFee + r.slippage),
          Number.isFinite(r.net)
            ? `<strong class="${r.net > 0 ? "positive" : "negative"}">${money(r.net)}</strong><small class="cell-note">${r.netBps.toFixed(1)} bps</small>`
            : badge(r.reasons[0] || "Held", "caution"),
        ]),
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
        ["Scan time", "Priced routes", "Positive modeled gaps", "Best net gap"],
        [...data.history]
          .reverse()
          .slice(0, 20)
          .map((s) => [
            when(s.at),
            `${s.priced} / ${s.routes}`,
            String(s.positive),
            Number.isFinite(s.bestNetBps)
              ? `${s.bestNetBps.toFixed(1)} bps`
              : "Not priced",
          ]),
      )
    : empty(
        "No observation history yet",
        "Future completed scans will appear here.",
      );
}
function showRoute(id) {
  const r = routes.find((r) => r.id === id);
  if (!r) return;
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
    }<p class="notice">${esc(r.reasons.join(". "))}. Account funding, simultaneous fills and later inventory rebalancing are unverified. No orders or simulated profit credits are created by this comparison.</p>${table(
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
  $("crypto-earlier").innerHTML = history.experiments
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
