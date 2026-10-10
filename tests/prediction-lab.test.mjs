// Prediction Lab: isolated paper shadow books. Synthetic fixtures exercise rules,
// accounting and isolation; they are not evidence about any market.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,readdir,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fill,fee,planBet,newAccount,advanceAccount,validateAccount,forecast,PREDICTION_VERSION} from '../dashboard/prediction-core.mjs';
import {ENTRY_POLICY} from '../dashboard/prediction-entry.mjs';
import {LAB_BOOKS,LAB_LABEL,bookById,canonicalRule,shadowDrift,gameKey,sportOf,toLabMarket,screenMarket,planEntry,newLabState,ensureBooks,
  validateLabState,planRefresh,planResolution,advanceLab,accountEvidence,labSnapshot,validLabSnapshot,trackRecord,resumeCheck,weekIndex,sourceStateFor} from '../dashboard/prediction-lab-core.mjs';
import {labPanel,bookCard} from '../dashboard/prediction-lab-ui.mjs';
import {runLab,labPaths} from '../scripts/collect-prediction-lab.mjs';
import {snapshotUrl} from './fixtures/snapshot.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const now=1_790_000_000;
const round=n=>Math.round(n*1e6)/1e6;
function sides(bid,ask,depth=500){
  return {yes:{bid,bidSize:depth,bids:[[bid,depth]],asks:[[ask,depth]]},no:{bid:round(1-ask),bidSize:depth,bids:[[round(1-ask),depth]],asks:[[round(1-bid),depth]]}};
}
const kalshi=(o={})=>({id:'kalshi:KXNFLTD-26OCT04AAABBB-X1',venue:'kalshi',venueId:'KXNFLTD-26OCT04AAABBB-X1',eventId:'KXNFLTD-26OCT04AAABBB',seriesId:'KXNFLTD',
  category:'Sports',question:'Player scores?',displayTitle:'Player scores?',rules:'Official rules',status:'open',quoteAt:now,observedAt:now,closeAt:now+5*86400,
  feeRate:.07,minQuantity:1,url:'https://kalshi.com/markets/x',sides:sides(.69,.71),...o});
const poly=(o={})=>({id:'polymarket:aec-nfl-a-b',venue:'polymarket',venueId:'aec-nfl-a-b',eventId:'pm:1',seriesId:'nfl:SPORTS_MARKET_TYPE_MONEYLINE',
  category:'sports',question:'A wins',displayTitle:'A to win?',rules:'Official rules',status:'open',quoteAt:now-3600,observedAt:now,closeAt:now+2*86400,
  feeRate:.0695,minQuantity:1,eventSlug:'nfl-a-b',sides:sides(.49,.5),...o});
const fav=bookById('kalshi-favorite-3-7d'),yes=bookById('kalshi-yes-60-80'),base=bookById('market-baseline'),shadow=bookById('polymarket-fresh');
const ok={kalshi:{status:'ok',observedAt:now-60,checkedAt:now-70},polymarket:{status:'ok',observedAt:now-60,checkedAt:now-70}};
const inputs=(o={})=>({markets:[],snapshotMarkets:[],observations:[],settlements:{},sources:ok,snapshotAt:now-120,hash:sha,...o});
const acct=(state,id,venue='kalshi')=>state.books[id].accounts[venue];

// ---------- Pre-registration ----------
const PINNED={
  'kalshi-favorite-3-7d':'43ecd92da41470660c47be8cd8fdcb03336b724bcdbabdb8ad9028beac4ab2b1',
  'kalshi-yes-60-80':'2b1a71f67c60af6bd71871d111016729965db8d806acd347066aa7968ecfabe3',
  'market-baseline':'c78e35606d8125c62b22390c4e35969fdbfc6cee0cdeef1fc1827ea44c24a8d8',
  'polymarket-fresh':'7d6900aec038ce27bb58298d26f337bd0bd721112fd4ffcd313bb4777c81a278',
};
test('every book is pre-registered and frozen: a parameter or wording change needs a new book id',()=>{
  assert.deepEqual(LAB_BOOKS.map(b=>b.id),Object.keys(PINNED));
  for(const b of LAB_BOOKS){assert.equal(sha(canonicalRule(b)),PINNED[b.id],`${b.id} changed; register a new id instead`);assert.ok(Object.isFrozen(b)&&Object.isFrozen(b.params));}
});
test('the docs pre-register each book id, version, rule hash and the promotion screen',async()=>{
  const doc=await readFile(new URL('../docs/PREDICTION-LAB.md',import.meta.url),'utf8');
  for(const b of LAB_BOOKS){assert.ok(doc.includes(b.id));assert.ok(doc.includes(PINNED[b.id]),`hash for ${b.id}`);}
  assert.ok(doc.includes(LAB_LABEL));assert.match(doc,/50 settled events/);assert.match(doc,/\+50%/);
  const main=await readFile(new URL('../docs/PREDICTIONS.md',import.meta.url),'utf8');
  assert.match(main,/Prediction Lab/);assert.match(main,/untouched/);
});
test('the shadow book is pinned to the live existing policy and reports drift instead of following it',()=>{
  assert.equal(shadowDrift(shadow),null);
  for(const k of ['minCohort','minBin','marketPriorWeight','probabilityBuffer','version'])assert.equal(shadow.params.entryPolicy[k],ENTRY_POLICY[k]);
  const drifted={...shadow,params:{...shadow.params,entryPolicy:{...shadow.params.entryPolicy,minCohort:21}}};
  assert.match(shadowDrift(drifted),/new book id/);
});

// ---------- Market helpers and rules ----------
test('sibling props on one game are one event; unrelated events stay separate',()=>{
  assert.equal(gameKey(kalshi()),gameKey(kalshi({eventId:'KXNFL1Q-26OCT04AAABBB'})));
  assert.notEqual(gameKey(kalshi()),gameKey(kalshi({eventId:'KXNFLTD-26OCT04CCCDDD'})));
  assert.equal(gameKey(kalshi({category:'Mentions',eventId:'KXHIGHNY-26SEP29'})),'kalshi:KXHIGHNY-26SEP29');
  assert.notEqual(gameKey(kalshi({eventId:'KXNFLMVP-26'})),gameKey(kalshi({eventId:'KXNBAMVP-26'})));
  assert.equal(gameKey(poly()),'polymarket:pm:1');
  assert.deepEqual([sportOf(kalshi()),sportOf(kalshi({seriesId:'KXNCAAFSPREAD'})),sportOf(poly({seriesId:'cfb:SPORTS_MARKET_TYPE_MONEYLINE'})),sportOf(kalshi({seriesId:'KXRT',category:'Entertainment'}))],
    ['NFL','NCAAF','NCAAF','Entertainment']);
});
test('favorite rule: 3 to 7 days, favored side 0.55 to 0.85 on either side, spread at most 5 cents, fresh retrieval',()=>{
  assert.deepEqual(screenMarket(fav,kalshi(),now).side,'yes');
  const no=screenMarket(fav,kalshi({sides:sides(.29,.31)}),now);assert.equal(no.ok,true);assert.equal(no.side,'no');assert.equal(no.mid,.7);
  for(const [m,why] of [[kalshi({closeAt:now+71*3600}),/window/],[kalshi({closeAt:now+169*3600}),/window/],[kalshi({sides:sides(.5,.52)}),/band/],
    [kalshi({sides:sides(.86,.88)}),/band/],[kalshi({sides:sides(.6,.66)}),/Spread/],[kalshi({observedAt:now-91,quoteAt:now-91}),/90 seconds/],
    [kalshi({sourceError:'Book refresh failed'}),/Source error/],[kalshi({feeRate:null}),/fee/],[kalshi({rules:''}),/rules/]]){
    const s=screenMarket(fav,m,now);assert.equal(s.ok,false);assert.ok(s.reasons.some(r=>why.test(r)),`${why} ${s.reasons}`);
  }
  assert.equal(screenMarket(fav,kalshi({closeAt:now+72*3600,sides:sides(.54,.56)}),now).ok,true,'boundaries are inclusive');
  assert.equal(screenMarket(fav,kalshi({venue:'polymarket'}),now).ok,false);
});
test('YES rule buys YES only at 0.60 to 0.80 with spread at most 4 cents; control needs a favorite above 0.90 with over 6 hours',()=>{
  assert.equal(screenMarket(yes,kalshi(),now).side,'yes');
  assert.equal(screenMarket(yes,kalshi({sides:sides(.29,.31)}),now).ok,false);
  assert.equal(screenMarket(yes,kalshi({sides:sides(.6,.65)}),now).ok,false);
  assert.equal(screenMarket(yes,kalshi({sides:sides(.6,.64)}),now).ok,true);
  assert.equal(screenMarket(yes,kalshi({closeAt:now+23*3600}),now).ok,false);
  assert.equal(screenMarket(base,kalshi({sides:sides(.895,.905)}),now).ok,false,'0.90 itself is excluded');
  assert.equal(screenMarket(base,kalshi({sides:sides(.05,.07)}),now).side,'no');
  assert.equal(screenMarket(base,kalshi({sides:sides(.93,.95),closeAt:now+6*3600}),now).ok,false);
  assert.equal(screenMarket(base,toLabMarket(poly({sides:sides(.93,.94)})),now).ok,true,'Polymarket freshness uses retrieval time, not the old venue book time');
  assert.equal(screenMarket(base,poly({sides:sides(.93,.94)}),now).ok,false,'the venue book-change time alone would reject it');
});
test('sizing uses the unchanged paper cost model: walked depth, fees rounded up per fill, 1 cent slippage, whole contracts',()=>{
  const a=newAccount('kalshi',now),p=planEntry(fav,kalshi(),'yes',a,now);
  assert.equal(p.status,'candidate');assert.deepEqual(p.fill,fill([[.71,500]],2,.07));
  assert.equal(p.fill.fees,fee(.07,.71,2));assert.equal(p.fill.slippage,.02);assert.ok(p.fill.cost<=2);
  assert.equal(planEntry(fav,kalshi(),'yes',{...a,equity:50,cash:50},now).fill.quantity,1);
  const thin=kalshi({sides:{...sides(.69,.71),yes:{bid:.69,bidSize:1,bids:[[.69,1]],asks:[[.71,1]]}}});
  assert.equal(planEntry(fav,thin,'yes',a,now).fill.quantity,1,'depth bounds quantity');
  // The control rounds 0.5% up to one contract only inside its 1.5% per-event cap, and never buys a contract costing $1 or more.
  assert.equal(planEntry(base,kalshi({sides:sides(.93,.95)}),'yes',a,now).fill.quantity,1);
  assert.equal(planEntry(base,kalshi({sides:sides(.93,.95)}),'yes',{...a,equity:60,cash:60},now).status,'held');
  assert.equal(planEntry(base,kalshi({sides:sides(.98,.99)}),'yes',a,now).status,'held');
  const full={...a,positions:Array.from({length:10},(_,i)=>({cost:1.9,id:String(i)}))};
  assert.match(planEntry(fav,kalshi(),'yes',full,now).reasons.join(' '),/exposure/);
});

// ---------- Advancing books ----------
test('books start at their first run with $100 each, enter one position per game, and keep full ledgers',()=>{
  const sib=kalshi({id:'kalshi:KXNFL1Q-26OCT04AAABBB-A',eventId:'KXNFL1Q-26OCT04AAABBB',sides:sides(.66,.67)});
  const other=kalshi({id:'kalshi:KXNFLTD-26OCT04CCCDDD-X',eventId:'KXNFLTD-26OCT04CCCDDD',sides:sides(.29,.31)});
  const {state,receipt}=advanceLab(null,inputs({markets:[kalshi(),sib,other]}),now);
  validateLabState(state);
  for(const b of LAB_BOOKS)for(const v of b.venues){const a=acct(state,b.id,v);assert.equal(a.startedAt,now);assert.equal(a.initialCapital,100);assert.equal(a.mode,'paper');}
  const a=acct(state,fav.id);
  assert.deepEqual(a.positions.map(p=>[p.marketId,p.side]).sort(),[[sib.id,'yes'],[other.id,'no']].sort(),'tightest spread chosen per game');
  const p=a.positions.find(x=>x.marketId===sib.id);
  assert.equal(p.observedAt,now);assert.equal(p.gameKey,'kalshi:game:26OCT04AAABBB');assert.equal(p.midSide,.665);assert.equal(p.intent,undefined);
  assert.equal(a.cash,round(100-a.positions.reduce((n,x)=>n+x.cost,0)));
  assert.equal(receipt.books.find(r=>r.bookId===fav.id).opened.length,2);
  assert.deepEqual(acct(state,yes.id).positions.map(p=>p.marketId),[sib.id],'the YES book is a separate account and never buys NO');
  const again=advanceLab(state,inputs({markets:[kalshi({observedAt:now+600,quoteAt:now+600}),{...sib,observedAt:now+600,quoteAt:now+600}]}),now+600).state;
  assert.equal(acct(again,fav.id).positions.length,2,'no second position on a held game');
});
test('official settlement closes positions exactly once; a settled game is never re-entered',()=>{
  let {state}=advanceLab(null,inputs({markets:[kalshi()]}),now);
  const pos=acct(state,fav.id).positions[0],settle={[pos.marketId]:{yesPayout:1,observedAt:now+86400,source:'official'}};
  state=advanceLab(state,inputs({settlements:settle,markets:[]}),now+86400).state;
  const a=acct(state,fav.id);
  assert.equal(a.positions.length,0);assert.equal(a.trades[0].payout,pos.quantity);assert.equal(a.trades[0].pnl,round(pos.quantity-pos.cost));
  assert.equal(a.cash,round(100-pos.cost+pos.quantity));validateAccount(a,'kalshi');
  const fresh=kalshi({observedAt:now+86400+60,quoteAt:now+86400+60,closeAt:now+5*86400});
  state=advanceLab(state,inputs({settlements:settle,markets:[fresh]}),now+86400+60).state;
  assert.equal(acct(state,fav.id).trades.length,1);assert.equal(acct(state,fav.id).positions.length,0);
});
test('explicit source-error states: missing, stale or failed sources make no entries and are recorded',()=>{
  const missing=advanceLab(null,inputs({markets:[kalshi()],snapshotError:'snapshot file not found'}),now).state;
  assert.equal(acct(missing,fav.id).positions.length,0);assert.equal(acct(missing,fav.id).sourceState.status,'error');assert.match(acct(missing,fav.id).sourceState.message,/not found/);
  const stale=advanceLab(null,inputs({markets:[kalshi()],snapshotAt:now-3000}),now).state;
  assert.equal(acct(stale,fav.id).sourceState.status,'stale');assert.equal(acct(stale,fav.id).positions.length,0);
  const down=advanceLab(null,inputs({markets:[kalshi()],sources:{...ok,kalshi:{status:'error',error:'HTTP 503'}}}),now).state;
  assert.equal(acct(down,fav.id).sourceState.status,'error');assert.equal(acct(down,fav.id).positions.length,0);
  assert.equal(sourceStateFor('kalshi',{snapshotAt:now,sources:{}},now).status,'error');
  // A failed mark keeps the last valid mark with its original time and says so.
  let {state}=advanceLab(null,inputs({markets:[kalshi()]}),now);
  const before=acct(state,fav.id).positions[0];
  state=advanceLab(state,inputs({markets:[],refreshFailures:{[before.marketId]:'HTTP 500'}}),now+600).state;
  const a=acct(state,fav.id);
  assert.equal(a.markComplete,false);assert.equal(a.positions[0].markAt,before.markAt);assert.equal(a.sourceState.staleMarks,1);assert.equal(a.sourceState.markFailures,1);
  assert.throws(()=>advanceLab(state,inputs(),now),/backwards/);
});
test('a changed registered rule is never advanced and its account is left exactly as it was',()=>{
  let {state}=advanceLab(null,inputs({markets:[kalshi()]}),now);
  state.books[fav.id].canonical=state.books[fav.id].canonical.replace('0.55','0.50');
  const frozen=structuredClone(acct(state,fav.id));
  const out=advanceLab(state,inputs({markets:[kalshi({id:'kalshi:KXNFLTD-26OCT04EEEFFF-X',eventId:'KXNFLTD-26OCT04EEEFFF',observedAt:now+600,quoteAt:now+600})]}),now+600);
  assert.deepEqual(acct(out.state,fav.id),frozen);
  assert.ok(out.errors.some(e=>e.stage==='frozen-rule'&&e.bookId===fav.id));
  assert.equal(acct(out.state,yes.id).positions.length,2,'other books continue');
});
test('corrupt lab state is refused rather than reset',()=>{
  const {state}=advanceLab(null,inputs({markets:[kalshi()]}),now);
  for(const mutate of [s=>acct(s,fav.id).cash+=1,s=>delete s.forecasts,s=>acct(s,fav.id).bookId='other',s=>s.schemaVersion=2]){
    const s=structuredClone(state);mutate(s);assert.throws(()=>validateLabState(s),/refusing to reset/);
  }
});

// ---------- Shadow of the existing Polymarket policy ----------
function history(m,n=40,payout=1){
  const f=forecast(m,[],now);
  return Array.from({length:n},(_,i)=>({version:PREDICTION_VERSION,venue:'polymarket',eventId:'pm:past'+i,marketId:'polymarket:past'+i,cohort:f.cohort,bin:f.bin,at:now-9000,resolvedAt:now-8000,payout,baseline:.5}));
}
test('shadow uses retrieval-time freshness and the unchanged two-scan policy; the real policy would reject the same book',()=>{
  const m=poly(),obs=history(m);
  assert.match(planBet(m,'yes',{eligible:true,probability:.9,lower:.8,upper:.95},newAccount('polymarket',now),now).reasons.join(' '),/Fresh executable book/,'existing path uses the venue book time');
  let out=advanceLab(null,inputs({markets:[m],snapshotMarkets:[m],observations:obs}),now);
  assert.equal(acct(out.state,shadow.id,'polymarket').positions.length,0);assert.equal(Object.keys(acct(out.state,shadow.id,'polymarket').pending).length,1);
  out=advanceLab(out.state,inputs({markets:[poly({observedAt:now+600,quoteAt:now-3000})],observations:obs,snapshotAt:now+500}),now+600);
  const a=acct(out.state,shadow.id,'polymarket'),p=a.positions[0];
  assert.equal(p.side,'yes');assert.ok(p.cost<=2);assert.equal(p.observedAt,now+600);assert.equal(p.venueQuoteAt,now-3000);assert.equal(p.quoteAt,now+600);
  assert.equal(p.intent,undefined);assert.equal(p.rules,undefined);assert.equal(p.forecast.entryPolicy,ENTRY_POLICY.version);assert.ok(p.modelSide>p.midSide);
  assert.ok(out.state.forecasts.length>=1,'a shadow forecast is logged for the track record');
});
test('a 10% drawdown pauses the shadow (not a permanent halt) until 7 days and 20 fresh forecasts no worse than the market',()=>{
  let {state}=advanceLab(null,inputs(),now);
  acct(state,shadow.id,'polymarket').peak=115;
  state=advanceLab(state,inputs(),now+60).state;
  const a=acct(state,shadow.id,'polymarket');
  assert.equal(a.halted,true);assert.equal(a.pause.startedAt,now+60);assert.equal(a.pause.resumeNotBefore,now+60+7*86400);
  // The existing account arithmetic alone would stay halted forever.
  assert.equal(advanceAccount({...newAccount('polymarket',now),peak:115},[],[],{},now+60).halted,true);
  const f=(i,est,payout,at=now+120)=>({key:'k'+i,marketId:'polymarket:f'+i,eventId:'pm:f'+i,cohort:'c',at,closeAt:at,baseline:.6,estimate:est,stage:'experimental',payout,resolvedAt:at+10});
  const good=Array.from({length:20},(_,i)=>f(i,.65,1)),bad=Array.from({length:20},(_,i)=>f(i,.4,1));
  const day8=now+60+8*86400;
  for(const [forecasts,t,expect] of [[good,now+60+6*86400,true],[good.slice(1),day8,true],[bad,day8,true],[good.map(x=>({...x,at:now})),day8,true],[good,day8,false]]){
    const s=structuredClone(state);s.forecasts=forecasts;
    const after=acct(advanceLab(s,inputs(),t).state,shadow.id,'polymarket');
    assert.equal(after.halted,expect,`expected halted=${expect}`);
    if(!expect){assert.equal(after.pause,null);assert.equal(after.peak,after.equity);assert.equal(after.pauses.length,1);}
  }
  assert.equal(trackRecord(good,now).n,20);assert.ok(resumeCheck(shadow,{startedAt:now,resumeNotBefore:now},good,now).ok);
});

// ---------- Evidence and promotion screen ----------
function trade(i,{pnl=.2,fees=.02,slippage=.02,sport='NFL',closeAt=now+(i%4)*7*86400,midSide=.7,win=true}={}){
  return {id:'t'+i,marketId:'kalshi:m'+i,eventId:'e'+i,gameKey:'g'+i,sport,seriesId:'S'+sport,side:'yes',quantity:2,cost:1.5,principal:1.46-fees-slippage+.04,fees,slippage,
    payout:win?2:0,pnl,closeAt,closedAt:closeAt+3600,midSide};
}
const account=trades=>({...newAccount('kalshi',now),positions:[],trades});
test('evidence status never claims an edge and tracks progress to the predeclared screen',()=>{
  assert.equal(accountEvidence(fav,account([])).status,'n=0 settled of 50 needed; not evidence yet.');
  const twelve=accountEvidence(fav,account(Array.from({length:12},(_,i)=>trade(i))));
  assert.equal(twelve.status,'n=12 settled of 50 needed; not evidence yet.');assert.equal(twelve.progress,.24);
  assert.ok(twelve.criteria.slice(2).every(c=>c.pass===null),'profit criteria are not assessed before the sample exists');
  const mixed=Array.from({length:60},(_,i)=>trade(i,{sport:['NFL','MLB','NCAAF'][i%3]}));
  const met=accountEvidence(fav,account(mixed));
  assert.equal(met.met,true);assert.equal(met.events,60);assert.equal(met.weeks,4);assert.match(met.status,/not proof of an edge/);
  const oneEvent=accountEvidence(fav,account(mixed.map((t,i)=>({...t,pnl:i?-.05:20}))));
  assert.equal(oneEvent.criteria.find(c=>c.id==='event').pass,false);assert.equal(oneEvent.met,false);
  assert.equal(accountEvidence(fav,account(Array.from({length:60},(_,i)=>trade(i)))).criteria.find(c=>c.id==='sport').pass,false,'one sport cannot pass');
  assert.equal(accountEvidence(fav,account(mixed.map(t=>({...t,pnl:.01})))).criteria.find(c=>c.id==='stress').pass,false,'+50% costs');
  assert.equal(accountEvidence(fav,account(mixed.map(t=>({...t,closeAt:now})))).criteria.find(c=>c.id==='weeks').pass,false);
  assert.match(accountEvidence(base,account(mixed)).status,/^Control: .*not a candidate/);
  for(const e of [twelve,met,oneEvent])assert.doesNotMatch(e.status,/has an edge|proven|profitable strategy/i);
  assert.equal(weekIndex(Date.UTC(2026,8,28)/1000),weekIndex(Date.UTC(2026,9,4,23)/1000),'Monday to Sunday is one UTC week');
});
test('pick calibration scores the entry midpoint (and the shadow model) against outcomes',()=>{
  const ts=[trade(0,{midSide:.8}),trade(1,{midSide:.8}),trade(2,{midSide:.8}),trade(3,{midSide:.8,win:false})];
  const p=accountEvidence(fav,account(ts)).picks;
  assert.equal(p.n,4);assert.equal(p.winRate,.75);assert.ok(Math.abs(p.meanMidpoint-.8)<1e-9);assert.ok(Math.abs(p.brierMidpoint-(3*.04+.64)/4)<1e-9);
  assert.equal(p.modelN,0);
});

// ---------- Planning, snapshot and UI ----------
test('refresh planning puts open positions first and picks one tightest-spread candidate per game; resolution is rate limited',()=>{
  let {state}=advanceLab(null,inputs({markets:[kalshi()]}),now);
  const snap=[kalshi({observedAt:now-300,quoteAt:now-300}),kalshi({id:'kalshi:KXNFL1Q-26OCT04CCCDDD-A',eventId:'KXNFL1Q-26OCT04CCCDDD',observedAt:now-300,sides:sides(.6,.63)}),
    kalshi({id:'kalshi:KXNFLTD-26OCT04CCCDDD-B',eventId:'KXNFLTD-26OCT04CCCDDD',observedAt:now-300,sides:sides(.6,.61)})];
  const plan=planRefresh(state,snap,[],now,{snapshotAt:now-120,sources:ok});
  assert.equal(plan.jobs[0].reason,'open position');
  assert.ok(plan.jobs.some(j=>j.ref.id==='kalshi:KXNFLTD-26OCT04CCCDDD-B'));assert.ok(!plan.jobs.some(j=>j.ref.id==='kalshi:KXNFL1Q-26OCT04CCCDDD-A'));
  assert.equal(planRefresh(state,snap,[],now,{snapshotAt:now-5000,sources:ok}).jobs.length,new Set(plan.jobs.filter(j=>j.reason==='open position').map(j=>j.ref.id)).size);
  const later=now+6*86400;
  assert.equal(planResolution(state,later).length,1);
  state.resolutionChecks[acct(state,fav.id).positions[0].marketId]=later-60;
  assert.equal(planResolution(state,later).length,0,'rechecked at most every 25 minutes');
});
test('the public snapshot validates, is paper-only and renders explicit statuses without trusting text',()=>{
  let {state}=advanceLab(null,inputs({markets:[kalshi({question:'<img src=x onerror=alert(1)>',displayTitle:'<img src=x onerror=alert(1)>'})],
    sources:{...ok,polymarket:{status:'error',error:'HTTP 503 at /v1/events'}}}),now);
  const s=labSnapshot(state,{generatedAt:now,sources:[],errors:[]});
  assert.equal(validLabSnapshot(s,now),true);assert.equal(s.realEnabled,false);assert.equal(s.mode,'paper');
  for(const bad of [x=>x.realEnabled=true,x=>x.mode='live',x=>x.books[0].accounts[0].equity=null,x=>delete x.books[0].accounts[0].evidence])
  {const c=structuredClone(s);bad(c);assert.equal(validLabSnapshot(c,now),false);}
  assert.doesNotMatch(JSON.stringify(s),/Official rules|"intent"|apiKey|private_key|secret/i);
  const html=labPanel(s,{now});
  assert.match(html,/n=0 settled of 50 needed/);assert.match(html,/Source error/);assert.match(html,/HTTP 503/);
  assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&lt;img'));
  assert.match(labPanel(s,{now:now+4000}),/Collection delayed/);
  assert.match(labPanel(undefined,{error:'HTTP 404'}),/not published yet/);
  assert.match(bookCard(s.books.find(b=>b.id==='market-baseline'),now),/Polymarket US account/);
});

// ---------- Collector isolation ----------
async function fixtureRoot(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'prediction-lab-'));
  await mkdir(path.join(dir,'dashboard/data'),{recursive:true});await mkdir(path.join(dir,'data/predictions'),{recursive:true});
  const accounts={polymarket:newAccount('polymarket',now-86400),kalshi:newAccount('kalshi',now-86400)};
  await writeFile(path.join(dir,'dashboard/data/predictions.json'),JSON.stringify({generatedAt:now-100,markets:[kalshi({observedAt:now-200,quoteAt:now-200}),poly({observedAt:now-200})],
    sources:[{venue:'kalshi',status:'ok',observedAt:now-200},{venue:'polymarket',status:'ok',observedAt:now-200}],accounts}));
  await writeFile(path.join(dir,'data/predictions/state.json'),JSON.stringify({accounts,observations:[],settlements:{}}));
  return dir;
}
const digest=async file=>sha(await readFile(file));
test('the collector writes only its own two files, never the existing accounts, and a second run does not duplicate',async()=>{
  const src=await fixtureRoot(),out=await mkdtemp(path.join(os.tmpdir(),'prediction-lab-out-'));
  const before=[await digest(path.join(src,'dashboard/data/predictions.json')),await digest(path.join(src,'data/predictions/state.json'))];
  let t=now;const calls=[];
  const feed={refresh:async ref=>{calls.push(ref.id);const m=ref.venue==='kalshi'?kalshi():poly();return {...m,observedAt:t,quoteAt:ref.venue==='kalshi'?t:now-3600};},resolve:async()=>null};
  const quiet={log(){},error(){}};
  const first=await runLab({root:out,sourceRoot:src,feed,clock:()=>t,log:quiet});
  assert.equal(first.published,true);
  assert.deepEqual(before,[await digest(path.join(src,'dashboard/data/predictions.json')),await digest(path.join(src,'data/predictions/state.json'))]);
  const files=async dir=>(await readdir(dir,{recursive:true})).filter(f=>!f.endsWith('predictions.json')&&!f.endsWith(`predictions${path.sep}state.json`));
  assert.deepEqual((await readdir(out,{recursive:true})).sort(),['dashboard','dashboard/data','dashboard/data/prediction-lab.json','data','data/prediction-lab','data/prediction-lab/state.json'].map(p=>p.split('/').join(path.sep)).sort());
  assert.ok(calls.includes(kalshi().id));
  const snap=JSON.parse(await readFile(labPaths(out).snapshot,'utf8'));
  assert.equal(validLabSnapshot(snap,now+1),true);
  t=now+600;await runLab({root:out,sourceRoot:src,feed,clock:()=>t,log:quiet});
  const state=JSON.parse(await readFile(labPaths(out).state,'utf8'));
  assert.equal(acct(state,fav.id).positions.length,1);assert.equal(state.cycles.length,2);
  await assert.rejects(stat(labPaths(out).lock));
  // Corrupt state is refused and left byte-for-byte as found.
  await writeFile(labPaths(out).state,'{"schemaVersion":1,"books":');
  const corrupt=await digest(labPaths(out).state);
  await assert.rejects(runLab({root:out,sourceRoot:src,feed,clock:()=>now+1200,log:quiet}),/no paper book reset/);
  assert.equal(await digest(labPaths(out).state),corrupt);
  void files;await rm(src,{recursive:true,force:true});await rm(out,{recursive:true,force:true});
});
test('a missing source snapshot starts books with explicit errors and no invented entries',async()=>{
  const out=await mkdtemp(path.join(os.tmpdir(),'prediction-lab-missing-'));
  const r=await runLab({root:out,sourceRoot:out,feed:{refresh:async()=>{throw new Error('unused');},resolve:async()=>null},clock:()=>now,log:{log(){},error(){}}});
  assert.equal(r.allSourcesFailed,true);
  for(const b of LAB_BOOKS)for(const v of b.venues){const a=acct(r.state,b.id,v);assert.equal(a.cash,100);assert.equal(a.positions.length,0);assert.equal(a.sourceState.status,'error');}
  await rm(out,{recursive:true,force:true});
});
test('lab modules contain no order, credential or live-execution path',async()=>{
  for(const f of ['../dashboard/prediction-lab-core.mjs','../dashboard/prediction-lab-ui.mjs','../scripts/collect-prediction-lab.mjs','../scripts/prediction-lab-feed.mjs','../scripts/analyze-predictions.mjs']){
    const src=await readFile(new URL(f,import.meta.url),'utf8');
    assert.doesNotMatch(src,/orderIntent|Authorization|Bearer|COINBASE|private_key|apiKey|api_key|method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/i,f);
    assert.doesNotMatch(src,/scripts\/live|predlive|execution\//,f);
  }
});

// ---------- Site and workflow wiring ----------
test('overview page, build allowlist and workflow wire the Lab without touching the two accounts',async()=>{
  const html=await readFile(new URL('../dashboard/focus.html',import.meta.url),'utf8');
  assert.ok(html.includes(LAB_LABEL));assert.ok(html.includes('id="prediction-lab-books"'));
  assert.ok(html.includes('prediction-lab-ui.mjs'));assert.ok(html.includes('prediction-lab.css'));
  const build=await readFile(new URL('../scripts/build-site.mjs',import.meta.url),'utf8');
  for(const f of ['prediction-lab-core.mjs','prediction-lab-ui.mjs','prediction-lab.css'])assert.ok(build.includes(`'${f}'`));
  assert.match(build,/\['prediction-lab'\]\)try\{await cp/);
  const wf=await readFile(new URL('../.github/workflows/predictions.yml',import.meta.url),'utf8');
  assert.ok(wf.includes('git add dashboard/data/predictions.json data/predictions/state.json'));
  const accountsPublish=wf.indexOf('Publish without replacing another writer'),lab=wf.indexOf('node scripts/collect-prediction-lab.mjs');
  assert.ok(accountsPublish>0&&lab>accountsPublish,'the Lab runs after the accounts are published');
  const steps=wf.split('      - name: ').filter(s=>/^(Verify Prediction Lab|Advance the isolated paper Prediction Lab|Publish the Prediction Lab)/.test(s));
  assert.equal(steps.length,3);for(const s of steps)assert.match(s,/continue-on-error: true/);
  assert.doesNotMatch(wf,/--force|-f origin/);
});
test('the published Prediction Lab snapshot, when present, satisfies the dashboard contract',{skip:process.env.MM_LIVE_SNAPSHOTS!=='1'},async()=>{
  let raw;try{raw=await readFile(snapshotUrl('prediction-lab.json'),'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
  assert.equal(validLabSnapshot(JSON.parse(raw)),true);
});
void newLabState;void ensureBooks;
