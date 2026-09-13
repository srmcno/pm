import {VENUES} from './prediction-core.mjs';

// Display facts from the collector's last completed cycle. Never rerun entry
// checks against the browser clock or treat a market inspection as a bot input.
export function automationReport(snapshot, now = Date.now() / 1000) {
  return VENUES.map(venue => {
    const account = snapshot.accounts[venue];
    const source = snapshot.sources.find(s => s.venue === venue);
    const decisions = snapshot.decisions.filter(d => d.venue === venue);
    const receipt = snapshot.automation?.latest?.venues?.find(v => v.venue === venue);
    const pending = decisions.filter(d => account.pending?.[`${d.marketId}:${d.side}`]);
    const reasons = new Map();
    for (const d of decisions) for (const reason of d.plan.reasons || []) {
      const label = reason.startsWith('Collecting evidence:') ? 'More settled outcomes and scored forecasts needed' : reason;
      reasons.set(label, (reasons.get(label) || 0) + 1);
    }
    const delayed = !Number.isFinite(source?.observedAt) || now - source.observedAt > 2700 ||
      now - snapshot.generatedAt > 2700 || source.observedAt > now + 5 || snapshot.generatedAt > now + 5;
    const learning = decisions.length > 0 && decisions.every(d => !d.forecast?.eligible);
    const status = source?.status === 'error' ? 'Source error' : delayed ? 'Collection delayed' :
      account.halted ? 'Risk stop' : source?.status === 'partial' ? 'Partial collection' :
      receipt?.opened.length ? 'Paper entries recorded' : pending.length ? 'Confirming automatic picks' :
      account.positions.length ? 'Managing positions' : learning ? 'Learning before entry' : 'Waiting for a qualifying price';
    return {venue, status, delayed, source, receipt, pending, learning,
      checked: new Set(decisions.map(d => d.marketId)).size, outcomes: decisions.length,
      reasons: [...reasons].sort((a,b) => b[1]-a[1]).slice(0,4),
      candidateCount: decisions.filter(d => d.plan.status === 'candidate').length};
  });
}
