import test from 'node:test';
import assert from 'node:assert/strict';
import {numeric,fee,fill,newAccount,validateAccount,forecast,observe,advanceAccount,planBet,orderIntent,PREDICTION_VERSION} from '../dashboard/prediction-core.mjs';
import {normalizePolymarket,normalizeKalshi,effectiveKalshiFee} from '../scripts/predictions/venues.mjs';
import {runPaperCycle} from '../scripts/predictions/cycle.mjs';
import {automationReport} from '../dashboard/prediction-automation.mjs';
const now=1_789_270_000;
const market=()=>({id:'kalshi:ABC',venue:'kalshi',venueId:'ABC',eventId:'event1',seriesId:'series',question:'Test',rules:'Final source',status:'open',quoteAt:now,observedAt:now,closeAt:now+86400,feeRate:.07,minQuantity:1,sides:{yes:{bid:.49,bidSize:100,asks:[[.5,100]]},no:{bid:.49,bidSize:100,asks:[[.5,100]]}}});
const estimate={eligible:true,probability:.8,lower:.7,upper:.9};
test('missing numeric values never become zero',()=>{for(const x of [null,undefined,'','invalid'])assert.equal(numeric(x),null);assert.equal(numeric('0.0050'),.005);});
test('fills traverse real depth and include per-fill fees and slippage',()=>{assert.deepEqual(fill([[.5,2],[.6,2]],3,.07),{quantity:3,principal:1.6,fees:.06,slippage:.03,cost:1.69,average:.533333,limitPrice:.6});assert.equal(fill([[.5,2]],3,.07),null);assert.equal(fill([[.5,2]],1,null),null);assert.equal(fee(0,.5,1),0);});
test('Polymarket sides come from the single instrument book, not mismatched arrays',()=>{const m=normalizePolymarket({slug:'test',closed:false,status:'MARKET_STATUS_OPEN',feeCoefficient:.06,endDate:new Date((now+86400)*1000).toISOString(),outcomes:'["No","Yes"]',outcomePrices:'[".7",".3"]'},{id:'1'},{marketData:{state:'MARKET_STATE_OPEN',transactTime:new Date(now*1000).toISOString(),bids:[{px:{value:'.4'},qty:'3'}],offers:[{px:{value:'.45'},qty:'8'}],stats:{settlementPx:1}}},now);assert.equal(m.sides.yes.asks[0][0],.45);assert.deepEqual(m.sides.no.asks[0],[.6,3]);assert.equal(m.status,'open');assert.equal(m.settlement,undefined);});
test('Kalshi orderbooks sort bids numerically and complement the opposite side',()=>{const m=normalizeKalshi({ticker:'A',event_ticker:'E',status:'active',notional_value_dollars:'1.0000',market_type:'binary'},{series_ticker:'S'},{fee_type:'quadratic',fee_multiplier:1},[],{orderbook_fp:{yes_dollars:[['.3','10'],['.2','5']],no_dollars:[['.65','20']]}},now);assert.deepEqual(m.sides.yes.asks[0],[.35,20]);assert.deepEqual(m.sides.no.asks[0],[.7,10]);assert.equal(m.feeRate,.07);});
test('fee overrides use only effective changes and null clears the override',()=>{const s={fee_type:'quadratic',fee_multiplier:.5};const changes=[{scheduled_ts:new Date((now-60)*1000).toISOString(),fee_multiplier_override:2},{scheduled_ts:new Date((now+60)*1000).toISOString(),fee_multiplier_override:3}];assert.equal(effectiveKalshiFee(s,changes,now),.14);changes.push({scheduled_ts:new Date(now*1000).toISOString(),fee_multiplier_override:null});assert.equal(effectiveKalshiFee(s,changes,now),.035);assert.equal(effectiveKalshiFee({fee_type:'flat',fee_multiplier:1},[],now),null);});
test('cold start holds cash and creates observations without a paper trade',()=>{const m=market(),a=newAccount('kalshi',now),f=forecast(m,[],now),p=planBet(m,'yes',f,a,now);assert.equal(p.status,'held');assert.equal(f.probability,null);const rows=observe([m,{...m,id:'kalshi:second'}],[],now);assert.equal(rows.length,1);assert.equal(rows[0].prediction,null);assert.equal(advanceAccount(a,[m],[{marketId:m.id,venue:'kalshi',side:'yes',forecast:f,plan:p}],{},now).cash,100);});
test('calibration excludes future labels, other events in same event, and different strategy versions',()=>{const m=market(),key=forecast(m,[],now).cohort;const rows=Array.from({length:120},(_,i)=>({version:PREDICTION_VERSION,eventId:'e'+i,cohort:key,bin:5,at:now-200,resolvedAt:now+1,payout:1,baseline:.5,prediction:.8}));assert.equal(forecast(m,rows,now).samples,0);rows.forEach(o=>o.resolvedAt=now-100);assert.equal(forecast(m,rows,now).samples,120);rows.forEach(o=>o.eventId=m.eventId);assert.equal(forecast(m,rows,now).samples,0);rows.forEach(o=>{o.eventId='x';o.version='old';});assert.equal(forecast(m,rows,now).samples,0);});
test('one independent observation per event, not one per sibling contract',()=>{const m=market(),row={version:PREDICTION_VERSION,eventId:'other',cohort:forecast(m,[],now).cohort,bin:5,at:now-200,resolvedAt:now-100,payout:1};assert.equal(forecast(m,Array(150).fill(row),now).samples,1);});
test('paper entry needs two scans; accounting settles exactly once, including fractional payouts',()=>{const m=market(),a=newAccount('kalshi',now),d={marketId:m.id,venue:m.venue,side:'yes',forecast:estimate,plan:planBet(m,'yes',estimate,a,now)};let b=advanceAccount(a,[m],[d],{},now);assert.equal(b.positions.length,0);const later={...m,quoteAt:now+600,observedAt:now+600};b=advanceAccount(b,[later],[d],{},now+600);assert.equal(b.positions.length,1);assert.ok(b.positions[0].cost<=2);assert.equal(b.cash,100-b.positions[0].cost);const pos=b.positions[0];b=advanceAccount(b,[],[],{[m.id]:{yesPayout:.5,observedAt:now+1000,source:'official'}},now+1000);assert.equal(b.positions.length,0);assert.equal(b.trades[0].payout,pos.quantity*.5);const cash=b.cash;b=advanceAccount(b,[],[],{[m.id]:{yesPayout:.5,observedAt:now+1000,source:'official'}},now+1200);assert.equal(b.cash,cash);validateAccount(b,'kalshi');});
test('stale quotes, missing fees, tiny bid depth, and halted books cannot open entries',()=>{for(const mutate of [m=>m.sourceError="refresh failed",m=>m.quoteAt=now-91,m=>m.feeRate=null,m=>m.sides.yes.bidSize=.01,m=>m.quoteAt=now+10]){const m=market();mutate(m);assert.equal(planBet(m,'yes',estimate,newAccount('kalshi',now),now).status,'held');}const a=newAccount('kalshi',now);a.halted=true;assert.equal(planBet(market(),'yes',estimate,a,now).status,'held');});
test('malformed cash records, NaN peaks, and invalid positions fail closed',()=>{for(const mutate of [a=>a.cash=99,a=>a.peak=NaN,a=>a.fees=-1,a=>a.pending.x={at:'now'},a=>a.positions.push({cost:undefined})]){const a=newAccount('kalshi',now);mutate(a);assert.throws(()=>validateAccount(a,'kalshi'));}});
test('real execution cannot be activated by a mode flag',()=>{assert.throws(()=>orderIntent(market(),'yes',{quantity:1,limitPrice:.5,cost:.53},'real'),/locked/);assert.equal(orderIntent(market(),'yes',{quantity:1,limitPrice:.5,cost:.53}).mode,'paper');});
test('sports entry cutoff precedes delayed contractual expiry and uses official game routes',()=>{
  const start=new Date((now+3600)*1000).toISOString(),expiry=new Date((now+14*86400)*1000).toISOString();
  const m=normalizePolymarket({slug:'game-a',closed:false,status:'MARKET_STATUS_OPEN',feeCoefficient:.06,endDate:expiry,gameStartTime:start,sportsMarketTypeV2:'SPORTS_MARKET_TYPE_MONEYLINE',marketSides:[{long:true,team:{league:'nfl'}}]},{id:'event',slug:'game'}, {marketData:{state:'MARKET_STATE_OPEN',transactTime:new Date(now*1000).toISOString(),bids:[{px:{value:'.49'},qty:'100'}],offers:[{px:{value:'.5'},qty:'100'}]}},now);
  assert.equal(m.closeAt,now+3600);assert.equal(m.expiryAt,now+14*86400);assert.match(m.url,/sports\/nfl\/game\?marketSlug=game-a/);
  assert.ok(planBet({...m,rules:'rules'},'yes',estimate,newAccount('polymarket',now),now).reasons.some(r=>r.includes('6 hours')));
});

test('the collector chooses both venues and opposite sides, opens and settles with no browser input',()=>{
  const markets=['polymarket','kalshi'].map(venue=>({...market(),venue,id:venue+':AUTO',venueId:'AUTO',eventId:venue+':event',closeAt:now+172800}));
  const accounts=Object.fromEntries(markets.map(m=>[m.venue,newAccount(m.venue,now)]));
  // Synthetic historical evidence exercises automation, not a performance claim.
  const history=markets.flatMap(m=>Array.from({length:120},(_,i)=>({version:PREDICTION_VERSION,
    venue:m.venue,eventId:m.venue+':past'+i,cohort:forecast(m,[],now).cohort,bin:forecast(m,[],now).bin,
    at:now-1000,resolvedAt:now-500,payout:m.venue==='polymarket'?1:0,
    baseline:.5,prediction:m.venue==='polymarket'?.9:.1})));
  const initial=structuredClone(accounts);
  const first=runPaperCycle(accounts,markets,history,{},now);
  assert.deepEqual(accounts,initial);
  assert.equal(first.decisions.length,4);
  assert.deepEqual(first.receipt.venues.map(v=>[v.pending,v.opened.length]),[[1,0],[1,0]]);
  const fresh=markets.map(m=>({...m,quoteAt:now+600,observedAt:now+600}));
  const second=runPaperCycle(first.accounts,fresh,history,{},now+600);
  assert.equal(second.accounts.polymarket.positions[0].side,'yes');
  assert.equal(second.accounts.kalshi.positions[0].side,'no');
  for(const v of second.receipt.venues){assert.equal(v.opened.length,1);assert.equal(v.pending,0);assert.ok(v.opened[0].cost<=2);assert.equal(v.cash,100-v.opened[0].cost);}
  const snapshot={generatedAt:now+600,accounts:second.accounts,markets:fresh,decisions:second.decisions,
    sources:markets.map(m=>({venue:m.venue,status:'ok',observedAt:now+600})),automation:{latest:second.receipt}};
  // Ordinary between-scan quote expiry must not report a feed outage or ask for a pick.
  assert.ok(automationReport(snapshot,now+1200).every(r=>r.status==='Paper entries recorded'&&!r.delayed&&r.pending.length===0));
  assert.ok(automationReport(snapshot,now+3301).every(r=>r.status==='Collection delayed'));
  const settlements=Object.fromEntries(markets.map(m=>[m.id,{yesPayout:m.venue==='polymarket'?1:0,observedAt:now+1500,source:'official fixture'}]));
  const third=runPaperCycle(second.accounts,[],history,settlements,now+1500);
  for(const v of third.receipt.venues){assert.equal(v.settled.length,1);assert.equal(v.positions,0);validateAccount(third.accounts[v.venue],v.venue);}
  const fourth=runPaperCycle(third.accounts,[],history,settlements,now+2100);
  assert.ok(fourth.receipt.venues.every(v=>v.settled.length===0));
  assert.equal(fourth.accounts.kalshi.cash,third.accounts.kalshi.cash);
});

test('automatic cold start holds cash, reports learning, and never needs a manual venue choice',()=>{
  const markets=['polymarket','kalshi'].map(venue=>({...market(),venue,id:venue+':COLD'}));
  const accounts=Object.fromEntries(markets.map(m=>[m.venue,newAccount(m.venue,now)]));
  const cycle=runPaperCycle(accounts,markets,[],{},now);
  const snapshot={generatedAt:now,accounts:cycle.accounts,markets,decisions:cycle.decisions,
    sources:markets.map(m=>({venue:m.venue,status:'ok',observedAt:now}))};
  for(const r of automationReport(snapshot,now+600)){
    assert.equal(r.status,'Learning before entry');assert.equal(r.checked,1);assert.equal(r.outcomes,2);
    assert.equal(cycle.accounts[r.venue].cash,100);assert.equal(r.pending.length,0);
    assert.ok(r.reasons.some(([reason])=>reason.includes('More settled outcomes')));
  }
  snapshot.sources[0].status='error';
  assert.equal(automationReport(snapshot,now+600)[0].status,'Source error');
});
