import test from 'node:test';
import assert from 'node:assert/strict';
import {entryForecast, entryPlan} from '../dashboard/prediction-entry.mjs';
import {forecast, newAccount, advanceAccount, validateAccount, orderIntent, PREDICTION_VERSION} from '../dashboard/prediction-core.mjs';
const now=1789270000;
const market=()=>({id:'kalshi:TEST',venue:'kalshi',venueId:'TEST',eventId:'current',seriesId:'series',question:'Fixture only',rules:'Official fixture',status:'open',quoteAt:now,observedAt:now,closeAt:now+172800,feeRate:.07,minQuantity:1,sides:{yes:{bid:.49,bidSize:100,asks:[[.5,100]]},no:{bid:.49,bidSize:100,asks:[[.5,100]]}}});
function history(m, count=20, wins=15) {
 const f=forecast(m,[],now);
 return Array.from({length:count},(_,i)=>({version:PREDICTION_VERSION,venue:m.venue,eventId:'past'+i,cohort:f.cohort,bin:f.bin,at:now-1000,resolvedAt:now-500,payout:i<wins?1:0,baseline:.495,prediction:null}));
}
test('experimental paper entry can qualify before strict validation without inventing scored forecasts',()=>{
 const m=market(),rows=history(m),before=structuredClone(rows);
 assert.equal(forecast(m,rows,now).eligible,false);
 const f=entryForecast(m,rows,now);
 assert.equal(f.eligible,true);
 assert.equal(f.entryStage,'experimental');
 assert.equal(f.calibration.eligible,false);
 assert.equal(f.validation,0);
 assert.equal(entryPlan(m,'yes',f,newAccount('kalshi',now),now).status,'candidate');
 assert.deepEqual(rows,before);
});
test('empty history, small bins and sparse cohorts still hold paper entries',()=>{
 const m=market();
 for(const rows of [[],history(m,19),history(m).map((o,i)=>({...o,bin:i<9?o.bin:9}))]) {
  const f=entryForecast(m,rows,now);
  assert.equal(f.eligible,false);
  assert.equal(entryPlan(m,'yes',f,newAccount('kalshi',now),now).status,'held');
 }
});
test('experimental history excludes duplicate events, future labels, current event and obsolete versions',()=>{
 const m=market();
 for(const change of [o=>({...o,eventId:'same'}),o=>({...o,resolvedAt:now+1}),o=>({...o,eventId:m.eventId}),o=>({...o,version:'obsolete'}),o=>({...o,at:NaN}),o=>({...o,payout:.5})]) {
  assert.equal(entryForecast(m,history(m).map(change),now).eligible,false);
 }
});
test('freshness, fees, market cutoff, depth and the real execution lock remain enforced',()=>{
 for(const change of [m=>m.quoteAt=now-91,m=>m.feeRate=null,m=>m.closeAt=now+3600,m=>m.sides.yes.bidSize=.01,m=>m.sourceError='offline']) {
  const m=market(),f=entryForecast(m,history(m),now);change(m);
  assert.equal(entryPlan(m,'yes',f,newAccount('kalshi',now),now).status,'held');
 }
 assert.throws(()=>orderIntent(market(),'yes',{quantity:1,limitPrice:.5,cost:.53},'real'),/locked/);
});
test('paper policy opens only after two qualifying scans and preserves accounting through official settlement',()=>{
 const m=market(),f=entryForecast(m,history(m),now),a=newAccount('kalshi',now);
 const d={marketId:m.id,venue:m.venue,side:'yes',forecast:f,plan:entryPlan(m,'yes',f,a,now)};
 const first=advanceAccount(a,[m],[d],{},now);
 assert.equal(first.positions.length,0);assert.equal(first.cash,100);
 const fresh={...m,quoteAt:now+600,observedAt:now+600};
 const second=advanceAccount(first,[fresh],[d],{},now+600);
 assert.equal(second.positions.length,1);assert.ok(second.positions[0].cost<=2);
 assert.equal(a.cash,100);assert.equal(a.positions.length,0);
 const settlement={[m.id]:{yesPayout:.5,observedAt:now+1200,source:'official fixture'}};
 const third=advanceAccount(second,[],[],settlement,now+1200);
 assert.equal(third.positions.length,0);assert.equal(third.trades.length,1);
 validateAccount(third,'kalshi');
 assert.equal(advanceAccount(third,[],[],settlement,now+1800).cash,third.cash);
});
test('favorable raw frequency is not enough when costs erase the buffered experimental edge',()=>{
 const m=market(),f=entryForecast(m,history(m,20,10),now);
 assert.equal(f.eligible,true);
 assert.equal(entryPlan(m,'yes',f,newAccount('kalshi',now),now).status,'held');
 assert.equal(entryPlan(m,'no',f,newAccount('kalshi',now),now).status,'held');
});

test('the scheduled cycle uses experimental entry for both venues and records policy identity',async()=>{
 const {runPaperCycle}=await import('../scripts/predictions/cycle.mjs');
 const markets=['polymarket','kalshi'].map(venue=>({...market(),venue,id:venue+':TEST',eventId:venue+':current'}));
 const accounts=Object.fromEntries(markets.map(m=>[m.venue,newAccount(m.venue,now)]));
 const rows=markets.flatMap(m=>history(m,20,m.venue==='kalshi'?0:20).map(o=>({...o,eventId:m.venue+o.eventId})));
 const original=structuredClone(accounts);
 const first=runPaperCycle(accounts,markets,rows,{},now);
 assert.ok(first.receipt.venues.every(v=>v.pending===1&&v.opened.length===0));
 const fresh=markets.map(m=>({...m,quoteAt:now+600,observedAt:now+600}));
 const second=runPaperCycle(first.accounts,fresh,rows,{},now+600);
 assert.equal(second.accounts.polymarket.positions[0].side,'yes');
 assert.equal(second.accounts.kalshi.positions[0].side,'no');
 assert.ok(second.receipt.venues.every(v=>v.opened.length===1&&v.opened[0].entryStage==='experimental'));
 assert.deepEqual(accounts,original);
});
test('switching the entry policy clears only old pending confirmations, never cash or ledgers',async()=>{
 const {runPaperCycle}=await import('../scripts/predictions/cycle.mjs');
 const accounts=Object.fromEntries(['polymarket','kalshi'].map(v=>[v,newAccount(v,now)]));
 accounts.kalshi.pending['kalshi:TEST:yes']={at:now-600};
 const m=market();
 const result=runPaperCycle(accounts,[m],history(m),{},now);
 assert.equal(result.accounts.kalshi.positions.length,0);
 assert.equal(result.accounts.kalshi.cash,100);
 assert.equal(result.accounts.kalshi.pending['kalshi:TEST:yes'].at,now);
});
