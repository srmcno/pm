import {forecast, planBet, midpoint, PREDICTION_VERSION} from './prediction-core.mjs';

// A prospective paper experiment, not a validated forecast or live-order policy.
// Frozen separately so historical calibration rows and account ledgers keep their identity.
export const ENTRY_POLICY = Object.freeze({
  version:'2026-09-16-experimental-paper-v1', mode:'paper',
  minCohort:20, minBin:10, marketPriorWeight:10, probabilityBuffer:.03,
  realEnabled:false,
});

export function entryForecast(m, observations, now) {
  const calibration=forecast(m,observations,now);
  const metadata={entryPolicy:ENTRY_POLICY.version, calibration,
    requirements:{cohort:ENTRY_POLICY.minCohort,bin:ENTRY_POLICY.minBin,validation:0}};
  if(calibration.eligible) return {...calibration,...metadata,entryStage:'calibration-screen'};
  const baseline=midpoint(m),unique=new Map();
  for(const o of observations||[]) {
    if(o.version!==PREDICTION_VERSION || o.cohort!==calibration.cohort ||
      typeof o.eventId!=='string' || !o.eventId || o.eventId===m.eventId ||
      !Number.isFinite(o.at) || !Number.isFinite(o.resolvedAt) ||
      o.resolvedAt>now || o.resolvedAt<o.at || ![0,1].includes(o.payout)) continue;
    unique.set(o.eventId,o);
  }
  const history=[...unique.values()],rows=history.filter(o=>o.bin===calibration.bin);
  const enough=Number.isFinite(baseline) && history.length>=ENTRY_POLICY.minCohort && rows.length>=ENTRY_POLICY.minBin;
  // Anchor the small-sample frequency to the current midpoint. The fixed buffer
  // is an experimental decision margin, explicitly NOT a confidence interval.
  const probability=enough?(rows.reduce((n,o)=>n+o.payout,0)+ENTRY_POLICY.marketPriorWeight*baseline)/
    (rows.length+ENTRY_POLICY.marketPriorWeight):null;
  return {...calibration,...metadata,samples:history.length,binSamples:rows.length,
    eligible:enough,probability,
    lower:enough?Math.max(0,probability-ENTRY_POLICY.probabilityBuffer):null,
    upper:enough?Math.min(1,probability+ENTRY_POLICY.probabilityBuffer):null,
    entryStage:enough?'experimental':'warmup'};
}

export function entryPlan(m,side,estimate,account,now) {
  if(account?.mode!=='paper') throw new Error('Experimental entries are paper-only.');
  const plan=planBet(m,side,estimate,account,now);
  if(!estimate.eligible) plan.reasons=plan.reasons.map(reason=>reason.startsWith('Collecting evidence:')?
    `Collecting evidence: paper warmup ${estimate.samples||0}/${ENTRY_POLICY.minCohort} cohort outcomes and ${estimate.binSamples||0}/${ENTRY_POLICY.minBin} similar-price outcomes. Strict validation is tracked separately.`:reason);
  return {...plan,entryStage:estimate.entryStage,entryPolicy:ENTRY_POLICY.version};
}
