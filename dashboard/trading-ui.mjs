export const $ = (id) => document.getElementById(id);
export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const money = (v) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";
export const compact = (v) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      })
    : "—";
export const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "—");
export const when = (v) =>
  Number.isFinite(v)
    ? new Date(v * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
export const price = (v) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", { maximumFractionDigits: 6 })
    : "—";
export const badge = (label, kind = "") =>
  `<span class="status ${kind}">${esc(label)}</span>`;
export const stat = (label, value, kind = "") =>
  `<div class="stat"><small>${esc(label)}</small><strong class="${kind}">${esc(value)}</strong></div>`;
export const empty = (title, description) =>
  `<div class="empty"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
export const table = (heads, rows) =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
export const reportLink = (file, label) =>
  `<a href="https://github.com/srmcno/pm/blob/claude/polymarket-wallets-analysis-m81p4j/reports/${encodeURIComponent(file)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
export function inspect(label, html) {
  $("inspector-label").textContent = label;
  $("inspector-content").innerHTML = html;
  if (!$("inspector").open) $("inspector").showModal();
}
export function curve(points, label, { currency = true } = {}) {
  if (points.length < 2)
    return '<p class="table-note">No comparable history recorded.</p>';
  const min = Math.min(...points.map((p) => p[1])),
    max = Math.max(...points.map((p) => p[1])),
    span = max - min || 1;
  const start = points[0][0],
    end = points.at(-1)[0],
    x = (p) => 60 + ((p[0] - start) / (end - start || 1)) * 570,
    y = (p) => 185 - ((p[1] - min) / span) * 160;
  const format = (v) => (currency ? money(v) : pct(v));
  return `<svg class="trading-chart" viewBox="0 0 650 220" role="img" aria-label="${esc(label)}"><title>${esc(label)}; ${esc(format(points[0][1]))} to ${esc(format(points.at(-1)[1]))}</title>${[0, 0.5, 1].map((k) => `<line x1="60" x2="630" y1="${185 - k * 160}" y2="${185 - k * 160}" stroke="var(--line)"/><text x="52" y="${190 - k * 160}" text-anchor="end">${esc(compact(min + k * span))}</text>`).join("")}<path d="${points.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(2)},${y(p).toFixed(2)}`).join(" ")}" fill="none" stroke="var(--blue)" stroke-width="2.5"/>${points.map((p) => `<circle cx="${x(p)}" cy="${y(p)}" r="3" fill="transparent"><title>${esc(when(p[0]))}: ${esc(format(p[1]))}</title></circle>`).join("")}<text x="60" y="212">${esc(new Date(start * 1000).toLocaleDateString())}</text><text x="630" y="212" text-anchor="end">${esc(new Date(end * 1000).toLocaleDateString())}</text></svg>`;
}
export function downloadCsv(filename, fields, rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (typeof v === "string" && /^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const csv = [
    fields.map(cell).join(","),
    ...rows.map((r) => fields.map((f) => cell(r[f])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return rows.length;
}
