import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validPredictions,
  validResearchSummary,
} from "../dashboard/app-schema.mjs";
const snapshot = JSON.parse(
  await readFile(
    new URL("../dashboard/data/predictions.json", import.meta.url),
    "utf8",
  ),
);
test("the current real prediction snapshot is accepted without inventing missing studies", () => {
  assert.equal(validPredictions(snapshot), true);
});
test("missing study fields, malformed book levels and malformed scan receipts fail validation", () => {
  for (const mutate of [
    (p) => delete p.studies,
    (p) => (p.studies.kalshi.forecasts = 4),
    (p) => (p.markets[0].question = null),
    (p) => (p.markets[0].sides.yes.asks = "bad"),
    (p) => (p.automation.recentCycles[0].venues = null),
    (p) => (p.execution.realEnabled = true),
  ]) {
    const p = structuredClone(snapshot);
    mutate(p);
    assert.equal(validPredictions(p), false);
  }
});
test("malformed paired data cannot enter a renderable snapshot", () => {
  const p = structuredClone(snapshot);
  p.arbitrage = {
    generatedAt: p.generatedAt,
    pairs: [{ id: "bad" }],
    errors: [],
  };
  assert.equal(validPredictions(p), false);
});
test("historical research cards require finite counts and readable conclusions", () => {
  assert.equal(
    validResearchSummary({
      generatedAt: 1,
      experiments: [{ name: "x", result: "x", conclusion: "x" }],
    }),
    true,
  );
  assert.equal(
    validResearchSummary({ generatedAt: 1, experiments: [{}] }),
    false,
  );
});
