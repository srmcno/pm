import {VENUES,advanceAccount,validateAccount} from '../../dashboard/prediction-core.mjs';
import {ENTRY_POLICY,entryForecast,entryPlan} from '../../dashboard/prediction-entry.mjs';

// The scheduled collector is the sole account writer. No browser choice is an input.
export function runPaperCycle(accounts,markets,observations,settlements,now) {
  const working=Object.fromEntries(VENUES.map(venue=>{
    validateAccount(accounts[venue],venue);
    const a=structuredClone(accounts[venue]);
    // A policy migration requires a new confirmation, never a balance reset.
    if(a.entryPolicyVersion!==ENTRY_POLICY.version) a.pending={};
    a.entryPolicyVersion=ENTRY_POLICY.version;
    return [venue,a];
  }));
  const decisions=markets.flatMap(m=>{
    const estimate=entryForecast(m,observations,now);
    return ['yes','no'].map(side=>({marketId:m.id,venue:m.venue,side,forecast:estimate,
      plan:entryPlan(m,side,estimate,working[m.venue],now)}));
  });
  const next=Object.fromEntries(VENUES.map(venue=>[venue,
    advanceAccount(working[venue],markets,decisions,settlements,now)]));
  const describe=p=>({id:p.id,marketId:p.marketId,question:p.question,side:p.side,
    quantity:p.quantity,cost:p.cost,entryPolicy:p.forecast?.entryPolicy||p.version,
    entryStage:p.forecast?.entryStage||'legacy',...(p.closedAt?{payout:p.payout,pnl:p.pnl}:{})});
  const receipt={at:now,entryPolicy:ENTRY_POLICY.version,venues:VENUES.map(venue=>{
    const before=accounts[venue],after=next[venue],rows=decisions.filter(d=>d.venue===venue);
    const known=new Set([...before.positions,...before.trades].map(p=>p.id));
    const closed=new Set(before.trades.map(p=>p.id));
    return {venue,checked:new Set(rows.map(d=>d.marketId)).size,outcomes:rows.length,
      candidates:rows.filter(d=>d.plan.status==='candidate').length,
      experimental:rows.filter(d=>d.forecast.entryStage==='experimental').length,
      pending:Object.keys(after.pending).length,
      opened:after.positions.filter(p=>!known.has(p.id)).map(describe),
      settled:after.trades.filter(p=>!closed.has(p.id)).map(describe),
      cash:after.cash,equity:after.equity,positions:after.positions.length,
      halted:after.halted,markComplete:after.markComplete};
  })};
  return {accounts:next,decisions,receipt};
}
