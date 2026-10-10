import test from 'node:test';
import assert from 'node:assert/strict';
import {D,S} from '../scripts/live/risk.mjs';
import {legCostBound,feeBound,normalizeAsks,limitFor,bookFresh,evaluatePackage,complementOpportunity,crossVenueOpportunities,
  multiOutcomeOpportunity,classifyMatch,isSports,kalshiBook,polymarketBook,MATCH_CONFIDENCE_ALLOWLIST} from '../scripts/predlive/arb.mjs';

const NOW=1_800_000_000;
export function book({ticker='KXTEST-1',venue='kalshi',yes=[['0.40','10']],no=[['0.50','10']],rate='0.07',age=1,...extra}={}){
  return {venue,ticker,eventTicker:'KXTEST',seriesTicker:'KXTEST',category:'Economics',status:'open',rules:'Rules',ruleHash:'h',closeAt:NOW+86400,
    feeRate:rate,requestAt:NOW-age,receivedAt:NOW-age+0.2,asks:{yes:normalizeAsks(yes),no:normalizeAsks(no)},...extra};
}

test('fee bounds round up like the venues, with documented examples and edge cases',()=>{
  // Kalshi: 0.07 x 1 x 0.50 x 0.50 = 0.0175 -> trade fee rounded up to 0.02.
  assert.equal(S(feeBound(1,'0.5','0.07')),'0.02');
  // Kalshi documented fill: model fee $0.00363825 on $0.055 of revenue moved the balance by $0.06.
  assert.equal(S(feeBound(1,'0.055','0.07')),'0.01');
  assert.ok(legCostBound(1,'0.055','0.07')>=D('0.06'));
  // Polymarket US examples (banker's rounding never exceeds rounding up).
  assert.equal(S(feeBound(1000,'0.10','0.0695')),'6.26');
  assert.equal(S(feeBound(1000,'0.5','0.0695')),'17.38');
  assert.equal(S(feeBound(1000,'0.65','0.0695')),'15.82');
  // Cost bound: principal + cumulative fee rounded up + one cent per-order allowance.
  assert.equal(S(legCostBound(5,'0.4','0.07')),'2.1');
  assert.equal(S(legCostBound(1,'0.5','0')),'0.51');
  // Extreme prices still pay at least a rounded-up cent; tiny fees never round to zero.
  assert.equal(S(feeBound(1,'0.01','0.07')),'0.01');
  assert.equal(S(feeBound(1,'0.99','0.07')),'0.01');
  assert.equal(S(legCostBound(1,'0.99','0.07')),'1.01');
  for(const bad of ['0','1','1.2','-0.1'])assert.throws(()=>legCostBound(1,bad,'0.07'));
  assert.throws(()=>legCostBound(0,'0.5','0.07'));assert.throws(()=>legCostBound(1,'0.5','1'));
  // Monotonic: no better fill price can produce a larger bound.
  for(let p=1;p<99;p++)assert.ok(legCostBound(10,`0.${String(p).padStart(2,'0')}`,'0.07')<=legCostBound(10,`0.${String(p+1).padStart(2,'0')}`,'0.07'));
});

test('depth walking uses whole contracts and the worst needed level',()=>{
  const asks=normalizeAsks([['0.42','2.5'],['0.40','3'],['junk','1'],['1.2','5'],['0.41','0']]);
  assert.deepEqual(asks.map(([p,q])=>[S(p),String(q)]),[['0.4','3'],['0.42','2']]);
  assert.equal(S(limitFor(asks,3)),'0.4');assert.equal(S(limitFor(asks,4)),'0.42');assert.equal(limitFor(asks,6),null);
});

test('no trade when the net edge does not exceed the safety margin',()=>{
  // 0.40 + 0.50 = 0.90 gross; costs per set at size 1: 0.42 + 0.52 = 0.94 -> net 0.05 after 1c margin.
  const ok=complementOpportunity(book(),{now:NOW,margin:'0.01',maxTradeUsd:'25'});
  assert.equal(ok.executable,true);assert.ok(D(ok.evaluation.netEdgePerContract)>0n);
  // Exactly break-even: yes 0.47 + no 0.47 with zero fee rate costs 0.48 + 0.48 (cent allowance each); 0.04 margin -> 0 net.
  const flat=complementOpportunity(book({yes:[['0.47','1']],no:[['0.47','1']],rate:'0'}),{now:NOW,margin:'0.04',maxTradeUsd:'25'});
  assert.equal(flat.evaluation.bestNetEdge,'0');assert.equal(flat.executable,false);assert.match(flat.reasons.join(),/not positive/);
  const loss=complementOpportunity(book({yes:[['0.55','10']],no:[['0.46','10']]}),{now:NOW});
  assert.equal(loss.executable,false);assert.equal(loss.positive,false);
  assert.throws(()=>evaluatePackage([{book:book(),outcome:'yes'},{book:book(),outcome:'no'}],{now:NOW,margin:'0.009'}),/at least one cent/);
});

test('sizing respects depth on every leg, the trade cap and venue cash',()=>{
  const deep=book({yes:[['0.40','100']],no:[['0.50','4']]});
  const o=complementOpportunity(deep,{now:NOW,maxTradeUsd:'25'});
  assert.equal(o.evaluation.quantity,'4');assert.equal(o.legs[0].outcome,'no','scarcer leg first');
  const capped=complementOpportunity(book({yes:[['0.40','100']],no:[['0.50','100']]}),{now:NOW,maxTradeUsd:'5'});
  assert.ok(D(capped.evaluation.costBound)<=D('5'));assert.equal(capped.evaluation.quantity,'5');
  const poor=complementOpportunity(book(),{now:NOW,maxTradeUsd:'25',cash:{kalshi:'0.5'}});
  assert.equal(poor.executable,false);assert.match(poor.reasons.join(),/cash/);
});

test('stale, closed, feeless and future-dated books are refused',()=>{
  assert.equal(bookFresh(book({age:9.9}),NOW),true);
  assert.equal(bookFresh(book({age:10}),NOW),false);
  assert.equal(bookFresh({...book(),receivedAt:NOW+5},NOW),false);
  for(const b of [book({age:11}),book({status:'closed'}),book({rate:null})]){
    const o=complementOpportunity(b,{now:NOW});assert.equal(o.executable,false);
  }
  assert.match(complementOpportunity(book({age:11}),{now:NOW}).reasons.join(),/10 seconds/);
});

test('sports contracts are excluded unless explicitly allowed',()=>{
  for(const b of [book({category:'Sports'}),book({seriesTicker:'KXNFLGAME',ticker:'KXNFLGAME-26OCT11DALNYG-DAL'}),book({sports:true})]){
    assert.equal(isSports(b),true);
    const o=complementOpportunity(b,{now:NOW});assert.equal(o.executable,false);assert.match(o.reasons.join(),/Sports/);
    assert.equal(complementOpportunity(b,{now:NOW,allowSports:true}).executable,true);
  }
  assert.equal(isSports(book()),false);
});

function pair({closeB=NOW+86400,sourcesB=['https://source.example/a']}={}){
  const identity=yesId=>({kind:'full-game-moneyline',provider:'sportradar',league:'mlb',startAt:NOW+7200,participants:['sr:team:000001','sr:team:000002'],yesId});
  const a=book({venue:'polymarket',ticker:'pm-game',yes:[['0.40','10']],no:[['0.61','10']],rate:'0.0695',identity:identity('sr:team:000001'),settlementSources:['https://source.example/a']});
  const b=book({venue:'kalshi',ticker:'KXMLBGAME-X',yes:[['0.62','10']],no:[['0.45','10']],identity:identity('sr:team:000001'),closeAt:closeB,settlementSources:sourcesB});
  return [a,b];
}
test('cross-venue pairs need an exact rule, time and source match',()=>{
  assert.deepEqual(MATCH_CONFIDENCE_ALLOWLIST,['exact']);
  const [a,b]=pair();assert.equal(classifyMatch(a,b),'exact');
  const exact=crossVenueOpportunities(a,b,{now:NOW,allowSports:true,maxTradeUsd:'25'});
  assert.equal(exact.length,2);assert.ok(exact.some(o=>o.executable),'YES 0.40 + NO 0.45 is a locked gap');
  for(const [x,y] of [pair({closeB:NOW+90000}),pair({sourcesB:['https://other.example']}),pair({sourcesB:null})]){
    assert.equal(classifyMatch(x,y),'identity-only');
    const os=crossVenueOpportunities(x,y,{now:NOW,allowSports:true});
    assert.ok(os.every(o=>!o.executable&&!o.locked));assert.match(os[0].reasons.join(),/not allowlisted/);
  }
  const [c,d]=pair();d.identity={...d.identity,startAt:NOW+7300};
  assert.deepEqual(crossVenueOpportunities(c,d,{now:NOW,allowSports:true}),[],'different start time is not a match');
  assert.ok(crossVenueOpportunities(a,b,{now:NOW}).every(o=>!o.executable),'matched games are sports and excluded by default');
});

test('multi-outcome packages require a venue-declared mutually exclusive, reviewed exhaustive event',()=>{
  const markets=['A','B','C'].map(x=>({ticker:`KXWHO-26-${x}`}));
  const books=[book({ticker:'KXWHO-26-A',yes:[['0.30','10']]}),book({ticker:'KXWHO-26-B',yes:[['0.30','10']]}),book({ticker:'KXWHO-26-C',yes:[['0.30','3']]})];
  const event={event_ticker:'KXWHO-26',series_ticker:'KXWHO',mutually_exclusive:true,collateral_return_type:'MECNET',markets};
  const unreviewed=multiOutcomeOpportunity(event,books,{now:NOW});
  assert.equal(unreviewed.executable,false);assert.equal(unreviewed.locked,false);assert.equal(unreviewed.positive,false);assert.equal(unreviewed.rawPositive,true);
  assert.match(unreviewed.reasons.join(),/Exhaustiveness/);
  const reviewed=multiOutcomeOpportunity(event,books,{now:NOW,exhaustiveSeries:['KXWHO'],maxTradeUsd:'25'});
  assert.equal(reviewed.executable,true);assert.equal(reviewed.evaluation.quantity,'3');assert.equal(reviewed.legs[0].ticker,'KXWHO-26-C','scarcest first');
  assert.equal(multiOutcomeOpportunity({...event,mutually_exclusive:false},books,{now:NOW}),null);
  assert.equal(multiOutcomeOpportunity({...event,collateral_return_type:''},books,{now:NOW,exhaustiveSeries:['KXWHO']}).executable,false);
  assert.equal(multiOutcomeOpportunity(event,books.slice(0,2),{now:NOW,exhaustiveSeries:['KXWHO']}).executable,false,'a missing outcome book blocks the package');
  const expensive=books.map(b=>({...b,asks:{...b.asks,yes:normalizeAsks([['0.34','10']])}}));
  assert.equal(multiOutcomeOpportunity(event,expensive,{now:NOW,exhaustiveSeries:['KXWHO']}).executable,false);
});

test('venue normalizers complement bids exactly and keep retrieval times',()=>{
  const k=kalshiBook({market:{ticker:'KXA-1',event_ticker:'KXA',status:'active',market_type:'binary',notional_value_dollars:'1.0000',close_time:'2026-12-01T00:00:00Z'},
    event:{event_ticker:'KXA',series_ticker:'KXA',category:'Economics'},series:{fee_type:'quadratic',fee_multiplier:1},feeChanges:[],
    orderbook:{orderbook_fp:{yes_dollars:[['0.3800','5.00'],['0.4000','7.00']],no_dollars:[['0.5500','2.00'],['0.5700','4.00']]}},requestAt:100,receivedAt:100.4});
  assert.equal(k.status,'open');assert.equal(k.feeRate,'0.07');assert.equal(k.requestAt,100);
  assert.deepEqual(k.asks.yes.map(([p,q])=>[S(p),String(q)]),[['0.43','4'],['0.45','2']]);
  assert.deepEqual(k.asks.no.map(([p,q])=>[S(p),String(q)]),[['0.6','7'],['0.62','5']]);
  assert.equal(kalshiBook({market:{ticker:'KXA-1',status:'active',market_type:'binary',notional_value_dollars:'1'},orderbook:{},requestAt:1,receivedAt:1}).feeRate,null,'unknown fees suppress trading');
  const p=polymarketBook({market:{slug:'will-x',closed:false,status:'MARKET_STATUS_OPEN',feeCoefficient:0.0695,description:'r'},
    book:{marketData:{state:'MARKET_STATE_OPEN',offers:[{px:{value:'0.41'},qty:'3'}],bids:[{px:{value:'0.39'},qty:'8'}]}},requestAt:5,receivedAt:5.1});
  assert.equal(p.status,'open');assert.equal(p.feeRate,'0.0695');assert.equal(S(p.asks.yes[0][0]),'0.41');assert.equal(S(p.asks.no[0][0]),'0.61');
});
