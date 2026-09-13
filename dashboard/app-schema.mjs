import { validateAccount, VENUES } from "./prediction-core.mjs";
const finite = Number.isFinite;
const text = (v) => typeof v === "string";
const count = (v) => Number.isInteger(v) && v >= 0;
const array = (value, check) => Array.isArray(value) && value.every(check);
const book = (rows) =>
  array(
    rows,
    (r) =>
      Array.isArray(r) &&
      r.length === 2 &&
      r.every(finite) &&
      r[0] > 0 &&
      r[0] < 1 &&
      r[1] > 0,
  );
function market(m) {
  return (
    m &&
    text(m.id) &&
    VENUES.includes(m.venue) &&
    text(m.question) &&
    text(m.venueId) &&
    ["yes", "no"].every((s) => book(m.sides?.[s]?.asks))
  );
}
function pair(p) {
  return (
    p &&
    text(p.id) &&
    text(p.title) &&
    text(p.league) &&
    finite(p.startAt) &&
    p.executable === false &&
    p.isArbitrage === false &&
    array(p.markets, market) &&
    p.markets.length === 2 &&
    array(p.reasons, text) &&
    text(p.settlement?.reason) &&
    array(
      p.settlement.scenarios,
      (s) => text(s.name) && finite(s.minimum) && finite(s.maximum),
    ) &&
    (!p.best ||
      (["quantity", "cost", "normalNet", "principal", "fees", "slippage"].every(
        (k) => finite(p.best[k]),
      ) &&
        array(
          p.best.legs,
          (l) =>
            VENUES.includes(l.venue) &&
            ["yes", "no"].includes(l.side) &&
            finite(l.quantity) &&
            finite(l.cost),
        )))
  );
}
export function validPredictions(p, now = Date.now() / 1000) {
  try {
    return !!(
      p?.mode === "paper" &&
      p.execution?.realEnabled === false &&
      finite(p.generatedAt) &&
      p.generatedAt <= now + 60 &&
      array(p.markets, market) &&
      array(
        p.decisions,
        (d) => text(d.marketId) && d.plan && array(d.plan.reasons, text),
      ) &&
      array(
        p.sources,
        (s) =>
          VENUES.includes(s.venue) &&
          text(s.status) &&
          count(s.sampled) &&
          count(s.discovered),
      ) &&
      VENUES.every((v) => validateAccount(p.accounts?.[v], v)) &&
      VENUES.every((v) => {
        const s = p.studies?.[v];
        return (
          s &&
          ["observations", "resolved", "forecasts"].every((k) => count(s[k])) &&
          (!s.forecasts || (finite(s.brier) && finite(s.baselineBrier)))
        );
      }) &&
      (!p.automation?.recentCycles ||
        array(
          p.automation.recentCycles,
          (c) =>
            finite(c.at) &&
            array(
              c.venues,
              (v) =>
                count(v.checked) &&
                Array.isArray(v.opened) &&
                Array.isArray(v.settled),
            ),
        )) &&
      (!p.arbitrage ||
        (finite(p.arbitrage.generatedAt) &&
          array(p.arbitrage.pairs, pair) &&
          array(p.arbitrage.errors, (e) => text(e.message)))) &&
      (!p.research ||
        array(
          p.research.venues,
          (v) =>
            VENUES.includes(v.venue) &&
            array(
              v.bins,
              (b) =>
                text(b.label) &&
                count(b.events) &&
                (!b.events ||
                  ["baseline", "frequency", "lower", "upper"].every((k) =>
                    finite(b[k]),
                  )),
            ),
        ))
    );
  } catch {
    return false;
  }
}
export function validResearchSummary(r) {
  return !!(
    r &&
    finite(r.generatedAt) &&
    array(r.experiments, (e) =>
      ["name", "result", "conclusion"].every((k) => text(e[k])),
    ) &&
    (!r.pairedHistory ||
      (["summary", "limitations", "reportUrl"].every((k) =>
        text(r.pairedHistory[k]),
      ) &&
        ["observations", "grossPositive", "netPositive"].every((k) =>
          count(r.pairedHistory[k]),
        )))
  );
}
