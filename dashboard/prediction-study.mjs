import { PREDICTION_VERSION, VENUES, wilson } from "./prediction-core.mjs";
const finite = Number.isFinite;
export function studyOutcomes(observations, now) {
  const valid = observations.filter(
    (o) =>
      o.version === PREDICTION_VERSION &&
      typeof o.eventId === "string" &&
      finite(o.at) &&
      o.at <= now &&
      finite(o.baseline) &&
      o.baseline > 0 &&
      o.baseline < 1 &&
      finite(o.resolvedAt) &&
      o.resolvedAt >= o.at &&
      o.resolvedAt <= now &&
      [0, 1].includes(o.payout),
  );
  return {
    generatedAt: now,
    method:
      "Earliest recorded observation per venue/event in overview; unique events within each cohort.",
    venues: VENUES.map((venue) => {
      const rows = valid
          .filter((o) => o.venue === venue)
          .sort((a, b) => a.at - b.at),
        unique = new Map();
      for (const o of rows)
        if (!unique.has(o.eventId)) unique.set(o.eventId, o);
      const events = [...unique.values()],
        cohorts = new Map();
      for (const o of rows) {
        if (!cohorts.has(o.cohort)) cohorts.set(o.cohort, new Map());
        cohorts.get(o.cohort).set(o.eventId, o);
      }
      return {
        venue,
        resolvedEvents: events.length,
        cohorts: cohorts.size,
        largestCohort: Math.max(0, ...[...cohorts.values()].map((c) => c.size)),
        bins: Array.from({ length: 10 }, (_, i) => {
          const xs = events.filter(
              (o) => Math.min(9, Math.floor(o.baseline * 10)) === i,
            ),
            wins = xs.reduce((n, o) => n + o.payout, 0),
            interval = wilson(wins, xs.length);
          return {
            label: `${i * 10}–${i * 10 + 10}%`,
            events: xs.length,
            yesOutcomes: wins,
            baseline: xs.length
              ? xs.reduce((n, o) => n + o.baseline, 0) / xs.length
              : null,
            frequency: xs.length ? wins / xs.length : null,
            lower: interval.lower,
            upper: interval.upper,
          };
        }),
      };
    }),
  };
}
