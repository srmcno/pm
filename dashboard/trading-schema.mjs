const finite = Number.isFinite;
const array = (v, fn) => Array.isArray(v) && v.every(fn);
export function validCryptoHistory(d) {
  return !!(
    d?.schemaVersion === 1 &&
    d.realEnabled === false &&
    finite(d.generatedAt) &&
    array(
      d.experiments,
      (e) =>
        e &&
        typeof e.name === "string" &&
        finite(e.observedAt) &&
        e.paper &&
        finite(e.paper.equity) &&
        finite(e.paper.bankrollStart) &&
        finite(e.paper.tradeCount) &&
        array(
          e.paper.trades,
          (t) =>
            t &&
            typeof t.path === "string" &&
            ["sizeUsd", "profitUsd", "t"].every((k) => finite(t[k])),
        ) &&
        e.replay &&
        finite(e.replay.edges) &&
        finite(e.replay.refillable),
    )
  );
}
export function validSpotSnapshot(d) {
  return !!(
    d &&
    finite(d.generatedAt) &&
    d.paper &&
    finite(d.paper.equity) &&
    finite(d.paper.start) &&
    array(
      d.paper.positions,
      (p) =>
        p &&
        typeof p.product === "string" &&
        finite(p.entry) &&
        finite(p.openedAt),
    ) &&
    array(
      d.paper.closed,
      (p) =>
        p &&
        typeof p.product === "string" &&
        finite(p.pnl) &&
        finite(p.entry) &&
        finite(p.openedAt),
    ) &&
    array(
      d.signals,
      (s) =>
        s &&
        typeof s.product === "string" &&
        array(s.reasons, (r) => typeof r === "string"),
    )
  );
}
