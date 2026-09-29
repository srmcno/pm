import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat,utimes,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as core from '../dashboard/listing-watch-core.mjs';
import {collectListingWatch,runListingWatch,listingWatchPaths,summarize} from '../scripts/collect-listing-watch.mjs';
import {listingWatchPanel,describeTransition,studyBox,sourceRow,watchRecord,LISTING_WATCH_TITLE} from '../dashboard/listing-watch-ui.mjs';

const {initialListingWatch:initial,applyExchange,applyBrokerage,applyIncidents,recordSourceFailure,isAvoid,avoidReasons,LIMITS}=core;
// Synthetic fixtures shaped like the real public responses. They are tests, not market evidence.
const T0=1790700000,DAY=86400; // T0 is minute-aligned
const rec=(id,over={})=>({id,base_currency:id.split('-')[0],quote_currency:id.split('-')[1],status:'online',status_message:'',trading_disabled:false,cancel_only:false,post_only:false,limit_only:false,auction_mode:false,...over});
const universe=(n=60)=>Array.from({length:n},(_,i)=>rec(`C${i}-USD`));
const broker=(id,over={})=>({product_id:id,quote_currency_id:'USD',product_type:'SPOT',new:false,is_disabled:false,view_only:false,new_at:'2023-01-01T00:00:00Z',...over});
const brokerUniverse=(n=60)=>[...Array.from({length:n},(_,i)=>broker(`C${i}-USD`)),broker('C0-USDC',{quote_currency_id:'USDC'})];
const iso=t=>new Date(t*1000).toISOString();
const stamp=t=>new Date(t*1000).toISOString();
const update=(id,body,at,status='monitoring')=>({id,status,body,created_at:stamp(at),updated_at:stamp(at),incident_id:'x'});
const incident=(id,name,status,updates)=>({id,name,status,created_at:stamp(T0-DAY),impact:'none',shortlink:'https://stspg.io/x',incident_updates:updates});

const AUCTION='Our BLUECHIP-USD trading pair will now enter auction mode. Customers can post limit orders and view the resulting indicative open price. The books will be in auction mode for a minimum of 10 minutes during which no matches will occur.';
const LIMIT='Our BLUECHIP-USD trading pair will now enter limit-only mode on Coinbase Exchange and Coinbase Advanced. Limit orders can be placed and canceled, and matches may occur. Market orders cannot be submitted.';
const FULL='Our BLUECHIP-USD trading pair is in full-trading mode on Coinbase Exchange and Coinbase Advanced. Limit, market and stop orders are all now available.';
const NOTICE='We regularly monitor the assets on our exchange to ensure they meet our listing standards. Based on recent reviews, we will suspend trading for Badger DAO (BADGER) & Storj (STORJ) on 28 September 2026 on or around 2 PM ET.';
const EXECUTED='We have disabled trading for Badger DAO (BADGER) & Storj (STORJ). Your funds will remain accessible to you.';
const listingIncident=()=>incident('gddybkkhntp7','BLUECHIP-USD Markets Open','resolved',[
  update('u6','This incident has been resolved.',T0+5*DAY,'resolved'),update('u5',FULL,T0+3*DAY),
  update('u4','BLUE CHIP (BLUECHIP) is now live on coinbase.com and in the Coinbase app.',T0+3600),update('u3',LIMIT,T0+3000),
  update('u2',AUCTION,T0+1800),update('u1','Spot trading for BLUE CHIP (BLUECHIP) will go live on 16 September 2026. The opening of our BLUECHIP-USD trading pair will begin later today.',T0)]);
const suspensionIncident=(status='monitoring',withExecuted=true)=>incident('bczrbdtb1fd5','Upcoming Trading Suspension: BADGER-USD and STORJ-USD',status,[
  ...(withExecuted?[update('e2',EXECUTED,T0+30*DAY)]:[]),update('e1',NOTICE,T0)]);
const noise=()=>incident('hpwtyv47697c','Delayed Sends/Receives - SUI','investigating',[update('n1','We are aware that users are experiencing delayed sends and receives of SUI.',T0)]);

// ------------------------------------------------------------ baseline & launches
test('the first read is a baseline: no launches, no transitions, execution lock kept',()=>{
  let s=initial(T0);
  assert.equal(s.realEnabled,false);assert.equal(s.mode,'observation');assert.equal(s.policyId,core.POLICY_ID);
  const r=applyExchange(s,universe(),T0);s=r.state;
  assert.equal(r.stats.baseline,true);assert.equal(r.stats.count,60);assert.deepEqual(r.stats.newProducts,[]);
  assert.equal(s.exchange.baselineAt,T0);assert.equal(s.counters.launches,0);assert.equal(s.transitions.length,0);
  assert.equal(s.exchange.products['C1-USD'].baseline,true);assert.equal(s.sources.exchange.lastOkAt,T0);
  const b=applyBrokerage(s,[...brokerUniverse(),broker('OLD-USD',{new_at:'2026-01-02T03:04:05.000Z'})],T0+1);
  assert.equal(b.stats.count,61,'only USD products are tracked; the USDC row is ignored, not a parse failure');assert.equal(b.stats.skipped,0);
  assert.equal(b.state.brokerage.products['C1-USD'].newAt,undefined,'the 2023-01-01 placeholder is not a listing time');
  assert.equal(b.state.brokerage.products['OLD-USD'].newAt,Date.parse('2026-01-02T03:04:05.000Z')/1000);
  assert.equal(b.state.counters.launches,0);
  assert.doesNotThrow(()=>core.validateListingWatch(b.state));
});

test('a product first seen after the baseline is a launch; phases carry read intervals and start the 24 hour window',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('NEWA-USD',{auction_mode:true})],T0+300).state;
  const l=s.launches['NEWA-USD'];
  assert.equal(l.kind,'asset-launch');assert.equal(l.firstSeenAt,T0+300);assert.equal(l.firstSeenSince,T0);assert.equal(l.firstSeenSource,'exchange');
  assert.deepEqual(l.phases,[{phase:'auction',at:T0+300,since:T0}]);assert.equal(l.tradingObservedAt,null);assert.equal(l.candles.status,'pending');
  assert.deepEqual(s.transitions[0],{id:'NEWA-USD',src:'exchange',at:T0+300,since:T0,field:'first-seen',from:null,to:'auction'});
  assert.equal(s.counters.launches,1);
  s=applyExchange(s,[...universe(),rec('NEWA-USD',{limit_only:true})],T0+600).state;
  const m=s.launches['NEWA-USD'];
  assert.deepEqual(m.phases.map(p=>p.phase),['auction','limit-only']);assert.deepEqual(m.phases[1],{phase:'limit-only',at:T0+600,since:T0+300});
  assert.equal(m.tradingObservedAt,T0+600);assert.equal(m.tradingSince,T0+300);
  assert.equal(m.candles.status,'collecting');assert.equal(m.candles.windowStart,T0+300,'the window opens at the last read that still saw the auction');
  assert.equal(m.candles.windowEnd,T0+600+DAY);
  const fields=s.transitions.slice(0,2).map(t=>[t.field,t.from,t.to,t.since,t.at]).sort();
  assert.deepEqual(fields,[['auction_mode',true,false,T0+300,T0+600],['limit_only',false,true,T0+300,T0+600]]);
  s=applyExchange(s,[...universe(),rec('NEWA-USD')],T0+900).state;
  assert.deepEqual(s.launches['NEWA-USD'].phases.map(p=>p.phase),['auction','limit-only','full']);
  assert.equal(s.launches['NEWA-USD'].tradingObservedAt,T0+600,'first non-auction state is never overwritten');
  assert.equal(s.counters.launches,1);
});

test('a launch first seen already trading opens its window after the previous read',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('NEWB-USD')],T0+300).state;
  const l=s.launches['NEWB-USD'];
  assert.equal(l.tradingObservedAt,T0+300);assert.equal(l.tradingSince,T0);assert.equal(l.candles.windowStart,T0);assert.equal(l.candles.windowEnd,T0+300+DAY);
});

test('new pairs of a live asset and non-USD launches are logged but get no candle capture',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('C1-EUR'),rec('NEWC-USDT'),rec('NEWC-EUR')],T0+300).state;
  assert.equal(s.launches['C1-EUR'].kind,'new-pair');assert.equal(s.launches['C1-EUR'].candles.status,'skipped');assert.match(s.launches['C1-EUR'].candles.reason,/already trades/);
  assert.equal(s.launches['NEWC-USDT'].kind,'asset-launch');assert.equal(s.launches['NEWC-USDT'].candles.status,'skipped');assert.match(s.launches['NEWC-USDT'].candles.reason,/non-USD/);
  assert.equal(core.planCandleRequests(s,T0+9000).length,0);
  // Both pairs of a brand-new asset are launches regardless of which source is applied first.
  s=applyBrokerage(s,brokerUniverse(),T0+301).state; // brokerage baseline
  const known=core.liveBases(s);
  const both=applyBrokerage(applyExchange(s,[...universe(),rec('NEWD-USD'),rec('NEWD-USDC')],T0+600,{knownBases:known}).state,[...brokerUniverse(),broker('NEWD-USD',{new:true})],T0+601,{knownBases:known}).state;
  assert.equal(both.launches['NEWD-USD'].kind,'asset-launch');assert.equal(both.launches['NEWD-USDC'].kind,'asset-launch');
  assert.deepEqual(Object.keys(both.launches['NEWD-USD'].seenAt).sort(),['brokerage','exchange']);
});

test('a launch already in progress when collection starts is adopted and flagged; its remaining phases and window are observed',()=>{
  // Real launches sit in the Exchange list cancel-only, flagged new by Advanced Trade, before their auction.
  const feed=[...universe(),rec('CTX-USD',{cancel_only:true})],bk=[...brokerUniverse(),broker('CTX-USD',{new:true,new_at:stamp(T0-3600)})];
  let s=applyExchange(initial(T0),feed,T0).state;
  assert.equal(s.counters.launches,0,'Advanced Trade evidence is not known yet');
  s=applyBrokerage(s,bk,T0+1).state;
  const l=s.launches['CTX-USD'];
  assert.deepEqual([l.kind,l.startedInProgress,l.firstSeenAt,l.firstSeenSince,s.counters.launches],['asset-launch',true,T0,null,1]);
  assert.deepEqual(l.phases,[{phase:'cancel-only',at:T0,since:null}],'only what was observed, with no earlier phase invented');
  assert.equal(l.brokerageNewAt,T0-3600);assert.equal(l.candles.status,'pending');assert.equal(s.transitions.length,0,'no transition was observed at baseline');
  s=applyExchange(s,[...universe(),rec('CTX-USD',{auction_mode:true})],T0+300).state;
  s=applyExchange(s,[...universe(),rec('CTX-USD',{limit_only:true})],T0+600).state;
  const m=s.launches['CTX-USD'];
  assert.deepEqual(m.phases.map(p=>[p.phase,p.at,p.since]),[['cancel-only',T0,null],['auction',T0+300,T0],['limit-only',T0+600,T0+300]]);
  assert.equal(m.tradingObservedAt,T0+600);assert.equal(m.candles.status,'collecting');assert.equal(m.candles.windowStart,T0+300,'nothing before the last pre-trading read is requested');
  assert.equal(s.counters.launches,1);assert.equal(s.launches['CTX-USD'].startedInProgress,true);
  // The other source being baselined second gives the same result.
  let t=applyBrokerage(initial(T0),bk,T0).state;t=applyExchange(t,feed,T0+1).state;
  assert.equal(t.launches['CTX-USD'].startedInProgress,true);assert.equal(t.launches['CTX-USD'].phases[0].at,T0+1);
  // Only clear evidence adopts: a delisting-style cancel-only, a trading product, an old new_at or a later flip do not.
  const cases={
    'no new flag':[[...universe(),rec('CTX-USD',{cancel_only:true})],[...brokerUniverse(),broker('CTX-USD')]],
    'already trading':[[...universe(),rec('CTX-USD')],[...brokerUniverse(),broker('CTX-USD',{new:true})]],
    'stale new_at':[feed,[...brokerUniverse(),broker('CTX-USD',{new:true,new_at:stamp(T0-40*DAY)})]],
  };
  for(const [name,[ex,b]] of Object.entries(cases)){
    const r=applyBrokerage(applyExchange(initial(T0),ex,T0).state,b,T0+1).state;
    assert.equal(r.counters.launches,0,name);
  }
  let later=applyBrokerage(applyExchange(initial(T0),[...universe(),rec('CTX-USD')],T0).state,[...brokerUniverse(),broker('CTX-USD',{new:true})],T0+1).state;
  later=applyExchange(later,[...universe(),rec('CTX-USD',{cancel_only:true})],T0+300).state;
  assert.equal(later.counters.launches,0,'a baseline product that flips state later is not adopted');
  // A pre-trading pair of an asset that already trades elsewhere is a new pair, without candle capture.
  const pair=applyBrokerage(applyExchange(initial(T0),[...feed,rec('CTX-USDC')],T0).state,bk,T0+1).state;
  assert.equal(pair.launches['CTX-USD'].kind,'new-pair');assert.equal(pair.launches['CTX-USD'].candles.status,'skipped');
});

test('changes are logged once with from and to; a repeated read logs nothing; missing fields keep the previous value',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  const changed=[rec('C1-USD',{trading_disabled:true,status:'delisted'}),rec('C2-USD',{cancel_only:true}),rec('C3-USD',{status_message:'maintenance'}),...universe().slice(4)];
  const first=applyExchange(s,[universe()[0],...changed],T0+300).state;
  const byId=id=>first.transitions.filter(t=>t.id===id).map(t=>[t.field,t.from,t.to]).sort();
  assert.deepEqual(byId('C1-USD'),[['status','online','delisted'],['trading_disabled',false,true]]);
  assert.deepEqual(byId('C2-USD'),[['cancel_only',false,true]]);assert.deepEqual(byId('C3-USD'),[['status_message','','maintenance']]);
  assert.equal(first.exchange.products['C1-USD'].changedAt,T0+300);assert.deepEqual(first.exchange.products['C1-USD'].a,{status:'delisted',trading_disabled:true});
  const again=applyExchange(first,[universe()[0],...changed],T0+600).state;
  assert.equal(again.transitions.length,first.transitions.length,'unchanged read logs nothing');assert.equal(again.counters.transitions,first.counters.transitions);
  // A record that omits a flag does not silently clear it.
  const {trading_disabled,status,...partial}=rec('C1-USD');
  const kept=applyExchange(first,[universe()[0],partial,...changed.slice(1)],T0+900).state;
  assert.equal(kept.exchange.products['C1-USD'].a.trading_disabled,true);assert.equal(kept.exchange.products['C1-USD'].a.status,'delisted');
  assert.equal(kept.transitions.length,first.transitions.length);
});

test('per-product and global histories are capped; the first-seen entry is always kept',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('FLIP-USD')],T0+300).state;
  for(let i=1;i<=20;i++)s=applyExchange(s,[...universe(),rec('FLIP-USD',{limit_only:i%2===1})],T0+300+i*300).state;
  const tr=s.exchange.products['FLIP-USD'].tr;
  assert.equal(tr.length,LIMITS.transitionsPerProduct);assert.equal(tr[0].field,'first-seen');assert.equal(tr.at(-1).at,T0+300+20*300);
  assert.equal(s.counters.transitions,21);
  for(let i=0;i<LIMITS.transitions+20;i++)s.transitions.unshift({id:'X',at:1});
  s=applyExchange(s,[...universe(),rec('FLIP-USD',{limit_only:true})],T0+20000).state;
  assert.ok(s.transitions.length<=LIMITS.transitions);
});

test('a product leaving and returning the feed is logged; implausible feeds are refused',()=>{
  const base=universe(120);let s=applyExchange(initial(T0),base,T0).state;
  const left=applyExchange(s,base.filter(p=>p.id!=='C5-USD'),T0+300).state;
  assert.equal(left.exchange.products['C5-USD'].absent,true);assert.deepEqual([left.transitions[0].field,left.transitions[0].from,left.transitions[0].to],['presence','present','absent']);
  const back=applyExchange(left,base,T0+600).state;
  assert.equal(back.exchange.products['C5-USD'].absent,undefined);assert.deepEqual([back.transitions[0].field,back.transitions[0].to],['presence','present']);
  assert.throws(()=>applyExchange(s,base.slice(0,10),T0+300),/only 10 usable/);
  assert.throws(()=>applyExchange(s,base.slice(0,55),T0+300),/shrank/);
  assert.throws(()=>applyExchange(s,base.slice(30),T0+300),/dropped 30 products at once/);
  assert.throws(()=>applyExchange(s,[...base,...Array.from({length:41},(_,i)=>rec(`NEW${i}-USD`))],T0+300),/added 41 products at once/);
  assert.throws(()=>applyExchange(s,{message:'rate limited'},T0+300),/was not a list/);
  assert.equal(s.exchange.products['C5-USD'].absent,undefined,'a refused read never mutates the input');
});

test('unreadable records are counted and skipped, not applied',()=>{
  const bad=[null,{},{id:'constructor'},{id:'__proto__'},{id:'NO SPACES-USD'},{id:42}];
  const r=applyExchange(initial(T0),[...universe(),...bad],T0);
  assert.equal(r.stats.count,60);assert.equal(r.stats.skipped,bad.length);assert.equal(r.state.sources.exchange.skipped,bad.length);
  assert.equal(Object.keys(r.state.exchange.products).length,60);assert.equal(({}).polluted,undefined);
});

test('brokerage flags, new_at capture and late detection',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;s=applyBrokerage(s,brokerUniverse(),T0+1).state;
  const listed=T0-3600;
  const r=applyBrokerage(s,[...brokerUniverse(),broker('NEWA-USD',{new:true,view_only:true,new_at:stamp(listed)})],T0+300);
  const l=r.state.launches['NEWA-USD'];
  assert.equal(l.firstSeenSource,'brokerage');assert.equal(l.brokerageNewAt,listed);assert.equal(l.lateSeconds,T0+300-listed,'seen long after Advanced Trade dated it');
  assert.equal(r.state.brokerage.products['NEWA-USD'].newAt,listed);
  assert.deepEqual(r.state.transitions[0],{id:'NEWA-USD',src:'brokerage',at:T0+300,since:T0+1,field:'first-seen',from:null,to:'view-only'});
  const next=applyBrokerage(r.state,[...brokerUniverse(),broker('NEWA-USD',{new:true,view_only:false,new_at:stamp(listed)})],T0+600).state;
  assert.deepEqual([next.transitions[0].field,next.transitions[0].from,next.transitions[0].to,next.transitions[0].src],['view_only',true,false,'brokerage']);
  // Exchange sees the same product later: one launch, both sources recorded, phases from the Exchange list only.
  const ex=applyExchange(next,[...universe(),rec('NEWA-USD',{auction_mode:true})],T0+900).state;
  assert.equal(Object.keys(ex.launches).length,1);assert.deepEqual(Object.keys(ex.launches['NEWA-USD'].seenAt).sort(),['brokerage','exchange']);
  assert.deepEqual(ex.launches['NEWA-USD'].phases,[{phase:'auction',at:T0+900,since:T0}]);
});

// ------------------------------------------------------------------- incidents
test('incidents are classified into listing, suspension and other',()=>{
  const c=core.classifyIncident;
  assert.equal(c(listingIncident()),'listing');
  assert.equal(c(incident('a1b2c3d4','WMTX-USD moved to full trading','monitoring',[update('x',FULL,T0)])),'listing');
  assert.equal(c(incident('a1b2c3d5','KITE-USD to Limit Only','resolved',[update('x',LIMIT,T0)])),'listing');
  assert.equal(c(incident('a1b2c3d6','Some pair opens','monitoring',[update('x','Our ABC-USD trading pair will now enter auction mode.',T0)])),'listing','body fallback needs a pair and the phrase trading pair');
  assert.equal(c(suspensionIncident()),'suspension');
  assert.equal(c(incident('a1b2c3d7','Notice','monitoring',[update('x','We will suspend trading on FOO-USD on 1 March 2027.',T0)])),'suspension');
  assert.equal(c(noise()),'other');
  assert.equal(c(incident('a1b2c3d8','Suspended Sends/Receives - FOO','monitoring',[update('x','Sends are suspended for FOO.',T0)])),'other','a wallet suspension is not a trading suspension');
  assert.equal(c(incident('a1b2c3d9','USDC Network Support Update','resolved',[])),'other');
});

test('update phases follow the earliest phase named in the text',()=>{
  const p=core.parseIncident(listingIncident());
  const by=Object.fromEntries(p.events.map(e=>[e.updateId,e.phase]));
  assert.deepEqual(by,{u1:'go-live-notice',u2:'auction',u3:'limit-only',u4:'live-retail',u5:'full-trading',u6:'resolved'});
  const s=core.parseIncident(suspensionIncident());
  assert.deepEqual(Object.fromEntries(s.events.map(e=>[e.updateId,e.phase])),{e1:'notice',e2:'executed'});
  const r=core.parseIncident(incident('a1b2c3d4','CP-USD Markets Open','resolved',[update('x','Due to market conditions, our CP-USD trading pair will now re-enter auction mode.',T0)]));
  assert.equal(r.events[0].phase,'auction');assert.equal(r.events[0].reentry,true);
  assert.equal(core.parseIncident(noise()).events[0].phase,null);
  assert.equal(core.parseIncident(null),null);assert.equal(core.parseIncident({id:'x'}),null);
});

test('symbols are extracted best effort and unknown stays null',()=>{
  const e=core.extractSymbols;
  assert.deepEqual(e('Upcoming Trading Suspension: ANKR-EUR, BAT-BTC and JASMY-USDT'),{products:['ANKR-EUR','BAT-BTC','JASMY-USDT'],assets:['ANKR','BAT','JASMY']});
  assert.deepEqual(e('Badger DAO (BADGER) & Storj (STORJ) at 2 PM (ET) (Simple and Advanced Trade)'),{products:null,assets:['BADGER','STORJ']});
  assert.deepEqual(e('Delayed Sends/Receives - SUI',{name:true}),{products:null,assets:['SUI']});
  assert.deepEqual(e('TAO - Delayed Sends & Receives',{name:true}),{products:null,assets:['TAO']});
  assert.deepEqual(e('Delayed Sends and Receives - Ethereum Network',{name:true}),{products:null,assets:null});
  assert.deepEqual(e('A general update with nothing named'),{products:null,assets:null});
  assert.deepEqual(e(undefined),{products:null,assets:null});
});

test('effective dates parse with the stated clock and zone; unknown stays null',()=>{
  const p=core.parseEffective;
  assert.deepEqual(p(NOTICE),{effectiveDate:'2026-09-28',effectiveAt:Date.parse('2026-09-28T18:00:00Z')/1000},'2 PM EDT');
  assert.deepEqual(p('will suspend trading on January 5, 2027 at 9:30 AM ET.'),{effectiveDate:'2027-01-05',effectiveAt:Date.parse('2027-01-05T14:30:00Z')/1000},'9:30 AM EST');
  assert.deepEqual(p('Coinbase will suspend trading of ACX on July 28, 2026. Holders can review the conversion process and timelines here. Support closes at 3 PM ET.'),{effectiveDate:'2026-07-28',effectiveAt:null},'a clock far from the date is not attached');
  assert.deepEqual(p('will suspend trading on 15 September 2026.'),{effectiveDate:'2026-09-15',effectiveAt:null});
  assert.deepEqual(p('no date here'),{effectiveDate:null,effectiveAt:null});
  assert.deepEqual(p('on 31 Feb'),{effectiveDate:null,effectiveAt:null});
});

test('events dedupe by incident and update id, keep the first seen time and never recount evicted events',()=>{
  let s=initial(T0);
  const feed=[listingIncident(),suspensionIncident(),noise()];
  const one=applyIncidents(s,feed,T0+10);
  assert.equal(one.stats.newEvents,6+2+1);assert.equal(one.state.events.length,9);assert.equal(one.state.counters.events,9);
  const two=applyIncidents(one.state,[{...listingIncident(),status:'resolved'},suspensionIncident('resolved'),noise()],T0+900);
  assert.equal(two.stats.newEvents,0);assert.equal(two.state.events.length,9);assert.ok(two.state.events.every(e=>e.seenAt===T0+10),'first seen time is kept');
  assert.ok(two.state.events.filter(e=>e.incidentId==='bczrbdtb1fd5').every(e=>e.incidentStatus==='resolved'),'incident status follows the feed');
  // Only 20 unrelated events are retained; older ones still in the feed are not re-counted every run.
  const many=Array.from({length:30},(_,i)=>incident(`o${i}abcd`,`Delayed Sends/Receives - T${i}X`,'resolved',[update(`x${i}`,'delay',T0+i*60)]));
  const a=applyIncidents(s,many,T0+10),b=applyIncidents(a.state,many,T0+20);
  assert.equal(a.state.events.length,LIMITS.events.other);assert.equal(a.stats.newEvents,LIMITS.events.other);assert.equal(b.stats.newEvents,0);assert.equal(b.state.counters.events,LIMITS.events.other);
  assert.throws(()=>applyIncidents(s,{incidents:[]},T0),/not a list/);
  assert.throws(()=>applyIncidents(s,[{},{id:1}],T0),/none were readable/);
  const partial=applyIncidents(s,[noise(),{name:'no id'},{id:'okok1',name:'x',incident_updates:[{id:'u',body:'b',created_at:'garbage'}]}],T0);
  assert.equal(partial.stats.skipped,2);assert.equal(partial.state.sources.status.skipped,2);
});

test('the watchlist lists upcoming and recently effective notices with their source incident',()=>{
  const now=T0+10;
  const upcoming=applyIncidents(initial(T0),[suspensionIncident('monitoring',false)],now).state;
  assert.equal(upcoming.watchlist.length,1);
  const w=upcoming.watchlist[0];
  assert.deepEqual([w.status,w.incidentId,w.noticeAt,w.effectiveDate,w.effectiveAt,w.executedAt,w.scope],['upcoming','bczrbdtb1fd5',T0,'2026-09-28',Date.parse('2026-09-28T18:00:00Z')/1000,null,'asset']);
  assert.deepEqual(w.products,['BADGER-USD','STORJ-USD']);assert.deepEqual(w.assets,['BADGER','STORJ']);
  const executed=applyIncidents(upcoming,[suspensionIncident()],T0+30*DAY+60).state;
  assert.equal(executed.watchlist[0].status,'effective');assert.equal(executed.watchlist[0].executedAt,T0+30*DAY);
  const later=applyIncidents(executed,[suspensionIncident()],T0+61*DAY).state;
  assert.equal(later.watchlist.length,0,'an executed notice leaves the watchlist after 30 days; its events remain');assert.ok(later.events.length>=2);
  assert.equal(core.refreshWatchlist(executed,T0+61*DAY).watchlist.length,0,'expiry also happens while the status feed is failing');assert.equal(executed.watchlist.length,1,'the input is not mutated');
  const cancelled=applyIncidents(initial(T0),[suspensionIncident('resolved',false)],now).state;
  assert.equal(cancelled.watchlist.length,0,'a resolved incident with no execution is not an upcoming notice');
  const pairs=applyIncidents(initial(T0),[incident('pp12qq34','Upcoming Trading Suspension: ANKR-EUR and BAT-BTC','monitoring',[update('p',"We will suspend trading on the ANKR-EUR and BAT-BTC trading pairs on 15 September 2026.",T0)])],now).state;
  assert.equal(pairs.watchlist[0].scope,'pairs');assert.equal(pairs.watchlist[0].effectiveAt,null);
  const order=applyIncidents(initial(T0),[suspensionIncident('monitoring',false),incident('zz11yy22','Upcoming Trading Suspension: LATE-USD','monitoring',[update('z','We will suspend trading for Late (LATE) on 5 December 2026 on or around 2 PM ET.',T0)])],now).state.watchlist;
  assert.deepEqual(order.map(x=>x.products[0]),['BADGER-USD','LATE-USD'],'earliest effective date first');
});

test('status-feed listings keep phase times without prices and skip non-launch limit-only notices',()=>{
  const wmtx=incident('wm11tx22','WMTX-USD moved to Limit Only','resolved',[update('w','We have paused deposits and moved our WMTX-USD trading pair to limit-only mode following a security incident.',T0)]);
  const s=applyIncidents(initial(T0),[listingIncident(),wmtx,noise()],T0+10).state;
  const rows=core.deriveStatusListings(s.events);
  assert.equal(rows.length,1);const x=rows[0];
  assert.deepEqual([x.incident,x.announcedAt,x.auctionAt,x.limitOnlyAt,x.fullTradingAt,x.source,x.prices],['BLUECHIP-USD Markets Open',T0,T0+1800,T0+3000,T0+3*DAY,'status-feed',null]);
  assert.deepEqual(x.products,['BLUECHIP-USD']);
  const many=Array.from({length:12},(_,i)=>incident(`ls${i}abcd`,`L${i}-USD Markets Open`,'resolved',[update(`a${i}`,`Our L${i}-USD trading pair will now enter auction mode.`,T0+i*100)]));
  assert.equal(core.deriveStatusListings(applyIncidents(initial(T0),many,T0+10).state.events).length,LIMITS.statusListings);
});

// ------------------------------------------------------------ source failures
test('a failed source keeps earlier data with its original read time and reports an explicit error',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  const failed=recordSourceFailure(s,'exchange','Public data HTTP 503',T0+300);
  assert.equal(core.sourceStatus(failed.sources.exchange),'error');assert.equal(failed.sources.exchange.lastOkAt,T0);assert.equal(failed.sources.exchange.lastErrorAt,T0+300);
  assert.deepEqual(failed.exchange,s.exchange);assert.equal(failed.sources.exchange.failures,1);
  assert.equal(recordSourceFailure(failed,'exchange','Public data HTTP 503',T0+600).sources.exchange.failures,2);
  assert.equal(s.sources.exchange.lastError,null,'the input state is not mutated');
  const healed=applyExchange(failed,universe(),T0+900).state;
  assert.equal(core.sourceStatus(healed.sources.exchange),'ok');assert.equal(healed.sources.exchange.lastError,null);assert.equal(healed.sources.exchange.failures,0);
  assert.throws(()=>recordSourceFailure(s,'nope','x',T0),/Unknown source/);
  // After an outage the first appearance is bracketed by the last good read, not the failed attempts.
  const after=applyExchange(failed,[...universe(),rec('NEWA-USD',{auction_mode:true})],T0+900).state;
  assert.equal(after.launches['NEWA-USD'].firstSeenSince,T0);
});

// ------------------------------------------------------------------- avoid
test('isAvoid flags notices, disabled states and products first seen under 90 days ago',()=>{
  let s=applyExchange(initial(T0),[...universe(),rec('OLD-USD')],T0).state;
  s=applyBrokerage(s,[...brokerUniverse(),broker('OLD-USD'),broker('RECENT-USD',{new_at:stamp(T0-10*DAY)}),broker('DATED-USD',{new_at:stamp(T0-200*DAY)})],T0+1).state;
  s=applyExchange(s,[...universe(),rec('OLD-USD'),rec('NEWA-USD',{auction_mode:true})],T0+300).state;
  const now=T0+300+10*DAY;
  assert.equal(isAvoid('OLD-USD',s,now),false,'a baseline product with no dated listing has an unknown age and is not flagged');
  assert.deepEqual(avoidReasons('NEWA-USD',s,now),['new-listing']);
  assert.equal(isAvoid('newa-usd',s,now),true,'ids are case-insensitive');
  const edge=T0+300+90*DAY;
  assert.equal(isAvoid('NEWA-USD',s,edge-1),true);assert.equal(isAvoid('NEWA-USD',s,edge),false,'90 days is the first day it is no longer flagged');
  assert.equal(isAvoid('RECENT-USD',s,T0+1),true,'a dated recent Advanced Trade listing counts even for a baseline product');
  assert.equal(isAvoid('DATED-USD',s,T0+1),false);
  // Trading state: registry flags and explicit product records.
  const feed=[...universe().filter(p=>!['C1-USD','C2-USD','C3-USD'].includes(p.id)),rec('OLD-USD',{cancel_only:true}),rec('NEWA-USD',{auction_mode:true}),rec('C1-USD',{trading_disabled:true}),rec('C2-USD',{status:'delisted'}),rec('C3-USD',{status:'offline'})];
  const changed=applyExchange(s,feed,T0+600).state;
  assert.deepEqual(avoidReasons('OLD-USD',changed,T0+600),['cancel-only']);
  assert.deepEqual(avoidReasons('C1-USD',changed,T0+600),['trading-disabled']);assert.deepEqual(avoidReasons('C2-USD',changed,T0+600),['delisted']);assert.deepEqual(avoidReasons('C3-USD',changed,T0+600),['offline']);
  assert.equal(isAvoid({id:'C9-USD',cancel_only:true},s,now),true,'a product record is judged on its own flags');
  assert.equal(isAvoid({id:'C9-USD',status:'online',trading_disabled:false},s,now),false);
  assert.equal(isAvoid({product_id:'C9-USD',trading_disabled:true},s,now),true);
  assert.equal(isAvoid('NOSUCH-USD',s,now),false);assert.equal(isAvoid('',s,now),false);assert.equal(isAvoid(null,s,now),false);
  // Notices: asset-wide notices cover every pair; notices naming only non-USD pairs do not cover the USD pair.
  const noticed=applyIncidents(s,[suspensionIncident('monitoring',false),incident('pp12qq34','Upcoming Trading Suspension: C7-EUR','monitoring',[update('p','We will suspend trading on the C7-EUR trading pair on 15 December 2026.',T0)])],T0+400).state;
  assert.deepEqual(avoidReasons('BADGER-USD',noticed,now),['suspension-notice']);assert.deepEqual(avoidReasons('BADGER-USDC',noticed,now),['suspension-notice'],'an asset-wide notice covers other pairs');
  assert.deepEqual(avoidReasons('C7-EUR',noticed,now),['suspension-notice']);assert.deepEqual(avoidReasons('C7-USD',noticed,now),[],'a named non-USD pair does not flag the USD pair');
  const before=structuredClone(noticed);isAvoid('BADGER-USD',noticed,now);assert.deepEqual(noticed,before);
});

// ------------------------------------------------------------------- candles
const candleRows=(start,end,{skip=()=>false,close=m=>100+m*.5}={})=>{
  const rows=[];for(let t=end;t>=start;t-=60)if(!skip(t))rows.push([t,close(t),close(t)+1,close(t)-.25,close(t),10]);
  return rows;
};
function launched(){
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('NEWA-USD',{auction_mode:true})],T0+300).state;
  return applyExchange(s,[...universe(),rec('NEWA-USD',{limit_only:true})],T0+600).state;
}
test('candle requests are bounded, chunked to 300 minutes and only cover completed minutes',()=>{
  const s=launched(),c=s.launches['NEWA-USD'].candles;
  assert.deepEqual(core.planCandleRequests(s,T0+700),[{id:'NEWA-USD',start:T0+300,end:T0+540}],'only minutes that ended two minutes ago');
  assert.deepEqual(core.planCandleRequests(s,T0+320),[],'nothing complete yet');
  const plan=core.planCandleRequests(s,T0+300+2*DAY);
  assert.equal(plan.length,LIMITS.candleRequestsPerRun);
  assert.deepEqual(plan.map(p=>(p.end-p.start)/60+1),[300,300,300,300]);
  assert.equal(plan[0].start,c.windowStart);plan.slice(1).forEach((p,i)=>assert.equal(p.start,plan[i].end+60,'contiguous, no overlap'));
  assert.equal(core.planCandleRequests(s,T0+300+2*DAY,2).length,2);
  assert.match(core.candleUrl(plan[0]),/^https:\/\/api\.exchange\.coinbase\.com\/products\/NEWA-USD\/candles\?granularity=60&start=\d{4}-\d\d-\d\dT\d\d:\d\d:00Z&end=\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/);
});

test('candle rows are stored incrementally with exact coverage, are idempotent and complete after 24 hours',()=>{
  let s=launched();const c0=s.launches['NEWA-USD'].candles;
  let now=T0+700;
  let plan=core.planCandleRequests(s,now);
  const answer=p=>({...p,rows:candleRows(p.start,p.end,{skip:t=>t===T0+420}),receivedAt:now});
  let r=core.applyCandleResults(s,plan.map(answer),now);s=r.state;
  let c=s.launches['NEWA-USD'].candles;
  assert.deepEqual(r.stats,{requests:1,succeeded:1,failed:0,rows:4,rejected:0},'the minute with no trades is coverage without a row');
  assert.deepEqual(c.covered,[[T0+300,T0+540]]);assert.equal(c.count,4);assert.deepEqual(c.rows[0],[0,100+ (T0+300)*.5,10]);
  assert.deepEqual(c.first,{at:T0+300,open:100+(T0+300)*.5-.25});assert.equal(c.status,'collecting');
  // Re-applying the same rows changes nothing.
  const again=core.applyCandleResults(s,plan.map(answer),now).state.launches['NEWA-USD'].candles;
  assert.deepEqual(again.rows,c.rows);assert.equal(again.conflicts,0);
  // Continue until the window closes; the last minute is read only once complete.
  now=T0+600+DAY+3600;
  for(let i=0;i<4;i++){plan=core.planCandleRequests(s,now);if(!plan.length)break;s=core.applyCandleResults(s,plan.map(answer),now).state;}
  c=s.launches['NEWA-USD'].candles;
  assert.equal(c.status,'complete');assert.deepEqual(c.covered,[[c0.windowStart,c0.windowEnd]]);
  assert.equal(c.count,(c0.windowEnd-c0.windowStart)/60+1-1,'every minute of the window except the one without trades');
  assert.equal(c.rows.at(-1)[0],(c0.windowEnd-c0.windowStart)/60);
  assert.equal(core.planCandleRequests(s,now+DAY).length,0);
  assert.equal(s.sources.candles.lastError,null);
});

test('malformed candle rows and incomplete minutes are rejected; conflicting duplicates keep the first row',()=>{
  const s=launched(),now=T0+700,p={id:'NEWA-USD',start:T0+300,end:T0+540};
  const good=[T0+300,1,3,2,2.5,10];
  const rows=[good,[T0+330,'x',3,2,2.5,10],[T0+360.5,1,3,2,2.5,10],[T0+390,1,3,2,0,10],[T0+420,1,3,2,2,-1],[T0+120,1,3,2,2,10],[T0+600,1,3,2,2,10],'junk',[T0+480,1,3,2,2.5,10]];
  const r=core.applyCandleResults(s,[{...p,rows}],now);
  assert.equal(r.stats.rows,2);assert.equal(r.stats.rejected,7);
  const dup=core.applyCandleResults(r.state,[{...p,rows:[[T0+300,1,3,2,9,99]]}],now);
  assert.equal(dup.state.launches['NEWA-USD'].candles.conflicts,1);assert.equal(dup.state.launches['NEWA-USD'].candles.rows[0][1],2.5);
  assert.equal(core.applyCandleResults(s,[{...p,rows:[good]}],T0+330).stats.rejected,1,'a minute that had not ended when applied is rejected');
});

test('a failed candle request leaves its range uncovered and is retried; a window that closes with gaps is marked incomplete',()=>{
  let s=launched();const now=T0+700,p={id:'NEWA-USD',start:T0+300,end:T0+540};
  const failed=core.applyCandleResults(s,[{...p,rows:null,error:'Public data HTTP 429'}],now);
  assert.equal(failed.stats.failed,1);assert.deepEqual(failed.state.launches['NEWA-USD'].candles.covered,[]);assert.equal(failed.state.launches['NEWA-USD'].candles.lastError,'Public data HTTP 429');
  assert.equal(core.sourceStatus(failed.state.sources.candles),'error');assert.equal(failed.state.sources.candles.lastOkAt,null);
  assert.deepEqual(core.planCandleRequests(failed.state,now),[p],'the same range is planned again');
  const idle=core.applyCandleResults(initial(T0),[],T0+5);assert.equal(core.sourceStatus(idle.state.sources.candles),'idle');
  const partial=core.applyCandleResults(s,[{...p,rows:candleRows(p.start,p.end)},{id:'NEWA-USD',start:T0+600,end:T0+840,rows:null,error:'boom'}],T0+900);
  assert.match(partial.state.sources.candles.lastError,/1 of 2 candle requests failed/);assert.ok(partial.state.sources.candles.lastOkAt);
  const late=core.applyCandleResults(partial.state,[],T0+600+DAY+2*DAY+60).state;
  assert.equal(late.launches['NEWA-USD'].candles.status,'incomplete');assert.deepEqual(late.launches['NEWA-USD'].candles.covered,[[T0+300,T0+540]],'the exact covered range is what remains');
});

test('only the newest launches keep 1-minute rows in state',()=>{
  const ids=Array.from({length:14},(_,i)=>`L${String(i).padStart(2,'0')}-USD`);
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),...ids.map(id=>rec(id))],T0+300).state;
  const now=T0+1000,results=ids.map(id=>({id,start:T0,end:T0+240,rows:candleRows(T0,T0+240)}));
  s=core.applyCandleResults(s,results,now).state;
  const kept=Object.values(s.launches).filter(l=>l.candles.rows.length),trimmed=Object.values(s.launches).filter(l=>l.candles.trimmed);
  assert.equal(kept.length,LIMITS.candleLaunches);assert.equal(trimmed.length,2);assert.ok(trimmed.every(l=>l.candles.count===5&&l.candles.covered.length===1),'summary and coverage survive');
  assert.equal(s.counters.launches,14);
});

test('baseline products are never backfilled and get no candle window',()=>{
  const s=applyExchange(initial(T0),universe(),T0).state;
  assert.deepEqual(core.planCandleRequests(s,T0+DAY),[]);assert.deepEqual(s.launches,{});
});

test('post-only and auction books never open the candle window; limit-only and full do',()=>{
  assert.deepEqual([...core.TRADING_PHASES],['limit-only','full']);
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyExchange(s,[...universe(),rec('NEWP-USD',{post_only:true})],T0+300).state;
  assert.equal(s.launches['NEWP-USD'].phases[0].phase,'post-only');assert.equal(s.launches['NEWP-USD'].tradingObservedAt,null);assert.equal(s.launches['NEWP-USD'].candles.status,'pending');
  s=applyExchange(s,[...universe(),rec('NEWP-USD',{auction_mode:true,post_only:true})],T0+600).state;
  assert.equal(s.launches['NEWP-USD'].tradingObservedAt,null,'auction wins over post-only');
});

// ------------------------------------------------------------------- snapshot
function world(over={}){return {exchange:universe(),brokerage:brokerUniverse(),incidents:[listingIncident(),suspensionIncident('monitoring',false),noise()],candles:(u)=>[],fail:{},...over};}
function fetcherFor(w,calls=[]){
  return async(url,options)=>{
    calls.push({url,options});
    const u=String(url);let key,body;
    if(u==='https://api.exchange.coinbase.com/products'){key='exchange';body=w.exchange;}
    else if(u.startsWith('https://api.coinbase.com/api/v3/brokerage/market/products?')){key='brokerage';body=w.pagination?{products:w.brokerage,pagination:w.pagination}:{products:w.brokerage,num_products:w.brokerage.length};}
    else if(u.startsWith('https://status.exchange.coinbase.com/api/v2/incidents.json')){key='status';body={page:{},incidents:w.incidents};}
    else if(u.includes('/candles?')){key='candles';const m=/products\/([^/]+)\/candles\?granularity=60&start=([^&]+)&end=(.+)$/.exec(u);body=w.candles({id:m[1],start:Date.parse(m[2])/1000,end:Date.parse(m[3])/1000});}
    else return {ok:false,status:404,json:async()=>({})};
    const fail=w.fail[key];
    if(fail===true)throw new Error('network down');
    if(fail)return {ok:false,status:fail,json:async()=>({})};
    if(w.badJson===key)return {ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token < in JSON');}};
    return {ok:true,status:200,json:async()=>body};
  };
}
async function tmpRoot(t){const root=await mkdtemp(path.join(os.tmpdir(),'listing-watch-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const readJson=async f=>JSON.parse(await readFile(f,'utf8'));
const ctl=(start)=>{let t=start;const clock=()=>t;clock.set=v=>{t=v;};return clock;};

test('snapshots validate, keep the execution lock, cannot predate or postdate their observation',()=>{
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyBrokerage(s,brokerUniverse(),T0+1).state;s=applyIncidents(s,[listingIncident(),suspensionIncident('monitoring',false)],T0+2).state;
  const snap=core.listingWatchSnapshot(s,{generatedAt:T0+5,requests:3});
  assert.equal(core.validListingWatchSnapshot(snap,T0+10),true);
  assert.deepEqual(snap.execution,{mode:'observation',realEnabled:false,ordersPlaced:false,paperPositions:false,authenticated:false});
  assert.equal(snap.sources.exchange.status,'ok');assert.equal(snap.sources.candles.status,'pending');assert.equal(snap.counts.exchangeProducts,60);assert.equal(snap.counts.watchlistUpcoming,1);
  assert.match(snap.cadence,/best effort/);assert.match(snap.cadence,/not continuous/);
  assert.equal(core.validListingWatchSnapshot({...snap,generatedAt:T0+10000},T0+10),false,'a future snapshot is rejected');
  assert.equal(core.validListingWatchSnapshot({...snap,execution:{...snap.execution,realEnabled:true}},T0+10),false);
  assert.equal(core.validListingWatchSnapshot({...snap,execution:{...snap.execution,authenticated:true}},T0+10),false);
  assert.equal(core.validListingWatchSnapshot({...snap,policyId:'other'},T0+10),false);assert.equal(core.validListingWatchSnapshot(null),false);assert.equal(core.validListingWatchSnapshot({}),false);
  assert.throws(()=>core.listingWatchSnapshot(s,{generatedAt:T0}),/predate/);
  assert.equal(snap.study.rows.length,3);assert.equal(JSON.stringify(snap).includes('Authorization'),false);
  assert.ok(JSON.stringify(snap).length<40000,'the public snapshot stays compact');
});

test('state validation refuses a changed policy, an unlocked execution flag and damaged registries',()=>{
  const s=initial(T0);
  assert.equal(core.validateListingWatch(s),true);
  assert.throws(()=>core.validateListingWatch({...s,policyId:'old'}),/migration is required/);
  assert.throws(()=>core.validateListingWatch({...s,realEnabled:true}),/refusing to reset/);
  assert.throws(()=>core.validateListingWatch({...s,exchange:{products:[]}}),/refusing to reset/);
  assert.throws(()=>core.validateListingWatch({...s,counters:{}}),/refusing to reset/);
  assert.throws(()=>core.validateListingWatch(null),/refusing to reset/);
});

// ------------------------------------------------------------ collector (I/O)
test('a first run writes atomic state and snapshot, uses three GET requests and sends no credentials',async t=>{
  const root=await tmpRoot(t),calls=[],clock=ctl(T0+5),p=listingWatchPaths(root);
  const run=await runListingWatch({root,fetcher:fetcherFor(world(),calls),clock,pace:0});
  assert.equal(run.published,true);assert.equal(run.exitCode,0);
  assert.deepEqual(calls.map(c=>c.url),['https://api.exchange.coinbase.com/products','https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT','https://status.exchange.coinbase.com/api/v2/incidents.json']);
  assert.ok(calls.every(c=>c.options.method==='GET'&&!c.options.body&&!Object.keys(c.options.headers).some(h=>/authorization|cookie|key|secret/i.test(h))));
  const state=await readJson(p.state),snap=await readJson(p.snapshot);
  assert.doesNotThrow(()=>core.validateListingWatch(state));assert.equal(core.validListingWatchSnapshot(snap,T0+60),true);
  assert.equal(snap.counts.exchangeProducts,60);assert.equal(snap.counts.brokerageUsdProducts,60);assert.equal(snap.counts.launches,0);assert.equal(snap.sources.candles.status,'idle');
  assert.equal((await stat(p.lock).catch(()=>null)),null,'the lock is released');
  const s=summarize(run);assert.equal(s.products.exchange,60);assert.equal(s.sources.status.ok,true);assert.equal(JSON.stringify(s).includes('Authorization'),false);
  assert.deepEqual(await readdir(path.dirname(p.state)),['state.json'],'no temp files left behind');
});

test('repeat runs with unchanged sources add no transitions, launches or events but keep read times current',async t=>{
  const root=await tmpRoot(t),clock=ctl(T0+5),p=listingWatchPaths(root),fetcher=fetcherFor(world());
  await runListingWatch({root,fetcher,clock,pace:0});const state1=await readJson(p.state),snap1=await readJson(p.snapshot);
  clock.set(T0+305);await runListingWatch({root,fetcher,clock,pace:0});
  const state2=await readJson(p.state),snap2=await readJson(p.snapshot);
  assert.ok(snap2.generatedAt>snap1.generatedAt);assert.equal(snap2.sources.exchange.lastOkAt,T0+305);assert.equal(state2.sources.exchange.lastOkAt,T0+305,'state carries the true previous read for the next since bound');
  assert.equal(snap2.counts.transitions,0);assert.equal(state2.counters.events,state1.counters.events);assert.deepEqual(state2.events,state1.events);assert.deepEqual(state2.exchange,state1.exchange);assert.deepEqual(state2.watchlist,state1.watchlist);
});

test('a launch is followed across runs: phases, then bounded incremental 1-minute candle reads',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),calls=[];
  const w=world({candles:({start,end})=>candleRows(start,end)});const fetcher=fetcherFor(w,calls);
  await runListingWatch({root,fetcher,clock,pace:0});
  clock.set(T0+300);w.exchange=[...universe(),rec('NEWA-USD',{auction_mode:true})];
  let run=await runListingWatch({root,fetcher,clock,pace:0});
  assert.deepEqual(run.report.exchange.newProducts,['NEWA-USD']);assert.equal(run.report.candles.requests,0,'no candles before trading starts');
  clock.set(T0+600);w.exchange=[...universe(),rec('NEWA-USD',{limit_only:true})];calls.length=0;
  run=await runListingWatch({root,fetcher,clock,pace:0});
  const first=calls.filter(c=>c.url.includes('/candles?'));
  assert.equal(first.length,1,'trading was first observed, so the window opens at the last auction read');
  assert.deepEqual(run.report.candles.planned,[{id:'NEWA-USD',start:T0+300,end:T0+480}],'only minutes that ended at least two minutes ago');
  clock.set(T0+900);calls.length=0;run=await runListingWatch({root,fetcher,clock,pace:0});
  const c1=calls.filter(c=>c.url.includes('/candles?'));
  assert.equal(c1.length,1);assert.match(c1[0].url,/NEWA-USD\/candles\?granularity=60&start=.*&end=/);assert.ok(c1.every(c=>c.options.method==='GET'));
  const snap=await readJson(p.snapshot),l=snap.launches[0];
  assert.equal(l.id,'NEWA-USD');assert.equal(l.candles.status,'collecting');assert.equal(l.candles.count,run.state.launches['NEWA-USD'].candles.count);
  assert.deepEqual(l.candles.covered,[[T0+300,T0+780]],'contiguous ranges merge; the exact covered span is published');assert.equal(snap.sources.candles.status,'ok');assert.equal(snap.counts.candleLaunches,1);
  assert.equal('rows' in l.candles,false,'raw candle rows stay out of the public snapshot');
  const state=await readJson(p.state);assert.ok(state.launches['NEWA-USD'].candles.rows.length>0,'and live in the authoritative state');
  // A day later the remaining ranges arrive at most four requests per run.
  clock.set(T0+600+DAY+3600);calls.length=0;run=await runListingWatch({root,fetcher,clock,pace:0});
  assert.equal(calls.filter(c=>c.url.includes('/candles?')).length,LIMITS.candleRequestsPerRun);
  for(let i=0;i<3;i++)await runListingWatch({root,fetcher,clock,pace:0});
  assert.equal((await readJson(p.state)).launches['NEWA-USD'].candles.status,'complete');
});

test('a launch already cancel-only at the first run is adopted, flagged in the page and followed into trading',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),calls=[];
  const w=world({exchange:[...universe(),rec('CTX-USD',{cancel_only:true})],brokerage:[...brokerUniverse(),broker('CTX-USD',{new:true,new_at:stamp(T0-600)})],candles:({start,end})=>candleRows(start,end)});
  const fetcher=fetcherFor(w,calls);
  await runListingWatch({root,fetcher,clock,pace:0});
  const snap=await readJson(p.snapshot);
  assert.equal(snap.counts.launches,1);assert.equal(snap.launches[0].startedInProgress,true);assert.equal(snap.counts.transitions,0);
  const html=listingWatchPanel(snap,{now:T0+60});
  assert.match(html,/in progress at start/);assert.match(html,/first appearance was not observed/);assert.doesNotMatch(html,/No launch captured yet/);
  clock.set(T0+305);w.exchange=[...universe(),rec('CTX-USD',{auction_mode:true})];await runListingWatch({root,fetcher,clock,pace:0});
  clock.set(T0+605);w.exchange=[...universe(),rec('CTX-USD',{limit_only:true})];calls.length=0;
  const run=await runListingWatch({root,fetcher,clock,pace:0});
  assert.deepEqual(run.report.candles.planned,[{id:'CTX-USD',start:T0+300,end:T0+480}]);assert.ok(calls.some(c=>/CTX-USD\/candles\?granularity=60/.test(c.url)));
  const l=(await readJson(p.snapshot)).launches[0];
  assert.deepEqual(l.phases.map(x=>x.phase),['cancel-only','auction','limit-only']);assert.equal(l.candles.status,'collecting');assert.equal(l.candles.count,4);
});

test('sources fail independently: the snapshot shows the error and keeps the earlier good read time',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),w=world(),fetcher=fetcherFor(w);
  await runListingWatch({root,fetcher,clock,pace:0});
  clock.set(T0+305);w.fail={brokerage:503};w.exchange=[...universe(),rec('NEWA-USD',{auction_mode:true})];
  const run=await runListingWatch({root,fetcher,clock,pace:0});
  assert.equal(run.published,true);assert.equal(run.exitCode,0);
  const snap=await readJson(p.snapshot);
  assert.equal(snap.sources.brokerage.status,'error');assert.match(snap.sources.brokerage.lastError,/HTTP 503/);assert.equal(snap.sources.brokerage.lastOkAt,T0+5,'original read time kept');
  assert.equal(snap.sources.exchange.status,'ok');assert.equal(snap.sources.exchange.lastOkAt,T0+305);assert.equal(snap.counts.brokerageUsdProducts,60,'earlier good data retained');
  assert.equal(snap.counts.launches,1);
  // Malformed JSON and a paginated feed are explicit errors, not partial data.
  clock.set(T0+605);w.fail={};w.badJson='status';
  await runListingWatch({root,fetcher,clock,pace:0});
  assert.match((await readJson(p.snapshot)).sources.status.lastError,/Unreadable response/);
  clock.set(T0+905);w.badJson=null;w.pagination={has_next:true};
  const pag=(await runListingWatch({root,fetcher,clock,pace:0})).report.brokerage;assert.equal(pag.ok,false);assert.match(pag.error,/paginated/);
  clock.set(T0+1205);w.pagination=null;w.exchange={message:'rate limited'};
  assert.match((await runListingWatch({root,fetcher,clock,pace:0})).report.exchange.error,/not a list: rate limited/);
});

test('when every source fails nothing is written and the last good snapshot is retained',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),w=world(),fetcher=fetcherFor(w);
  const none=await runListingWatch({root,fetcher:fetcherFor({...w,fail:{exchange:true,brokerage:true,status:true}}),clock,pace:0});
  assert.equal(none.published,false);assert.equal(none.exitCode,1);assert.equal(await stat(p.snapshot).catch(()=>null),null,'no first snapshot is fabricated from failures');
  await runListingWatch({root,fetcher,clock,pace:0});const before=await readFile(p.snapshot,'utf8'),beforeState=await readFile(p.state,'utf8');
  clock.set(T0+305);const bad=await runListingWatch({root,fetcher:fetcherFor({...w,fail:{exchange:500,brokerage:500,status:500}}),clock,pace:0});
  assert.equal(bad.exitCode,1);assert.match(bad.reason,/retained unchanged/);
  assert.equal(await readFile(p.snapshot,'utf8'),before);assert.equal(await readFile(p.state,'utf8'),beforeState);
});

test('damaged, changed-policy or future state is refused without being reset',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),fetcher=fetcherFor(world());
  await mkdir(path.dirname(p.state),{recursive:true});
  await writeFile(p.state,'{not json');
  await assert.rejects(runListingWatch({root,fetcher,clock,pace:0}),/Unreadable state\.json; nothing was reset/);
  assert.equal(await readFile(p.state,'utf8'),'{not json');
  await writeFile(p.state,JSON.stringify({...initial(T0),policyId:'old'}));
  await assert.rejects(runListingWatch({root,fetcher,clock,pace:0}),/migration is required/);
  await writeFile(p.state,JSON.stringify({...initial(T0),updatedAt:T0+DAY}));
  await assert.rejects(runListingWatch({root,fetcher,clock,pace:0}),/earlier than the saved observation/);
  assert.equal((await stat(p.lock).catch(()=>null)),null,'the lock is released after every refusal');
  assert.equal(await stat(p.snapshot).catch(()=>null),null);
});

test('the lock keeps concurrent runs apart and a crashed run cannot block collection forever',async t=>{
  const root=await tmpRoot(t),p=listingWatchPaths(root),clock=ctl(T0+5),fetcher=fetcherFor(world());
  await mkdir(p.lock,{recursive:true});
  const fresh=(Date.now()/1000);const liveClock=()=>fresh;
  await assert.rejects(runListingWatch({root,fetcher,clock:liveClock,pace:0}),/holds the lock/);
  assert.ok(await stat(p.lock),'a live lock is never removed by a refused run');
  const old=(Date.now()-3600e3)/1000;await utimes(p.lock,old,old);
  const run=await runListingWatch({root,fetcher,clock:liveClock,pace:0});
  assert.equal(run.published,true);assert.equal(await stat(p.lock).catch(()=>null),null);
});

// ---------------------------------------------------------------------- UI
function snapshotFixture(){
  let s=applyExchange(initial(T0),universe(),T0).state;
  s=applyBrokerage(s,brokerUniverse(),T0+1).state;
  s=applyExchange(s,[...universe(),rec('NEWA-USD',{auction_mode:true}),rec('C1-USD',{limit_only:true})],T0+300).state;
  s=applyExchange(s,[...universe().slice(2),rec('C1-USD',{limit_only:true}),rec('NEWA-USD',{limit_only:true})],T0+600).state;
  s=applyIncidents(s,[listingIncident(),suspensionIncident('monitoring',false)],T0+601).state;
  s=recordSourceFailure(s,'brokerage','Public data HTTP 503 <b>x</b>',T0+602);
  return core.listingWatchSnapshot(s,{generatedAt:T0+700});
}
test('the panel shows read times, source errors, launches, changes, the watchlist and the labeled historical study',()=>{
  const snap=snapshotFixture(),html=listingWatchPanel(snap,{now:T0+800});
  for(const text of ['Observation only','no orders','not continuous quotes','Exchange product list','Advanced Trade listing feed','Exchange status incidents','1-minute launch candles','Last successful read','Read failed','Latest read failed','earlier good data is kept','NEWA-USD','new asset','Phases observed','auction','limit-only','changed between','Delisting and suspension watchlist','BADGER-USD','Upcoming','status.exchange.coinbase.com/incidents/bczrbdtb1fd5','avoid','1-minute candles'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/<b>x<\/b>/,'source error text is escaped');assert.match(html,/&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html,/Collection delayed/);assert.match(listingWatchPanel(snap,{now:T0+700+core.SOURCE_KEYS.length*10000}),/Collection delayed/);
  assert.ok(html.includes('datetime="'+new Date(T0*1000).toISOString().replace(/\.\d{3}Z$/,'Z')+'"'),'times carry their exact UTC value');
});
test('the historical study is static, labeled and states its limits',()=>{
  const html=studyBox();
  for(const text of ['Historical study, not live results','216 Coinbase listings','June 2023 to August 2026','Survivors only','+2.6%','\u22121.6%','41% win','\u22126.9%','\u221213.6%','27% win','\u221214.4%','\u221226.1%','25% win','1.8% round-trip','+15%','not a tradable result','Survivorship makes real results worse','auction of at least 10 minutes','single opening price','then limit-only trading, then full trading','hours apart','\u221213% at day 8 and \u221240% at day 91','90 days'])assert.ok(html.includes(text),text);
  assert.equal(core.HISTORICAL_STUDY.rows.length,3);assert.equal(core.AVOID_DAYS,90);
  assert.ok(Object.isFrozen(core.HISTORICAL_STUDY));
});
test('an unpublished or empty Listing Watch invents nothing',()=>{
  const none=listingWatchPanel(undefined,{error:'HTTP 404'});
  assert.match(none,/not published yet/);assert.match(none,/HTTP 404/);assert.match(none,/not backfilled/);assert.match(none,/Historical study, not live results/);
  assert.doesNotMatch(none,/\d+ new asset/);
  const fresh=core.listingWatchSnapshot(applyIncidents(applyBrokerage(applyExchange(initial(T0),universe(),T0).state,brokerUniverse(),T0+1).state,[],T0+2).state,{generatedAt:T0+5});
  const html=listingWatchPanel(fresh,{now:T0+60});
  assert.match(html,/No launch captured yet/);assert.match(html,/nothing before it is backfilled/);assert.match(html,/No state change observed yet/);assert.match(html,/No suspension or delisting notice in the feed/);
  assert.match(html,/Not read yet|Idle/);assert.equal(LISTING_WATCH_TITLE,'Listing Watch');
  assert.match(sourceRow('status',{label:'X',status:'error',lastError:'HTTP 500',lastOkAt:null}),/Nothing is shown for this source/);
});
test('hostile text from the status feed is escaped before display',()=>{
  const hostile=incident('ev11il22','Upcoming Trading Suspension: EVIL-USD <img src=x onerror=alert(1)>','monitoring',[update('h','We will suspend trading on EVIL-USD on 1 March 2027. <script>alert(1)</script>',T0)]);
  const s=applyIncidents(initial(T0),[hostile],T0+5).state;
  const html=listingWatchPanel(core.listingWatchSnapshot(s,{generatedAt:T0+10}),{now:T0+20});
  assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img src=x/);
});
test('a notice whose stated time has passed is shown as due, not silently upcoming',()=>{
  const w={incidentId:'abcd1234',incident:'Upcoming Trading Suspension: X-USD',noticeAt:T0-DAY,effectiveDate:'2026-09-29',effectiveAt:T0,executedAt:null,status:'upcoming',scope:'asset',products:['X-USD'],assets:['X']};
  assert.match(watchRecord(w,T0-60),/Upcoming/);assert.doesNotMatch(watchRecord(w,T0-60),/>Due</);
  assert.match(watchRecord(w,T0+60),/>Due</);assert.match(watchRecord(w,T0+60),/not yet confirmed/);
});
test('transitions read naturally',()=>{
  assert.equal(describeTransition({field:'first-seen',to:'auction'}),'first seen as auction');
  assert.equal(describeTransition({field:'auction_mode',from:true,to:false}),'auction mode off');
  assert.equal(describeTransition({field:'limit_only',from:false,to:true}),'limit-only on');
  assert.equal(describeTransition({field:'status',from:'online',to:'delisted'}),'status online \u2192 delisted');
  assert.equal(describeTransition({field:'presence',to:'absent',src:'brokerage'}),'Advanced Trade: left the feed');
});

// ---------------------------------------------------------------- wiring
test('the build publishes the modules and stylesheet, the page mounts the section and the workflow stays best effort',async()=>{
  const read=f=>readFile(new URL(f,import.meta.url),'utf8');
  const build=await read('../scripts/build-site.mjs'),html=await read('../dashboard/crypto.html'),wf=await read('../.github/workflows/opportunities.yml');
  for(const f of ['listing-watch-core.mjs','listing-watch-ui.mjs','listing-watch.css'])assert.ok(build.includes(`'${f}'`),f);
  assert.ok(build.includes("'listing-watch'"),'the optional snapshot is copied when present');assert.ok(build.includes("e.code!=='ENOENT'"));
  for(const text of ['id="listing-watch"','id="listing-watch-body"','listing-watch-ui.mjs','listing-watch.css','>Listing Watch<'])assert.ok(html.includes(text),text);
  const step=/- name: Observe Coinbase listings[^\n]*\n\s+id: listingwatch\n\s+continue-on-error: true\n\s+run: node scripts\/collect-listing-watch\.mjs/;
  assert.match(wf,step);
  assert.ok(wf.includes('dashboard/data/listing-watch.json')&&wf.includes('data/listing-watch/state.json'));
  assert.match(wf,/for file in dashboard\/data\/listing-watch\.json data\/listing-watch\/state\.json; do\n\s+if \[ -f "\$file" \]; then git add "\$file"; fi/,'missing files are tolerated');
  assert.ok(!/steps\.listingwatch/.test(wf),'a Listing Watch failure never fails the tournament job');
  assert.ok(wf.indexOf('id: listingwatch')<wf.indexOf('Publish research snapshots'),'runs before the shared commit step');
});
test('no credential, order or live-worker path exists in the Listing Watch sources',async()=>{
  for(const f of ['../dashboard/listing-watch-core.mjs','../dashboard/listing-watch-ui.mjs','../scripts/collect-listing-watch.mjs']){
    const src=await readFile(new URL(f,import.meta.url),'utf8');
    assert.doesNotMatch(src,/Authorization|POST/,f);assert.doesNotMatch(src,/scripts\/live|process\.env|apiKey|api_key|secret/i,f);
    assert.doesNotMatch(src,/method:\s*['"](?!GET)/,f);
  }
  const doc=await readFile(new URL('../docs/CRYPTO-STRATEGIES.md',import.meta.url),'utf8');
  assert.ok(doc.includes('## Listing Watch'));assert.match(doc,/best effort/);assert.match(doc,/no orders/i);
});
