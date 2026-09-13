import {VENUES,forecast,planBet,advanceAccount} from '../../dashboard/prediction-core.mjs';

// The scheduled collector is the sole account writer. Both venues and both
// outcomes are always evaluated, with no browser selection or manual forecast.
export function runPaperCycle(accounts, markets, observations, settlements, now) {
  const decisions = markets.flatMap(m => {
    const estimate = forecast(m, observations, now);
    return ['yes','no'].map(side => ({marketId:m.id,venue:m.venue,side,forecast:estimate,
      plan:planBet(m,side,estimate,accounts[m.venue],now)}));
  });
  const next = Object.fromEntries(VENUES.map(venue => [venue,
    advanceAccount(accounts[venue],markets,decisions,settlements,now)]));
  const describe = p => ({id:p.id,marketId:p.marketId,question:p.question,side:p.side,
    quantity:p.quantity,cost:p.cost,...(p.closedAt ? {payout:p.payout,pnl:p.pnl} : {})});
  const receipt = {at:now,venues:VENUES.map(venue => {
    const before = accounts[venue],after = next[venue],rows = decisions.filter(d => d.venue === venue);
    const known = new Set([...before.positions,...before.trades].map(p => p.id));
    const closed = new Set(before.trades.map(p => p.id));
    return {venue,checked:new Set(rows.map(d => d.marketId)).size,outcomes:rows.length,
      candidates:rows.filter(d => d.plan.status === 'candidate').length,
      pending:Object.keys(after.pending).length,
      opened:after.positions.filter(p => !known.has(p.id)).map(describe),
      settled:after.trades.filter(p => !closed.has(p.id)).map(describe),
      cash:after.cash,equity:after.equity,positions:after.positions.length,
      halted:after.halted,markComplete:after.markComplete};
  })};
  return {accounts:next,decisions,receipt};
}
