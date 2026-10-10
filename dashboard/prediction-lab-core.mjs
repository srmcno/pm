// Prediction Lab: isolated PAPER shadow books that run beside, never inside, the two
// existing $100 prediction accounts. Pure and deterministic: no I/O, no clock, no
// network, no credentials and no order path. The collector supplies observed books.
//
// Read docs/PREDICTION-LAB.md first. Every book below is pre-registered: its id,
// version, rule text and parameters are frozen, and a change means a NEW book id.
// The registry text is part of the frozen record; do not reword a shipped rule.
import {POLICY,fill,liquidation,midpoint,round,quoteValid,newAccount,validateAccount,advanceAccount} from './prediction-core.mjs';
import {ENTRY_POLICY,entryForecast,entryPlan} from './prediction-entry.mjs';

const finite=Number.isFinite;
export const LAB_VERSION='2026-09-29-prediction-lab-v1';
export const LAB_LABEL='Shadow experiments. Paper only. No real orders. Not the two $100 accounts.';
export const LAB_CAPITAL=100;
// Freshness is seconds since THIS collector retrieved the book, never the venue's last book-change time.
export const LAB_FRESH_SECONDS=90;
export const LAB_SNAPSHOT_MAX_AGE=1200;
export const LAB_DELAY_SECONDS=1800;
export const PROMOTION_SCREEN=Object.freeze({version:'2026-09-29-screen-v1',minSettledEvents:50,minPeriods:3,costStress:1.5,
  text:'At least 50 settled events across at least 3 distinct UTC weeks, positive net P&L after modeled costs, still positive with fees and slippage 50% higher, and still positive after removing the best single event and after removing the best single sport.'});
export const LAB_INVARIANTS=Object.freeze([
  'Each book is its own $100 paper account per venue it trades, started at its first scheduled run. No backfill.',
  'Costs are the existing paper cost model unchanged: walked ask depth, taker fee rounded UP to a cent per fill, 1 cent per contract slippage.',
  'Entry needs displayed depth for the order and for a matching liquidation, a modeled all-in cost per contract below $1.00, whole contracts, and a book retrieved within 90 seconds.',
  'One position per event. Sibling markets of one game share an event key. A settled event is never re-entered.',
  'Positions hold to official settlement. There is no stop, no forced exit, no maker fill and no order path.',
]);

const params=o=>Object.freeze(o);
export const LAB_BOOKS=Object.freeze([
  Object.freeze({id:'kalshi-favorite-3-7d',version:1,role:'candidate',kind:'rule',title:'Kalshi favorites, 3 to 7 days',venues:Object.freeze(['kalshi']),
    rule:'Kalshi binary markets scheduled to close 3 to 7 days away (72 to 168 hours, inclusive). Take the favored side: the side whose midpoint is at least 0.55 and at most 0.85, YES or NO. Reject a market whose bid/ask spread exceeds 5 cents, whose book was not retrieved within 90 seconds, or whose fee or rules are missing. Buy the favored side as a taker through the observed ask depth. One position per event: all markets on one game are one event and the tightest-spread market is chosen. Flat stake of 2% of book equity in whole contracts, at most 20% of equity open. Hold to settlement.',
    params:params({side:'favored',minHours:72,maxHours:168,minMid:.55,maxMid:.85,maxSpread:.05,stakePct:.02,perEventCapPct:.02,maxOpenPct:.20})}),
  Object.freeze({id:'kalshi-yes-60-80',version:1,role:'candidate',kind:'rule',title:'Kalshi YES at 60 to 80%',venues:Object.freeze(['kalshi']),
    rule:'Kalshi binary markets scheduled to close 24 hours to 14 days away (24 to 336 hours, inclusive). Buy YES only, when the YES midpoint is at least 0.60 and at most 0.80. Reject a market whose spread exceeds 4 cents, whose book was not retrieved within 90 seconds, or whose fee or rules are missing. Taker fill through the observed ask depth. One position per event with the tightest-spread market chosen. Flat stake of 1% of book equity in whole contracts, at most 10% of equity open. Hold to settlement.',
    params:params({side:'yes',minHours:24,maxHours:336,minMid:.60,maxMid:.80,maxSpread:.04,stakePct:.01,perEventCapPct:.01,maxOpenPct:.10})}),
  Object.freeze({id:'market-baseline',version:1,role:'control',kind:'rule',title:'Market baseline control',venues:Object.freeze(['kalshi','polymarket']),
    rule:'Control that measures pure cost drag, not a candidate for promotion. On Kalshi and on Polymarket US (a separate $100 account for each) buy the favored side only when its midpoint is above 0.90 and more than 6 hours (up to 30 days) remain. Reject a market whose spread exceeds 5 cents or whose book was not retrieved within 90 seconds. Taker fill through the observed ask depth. Target stake 0.5% of book equity, rounded up to one whole contract when the target is below one contract and that contract costs at most 1.5% of equity. One position per event, at most 10% of equity open. Hold to settlement.',
    params:params({side:'favored',minHours:6,minHoursExclusive:true,maxHours:720,minMid:.90,minMidExclusive:true,maxMid:1,maxMidExclusive:true,maxSpread:.05,stakePct:.005,perEventCapPct:.015,maxOpenPct:.10})}),
  Object.freeze({id:'polymarket-fresh',version:1,role:'shadow',kind:'shadow',title:'Polymarket US shadow of the existing policy',venues:Object.freeze(['polymarket']),
    rule:'Shadow of the existing experimental paper policy 2026-09-16-experimental-paper-v1, not a change to it. It calls the same forecast, planning and accounting functions on Polymarket US in a separate $100 shadow account. Two documented differences. First, book freshness is measured from this collector\'s retrieval time (90 seconds), not the venue\'s last book-change time, which had rejected books that were just fetched. Second, the permanent 10% peak-drawdown halt is replaced by a per-book pause: after a 10% drawdown new entries stop until 7 days have passed and at least 20 shadow forecasts recorded after the pause began have resolved with a Brier score no worse than the market midpoint on the same events; peak equity then resets to current equity. The real Polymarket US account, its halt and its policy are untouched.',
    params:params({entryPolicy:params({version:'2026-09-16-experimental-paper-v1',minCohort:20,minBin:10,marketPriorWeight:10,probabilityBuffer:.03}),
      corePolicy:params({initialCapital:100,maxStakePct:.02,maxExposurePct:.10,kellyFraction:.25,minEdge:.03,maxSpread:.05,maxQuoteAge:90,minHours:6,maxDays:30}),
      freshSeconds:90,freshnessFrom:'retrieval',pauseDrawdownPct:.10,pauseDays:7,pauseMinForecasts:20})}),
]);
export const bookById=id=>LAB_BOOKS.find(b=>b.id===id);

const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
// The frozen record. Any change to a shipped book changes this string.
export const canonicalRule=b=>stable({id:b.id,version:b.version,role:b.role,venues:b.venues,rule:b.rule,params:b.params});
// The shadow imports the live policy. If that policy moves, the shadow must be re-registered under a new id.
export function shadowDrift(book){
  if(book.kind!=='shadow')return null;
  const e=book.params.entryPolicy,c=book.params.corePolicy,bad=[];
  for(const k of Object.keys(e))if(e[k]!==ENTRY_POLICY[k])bad.push(`entry policy ${k}`);
  const live={initialCapital:POLICY.initialCapital,maxStakePct:POLICY.maxStakePct,maxExposurePct:POLICY.maxExposurePct,kellyFraction:POLICY.kellyFraction,minEdge:POLICY.minEdge,maxSpread:POLICY.maxSpread,maxQuoteAge:POLICY.maxQuoteAge,minHours:POLICY.minHours,maxDays:POLICY.maxDays};
  for(const k of Object.keys(c))if(c[k]!==live[k])bad.push(`core policy ${k}`);
  if(book.params.pauseDrawdownPct!==POLICY.maxDrawdownPct)bad.push('drawdown threshold');
  return bad.length?`The existing policy changed (${bad.join(', ')}); this shadow was registered against the earlier one. Register a new book id.`:null;
}

// ---------- Market helpers ----------
// The venue's last book-change time is kept for display; freshness uses retrieval time.
export const toLabMarket=m=>({...m,venueQuoteAt:m.venueQuoteAt??m.quoteAt,quoteAt:m.observedAt});
const GAME_SUFFIX=/^\d{2}[A-Z]{3}\d{2}/;
// Sibling markets on one game (moneyline, spread, totals, props) are ONE event.
export function gameKey(m){
  const ev=String(m?.eventId||m?.id||'');
  if(m?.venue==='kalshi'){
    const dash=ev.indexOf('-'),suffix=dash>0?ev.slice(dash+1):'';
    return m.category==='Sports'&&GAME_SUFFIX.test(suffix)?`kalshi:game:${suffix}`:`kalshi:${ev}`;
  }
  return `${m?.venue||'venue'}:${ev}`;
}
const SPORTS=['NCAAF','NCAAB','NFL','MLB','NBA','WNBA','NHL','MLS','UEFA','EPL','UCL','ATP','WTA','UFC','PGA','NASCAR','F1'];
export function sportOf(m){
  const s=String(m?.seriesId||'');
  if(m?.venue==='polymarket'&&s.includes(':')){const lg=s.split(':')[0].toUpperCase();return lg==='CFB'?'NCAAF':lg==='CBB'?'NCAAB':lg;}
  const t=s.toUpperCase().replace(/^KX/,'');
  for(const p of SPORTS)if(t.startsWith(p))return p;
  return m?.category&&m.category!=='Other'?String(m.category):'Other';
}
export const seriesOf=m=>String(m?.seriesId||'unknown');
export function sideMidpoint(m,side){const p=midpoint(m);return finite(p)?(side==='yes'?round(p):round(1-p)):null;}
export function sideSpread(m,side){const s=m?.sides?.[side],ask=s?.asks?.[0]?.[0];return finite(ask)&&finite(s?.bid)?round(ask-s.bid):null;}
const atLeast=(x,lo,exclusive)=>exclusive?x>lo:x>=lo;
const atMost=(x,hi,exclusive)=>exclusive?x<hi:x<=hi;

// ---------- Rule screening (books 1 to 3) ----------
export function screenMarket(book,m,now,{strict=true}={}){
  const p=book.params,reasons=[];
  if(!m)return {ok:false,reasons:['No market.']};
  if(!book.venues.includes(m.venue))reasons.push('This book does not trade this venue.');
  if(m.sourceError)reasons.push('Source error: a retained record, not a current book.');
  else if(!(strict?quoteValid(m,now):quoteValid(m,m.observedAt)))reasons.push(strict?'Book not retrieved within 90 seconds, or market not open.':'Market not open.');
  if(!m.eventId||!m.rules)reasons.push('Contract rules and event identity required.');
  if(!finite(m.feeRate))reasons.push('Current fee parameters required.');
  const hours=(m.closeAt-now)/3600;
  if(!finite(hours)||!atLeast(hours,p.minHours,p.minHoursExclusive)||!atMost(hours,p.maxHours))reasons.push(`Close is outside the ${p.minHours}-${p.maxHours} hour window.`);
  const yes=midpoint(m);
  let side=null,mid=null;
  if(finite(yes)){side=p.side==='yes'?'yes':yes>=.5?'yes':'no';mid=sideMidpoint(m,side);}
  else reasons.push('No two-sided midpoint.');
  if(finite(mid)&&(!atLeast(mid,p.minMid,p.minMidExclusive)||!atMost(mid,p.maxMid,p.maxMidExclusive)))reasons.push(`${side==='no'?'NO':'Chosen'} side midpoint ${mid.toFixed(3)} is outside the band.`);
  const spread=side?sideSpread(m,side):null;
  if(!finite(spread)||spread<0||spread>p.maxSpread+1e-9)reasons.push(`Spread must be at most ${Math.round(p.maxSpread*100)} cents.`);
  return {ok:!reasons.length,reasons,side,mid,spread,hours:finite(hours)?round(hours):null};
}
const exposureOf=a=>(a.positions||[]).reduce((n,p)=>n+p.cost,0);
export function planEntry(book,m,side,account,now){
  const p=book.params,reasons=[],s=m.sides?.[side];
  if(!s)return {status:'held',reasons:['No book for this side.']};
  const equity=account.equity,target=round(p.stakePct*equity),cap=round(p.perEventCapPct*equity);
  const room=round(p.maxOpenPct*equity-exposureOf(account)),minQty=Math.max(1,Math.ceil(m.minQuantity||1));
  const bids=s.bids||[[s.bid,s.bidSize]],ask=s.asks?.[0]?.[0];
  const good=q=>{const f=fill(s.asks,q,m.feeRate);return f&&f.cost/q<1&&liquidation(bids,q,m.feeRate)?f:null;};
  let chosen=null;
  if(finite(ask))for(let q=Math.min(200,Math.floor(target/Math.max(.001,ask)));q>=minQty;q--){const f=good(q);if(f&&f.cost<=target+1e-8){chosen=f;break;}}
  // A target below one contract rounds up to the minimum order only while that order is inside the per-event cap.
  if(!chosen){const f=good(minQty);if(f&&f.cost<=cap+1e-8)chosen=f;}
  if(!chosen)reasons.push('No whole-contract order fits the stake, cost per contract below $1 and two-sided depth.');
  if(chosen&&chosen.cost>account.cash+1e-8)reasons.push('Not enough cash.');
  if(chosen&&chosen.cost>room+1e-8)reasons.push('Open exposure limit reached.');
  return {status:reasons.length?'held':'candidate',reasons,fill:reasons.length?null:chosen,target,cap,room};
}
function openPosition(book,m,side,s,f,account,now){
  const bids=m.sides[side].bids||[[m.sides[side].bid,m.sides[side].bidSize]];
  return {id:`${book.id}:${m.id}:${side}:${now}`,bookId:book.id,bookVersion:book.version,marketId:m.id,eventId:m.eventId,gameKey:gameKey(m),
    sport:sportOf(m),category:m.category||'Other',seriesId:seriesOf(m),eventSlug:m.eventSlug||null,
    question:m.displayTitle||m.question,contractQuestion:m.question,side,quantity:f.quantity,cost:f.cost,principal:f.principal,fees:f.fees,slippage:f.slippage,
    entry:f.average,limitPrice:f.limitPrice,openedAt:now,quoteAt:m.quoteAt,venueQuoteAt:m.venueQuoteAt,observedAt:m.observedAt,closeAt:m.closeAt,
    markAt:m.quoteAt,markValue:liquidation(bids,f.quantity,m.feeRate).proceeds,feeRate:m.feeRate,midYes:round(midpoint(m)),midSide:s.mid,spread:s.spread,hours:s.hours,
    url:m.url||null,version:LAB_VERSION};
}
const settledIds=a=>new Set(a.trades.map(t=>t.id));
const describe=p=>({id:p.id,marketId:p.marketId,question:p.question,side:p.side,quantity:p.quantity,cost:p.cost,...(p.closedAt?{payout:p.payout,pnl:p.pnl}:{})});
const byTightSpread=(x,y)=>x.s.spread-y.s.spread||(x.m.id<y.m.id?-1:1);

function advanceRuleBook(book,venue,account,ctx){
  const {now,settlements,allowEntries}=ctx,venueMarkets=ctx.markets.filter(m=>m.venue===venue);
  const closed=settledIds(account);
  // Settlement and liquidation marks reuse the existing account arithmetic unchanged.
  const a=advanceAccount(account,venueMarkets,[],settlements,now);a.halted=false;
  const opened=[],declined=[];let eligible=0;
  if(allowEntries){
    const groups=new Map(),held=new Set([...a.positions,...a.trades].map(p=>p.gameKey).filter(Boolean));
    for(const m of venueMarkets){
      const s=screenMarket(book,m,now),k=gameKey(m);
      if(!s.ok||held.has(k))continue;
      const cur=groups.get(k);if(!cur||byTightSpread({m,s},cur)<0)groups.set(k,{m,s,k});
    }
    eligible=groups.size;
    for(const {m,s,k} of [...groups.values()].sort(byTightSpread)){
      const plan=planEntry(book,m,s.side,a,now);
      if(plan.status!=='candidate'){declined.push({marketId:m.id,reasons:plan.reasons});continue;}
      const pos=openPosition(book,m,s.side,s,plan.fill,a,now);
      a.cash=round(a.cash-pos.cost);a.fees=round(a.fees+pos.fees);a.positions.push(pos);held.add(k);opened.push(pos);
      a.equity=round(a.cash+a.positions.reduce((n,x)=>n+x.markValue,0));
    }
  }
  a.equity=round(a.cash+a.positions.reduce((n,x)=>n+x.markValue,0));
  if(a.markComplete)a.peak=Math.max(a.peak,a.equity);
  a.updatedAt=now;validateAccount(a,venue);
  return {account:a,receipt:{eligible,declined:declined.length,opened:opened.map(describe),settled:a.trades.filter(t=>!closed.has(t.id)).map(describe)}};
}

// ---------- Shadow of the existing Polymarket policy (book 4) ----------
export function trackRecord(forecasts,since){
  const rows=(forecasts||[]).filter(f=>f.at>=since&&[0,1].includes(f.payout)&&finite(f.estimate)&&finite(f.baseline));
  const mean=fn=>rows.length?rows.reduce((n,f)=>n+fn(f),0)/rows.length:null;
  const est=mean(f=>(f.estimate-f.payout)**2),mid=mean(f=>(f.baseline-f.payout)**2);
  return {n:rows.length,brierEstimate:est,brierMidpoint:mid,delta:est===null?null:est-mid};
}
export function resumeCheck(book,pause,forecasts,now){
  const track=trackRecord(forecasts,pause.startedAt),timeOk=now>=pause.resumeNotBefore,need=book.params.pauseMinForecasts;
  const trackOk=track.n>=need&&track.delta!==null&&track.delta<=0;
  return {ok:timeOk&&trackOk,timeOk,trackOk,track,need};
}
export function pauseText(book,pause,forecasts,now){
  const c=resumeCheck(book,pause,forecasts,now),parts=[];
  if(!c.timeOk)parts.push(`${Math.ceil((pause.resumeNotBefore-now)/86400)} more day(s)`);
  if(c.track.n<c.need)parts.push(`${c.need-c.track.n} more resolved forecast(s) (${c.track.n}/${c.need})`);
  else if(!c.trackOk)parts.push(`shadow forecasts must score no worse than the market (Brier difference ${c.track.delta.toFixed(4)} over ${c.track.n})`);
  return c.ok?'Pause conditions met; entries resume on the next run.':`Entries paused by the 10% drawdown pause. Needs ${parts.join(' and ')}.`;
}
function advanceShadow(book,venue,account,ctx){
  const {now,settlements,allowEntries,observations,forecasts}=ctx,venueMarkets=ctx.markets.filter(m=>m.venue===venue);
  const a=structuredClone(account);a.pause??=null;a.pauses??=[];
  const known=new Set([...a.positions,...a.trades].map(p=>p.id)),closed=settledIds(a);
  let resumed=false;
  if(a.pause&&resumeCheck(book,a.pause,forecasts,now).ok){a.pauses.push({...a.pause,resumedAt:now});a.pause=null;a.peak=a.equity;resumed=true;}
  a.halted=!!a.pause;
  const decisions=allowEntries?venueMarkets.flatMap(m=>{
    const estimate=entryForecast(m,observations,now);
    return ['yes','no'].map(side=>({marketId:m.id,venue,side,forecast:estimate,plan:entryPlan(m,side,estimate,a,now)}));
  }):[];
  const next=advanceAccount(a,venueMarkets,decisions,settlements,now);
  let paused=false;
  if(!a.pause&&next.halted){next.pause={startedAt:now,resumeNotBefore:now+book.params.pauseDays*86400,equityAtPause:next.equity,peakAtPause:next.peak};paused=true;}
  next.halted=!!next.pause;
  const opened=next.positions.filter(p=>!known.has(p.id));
  for(const p of opened){
    const m=venueMarkets.find(x=>x.id===p.marketId),f=p.forecast||{};
    Object.assign(p,{bookId:book.id,bookVersion:book.version,gameKey:gameKey(m),sport:sportOf(m),category:m.category||'Other',seriesId:seriesOf(m),eventSlug:m.eventSlug||null,
      venueQuoteAt:m.venueQuoteAt,observedAt:m.observedAt,midYes:f.baseline,midSide:p.side==='yes'?f.baseline:round(1-f.baseline),
      modelSide:finite(f.probability)?(p.side==='yes'?f.probability:1-f.probability):null,spread:sideSpread(m,p.side),hours:round((m.closeAt-now)/3600)});
    delete p.rules;delete p.intent;
  }
  const eligible=new Set(decisions.filter(d=>d.plan.status==='candidate').map(d=>d.marketId)).size;
  return {account:next,receipt:{eligible,declined:0,paused,resumed,opened:opened.map(describe),settled:next.trades.filter(t=>!closed.has(t.id)).map(describe)}};
}

// ---------- State ----------
export const newLabState=now=>({schemaVersion:1,labVersion:LAB_VERSION,createdAt:now,updatedAt:now,books:{},settlements:{},resolutionChecks:{},forecasts:[],cycles:[]});
export function ensureBooks(previous,now,hash){
  const state=structuredClone(previous||newLabState(now)),created=[];
  for(const book of LAB_BOOKS){
    let rec=state.books[book.id];
    if(!rec){rec=state.books[book.id]={id:book.id,version:book.version,role:book.role,registeredAt:now,canonical:canonicalRule(book),ruleHash:typeof hash==='function'?hash(canonicalRule(book)):null,accounts:{}};created.push(book.id);}
    for(const venue of book.venues)if(!rec.accounts[venue]){
      rec.accounts[venue]={...newAccount(venue,now),bookId:book.id,bookVersion:book.version};
      if(book.kind==='shadow'){rec.accounts[venue].pause=null;rec.accounts[venue].pauses=[];}
    }
  }
  return {state,created};
}
export function validateLabState(state){
  const fail=why=>{throw new Error(`Invalid Prediction Lab state (${why}); refusing to reset any book.`);};
  if(!state||state.schemaVersion!==1||!state.books||typeof state.books!=='object'||!finite(state.createdAt))fail('shape');
  for(const k of ['settlements','resolutionChecks'])if(!state[k]||typeof state[k]!=='object'||Array.isArray(state[k]))fail(k);
  for(const k of ['forecasts','cycles'])if(!Array.isArray(state[k]))fail(k);
  for(const [id,rec] of Object.entries(state.books)){
    if(rec.id!==id||typeof rec.canonical!=='string'||!finite(rec.registeredAt)||!rec.accounts)fail(`book ${id}`);
    for(const [venue,a] of Object.entries(rec.accounts)){
      try{validateAccount(a,venue);}catch{fail(`${id} ${venue} account`);}
      if(a.bookId!==id)fail(`${id} account id`);
    }
  }
  return state;
}
const frozenProblem=(book,rec)=>rec.canonical!==canonicalRule(book)?'The registered rule or parameters changed after this book began. A change requires a new book id, so this book was not advanced.':shadowDrift(book);

// ---------- Refresh and resolution planning (used by the collector) ----------
export const marketRef=m=>({id:m.id,venue:m.venue,venueId:m.venueId,eventId:m.eventId,seriesId:m.seriesId,eventSlug:m.eventSlug||null});
export const positionRef=p=>({id:p.marketId,venue:p.marketId.split(':')[0],venueId:p.marketId.slice(p.marketId.indexOf(':')+1),eventId:p.eventId,seriesId:p.seriesId||null,eventSlug:p.eventSlug||null});
export function sourceStateFor(venue,inputs,now){
  if(inputs.snapshotError)return {status:'error',message:`Prediction snapshot unavailable: ${inputs.snapshotError}`,observedAt:null,checkedAt:null};
  const age=now-(inputs.snapshotAt??-Infinity);
  if(!finite(inputs.snapshotAt)||age>LAB_SNAPSHOT_MAX_AGE)return {status:'stale',message:`The existing collector's snapshot is ${finite(age)?Math.round(age/60)+' minutes':'of unknown age'} old; no new entries, only settlement and marks.`,observedAt:inputs.sources?.[venue]?.observedAt??null,checkedAt:inputs.sources?.[venue]?.checkedAt??null};
  const s=inputs.sources?.[venue];
  if(!s)return {status:'error',message:'The existing collector reported no status for this venue.',observedAt:null,checkedAt:null};
  return {status:s.status==='ok'||s.status==='partial'?s.status:'error',message:s.error||null,observedAt:s.observedAt??null,checkedAt:s.checkedAt??null};
}
export function planRefresh(state,snapshotMarkets,observations,now,inputs={},{maxCandidates=24}={}){
  const {state:st}=ensureBooks(state,now),jobs=new Map(),notes=[],screened={};
  for(const rec of Object.values(st.books))for(const a of Object.values(rec.accounts))for(const p of a.positions)jobs.set(p.marketId,{ref:positionRef(p),reason:'open position'});
  const fresh=(snapshotMarkets||[]).map(toLabMarket);
  for(const book of LAB_BOOKS){
    const rec=st.books[book.id];if(frozenProblem(book,rec))continue;
    for(const venue of book.venues){
      const src=sourceStateFor(venue,inputs,now);
      if(!['ok','partial'].includes(src.status)){notes.push({bookId:book.id,venue,message:src.message});continue;}
      const acct=rec.accounts[venue];let picked=[];
      if(book.kind==='shadow'){
        picked=fresh.filter(m=>m.venue===venue&&!m.sourceError).filter(m=>{
          const est=entryForecast(m,observations,now);
          return ['yes','no'].some(side=>entryPlan(m,side,est,{...acct,markComplete:true},m.observedAt).status==='candidate');
        });
      }else{
        const held=new Set([...acct.positions,...acct.trades].map(p=>p.gameKey).filter(Boolean)),groups=new Map();
        for(const m of fresh){
          if(m.venue!==venue)continue;
          const s=screenMarket(book,m,now,{strict:false}),k=gameKey(m);
          if(!s.ok||held.has(k))continue;
          const cur=groups.get(k);if(!cur||byTightSpread({m,s},cur)<0)groups.set(k,{m,s});
        }
        picked=[...groups.values()].sort(byTightSpread).map(x=>x.m);
      }
      screened[`${book.id}:${venue}`]=picked.length;
      for(const m of picked.slice(0,maxCandidates))if(!jobs.has(m.id))jobs.set(m.id,{ref:marketRef(m),reason:`candidate for ${book.id}`});
    }
  }
  return {jobs:[...jobs.values()],notes,screened};
}
export function settlementNeeds(state,now){
  const need=new Map();
  for(const rec of Object.values(state.books||{}))for(const a of Object.values(rec.accounts))for(const p of a.positions)
    if(!state.settlements[p.marketId]&&finite(p.closeAt)&&p.closeAt<=now)need.set(p.marketId,{id:p.marketId,priority:0});
  for(const f of state.forecasts||[])if(f.payout===null&&!state.settlements[f.marketId]&&finite(f.closeAt)&&f.closeAt<=now&&!need.has(f.marketId))need.set(f.marketId,{id:f.marketId,priority:1});
  return [...need.values()].map(x=>({id:x.id,priority:x.priority,venue:x.id.split(':')[0],venueId:x.id.slice(x.id.indexOf(':')+1)}));
}
// Public settlement lookups are rate limited per market; positions come before forecasts.
export function planResolution(state,now,{limit=30,minRecheck=1500,skip=new Set()}={}){
  return settlementNeeds(state,now).filter(x=>!skip.has(x.id)&&now-(state.resolutionChecks[x.id]||0)>=minRecheck)
    .sort((a,b)=>a.priority-b.priority||(state.resolutionChecks[a.id]||0)-(state.resolutionChecks[b.id]||0)||(a.id<b.id?-1:1)).slice(0,limit);
}

// ---------- Advance one lab run ----------
const validSettlement=s=>s&&finite(s.yesPayout)&&s.yesPayout>=0&&s.yesPayout<=1&&finite(s.observedAt);
export function advanceLab(previous,inputs,now){
  const {state}=ensureBooks(previous,now,inputs.hash),errors=[...(inputs.errors||[])];
  if(finite(previous?.updatedAt)&&now<previous.updatedAt)throw new Error('Lab time moved backwards; nothing was changed.');
  for(const [id,s] of Object.entries(inputs.settlements||{}))if(validSettlement(s))state.settlements[id]=s;
  for(const [id,t] of Object.entries(inputs.checked||{}))if(finite(t))state.resolutionChecks[id]=t;
  const markets=(inputs.markets||[]).map(toLabMarket),observations=inputs.observations||[];
  // Shadow forecast log: the track record a paused shadow book needs before it may resume.
  for(const f of state.forecasts){const s=state.settlements[f.marketId];if(f.payout===null&&validSettlement(s)&&[0,1].includes(s.yesPayout)&&s.observedAt>=f.at){f.payout=s.yesPayout;f.resolvedAt=s.observedAt;}}
  const shadow=LAB_BOOKS.find(b=>b.kind==='shadow');
  if(shadow&&!frozenProblem(shadow,state.books[shadow.id])){
    const keys=new Set(state.forecasts.map(f=>f.key));
    for(const raw of inputs.snapshotMarkets||[]){
      const m=toLabMarket(raw);
      if(m.venue!=='polymarket'||!quoteValid(m,m.observedAt)||!m.seriesId||!m.eventId)continue;
      const est=entryForecast(m,observations,m.observedAt),key=`${m.eventId}:${est.cohort}`;
      if(keys.has(key)||!est.eligible||!finite(est.probability)||!finite(midpoint(m)))continue;
      keys.add(key);state.forecasts.push({key,marketId:m.id,eventId:m.eventId,cohort:est.cohort,at:m.observedAt,closeAt:m.closeAt,baseline:round(midpoint(m)),estimate:round(est.probability),stage:est.entryStage,payout:null,resolvedAt:null});
    }
    if(state.forecasts.length>4000){const open=state.forecasts.filter(f=>f.payout===null),done=state.forecasts.filter(f=>f.payout!==null);state.forecasts=[...done.slice(-(4000-open.length)),...open].sort((x,y)=>x.at-y.at);}
  }
  const receipts=[];
  for(const book of LAB_BOOKS){
    const rec=state.books[book.id],problem=frozenProblem(book,rec);
    if(problem){errors.push({bookId:book.id,stage:'frozen-rule',message:problem});receipts.push({bookId:book.id,venue:null,status:'not-advanced',message:problem});continue;}
    for(const venue of book.venues){
      const src=sourceStateFor(venue,inputs,now),allowEntries=['ok','partial'].includes(src.status);
      const failures=Object.entries(inputs.refreshFailures||{}).filter(([id])=>rec.accounts[venue].positions.some(p=>p.marketId===id));
      const ctx={now,markets,settlements:state.settlements,allowEntries,observations,forecasts:state.forecasts};
      const out=book.kind==='shadow'?advanceShadow(book,venue,rec.accounts[venue],ctx):advanceRuleBook(book,venue,rec.accounts[venue],ctx);
      const acct=out.account;
      acct.sourceState={status:src.status,message:src.message,observedAt:src.observedAt,checkedAt:src.checkedAt,at:now,
        staleMarks:acct.positions.filter(p=>now-p.markAt>LAB_FRESH_SECONDS).length,markFailures:failures.length};
      rec.accounts[venue]=acct;
      receipts.push({bookId:book.id,venue,status:src.status,...out.receipt,open:acct.positions.length,settledTotal:acct.trades.length,cash:acct.cash,equity:acct.equity,markComplete:acct.markComplete});
    }
  }
  // Keep only settlement records that a lab position or forecast still refers to.
  const used=new Set([...state.forecasts.map(f=>f.marketId)]);
  for(const rec of Object.values(state.books))for(const a of Object.values(rec.accounts))for(const p of [...a.positions,...a.trades])used.add(p.marketId);
  for(const id of Object.keys(state.settlements))if(!used.has(id))delete state.settlements[id];
  for(const id of Object.keys(state.resolutionChecks))if(!used.has(id))delete state.resolutionChecks[id];
  state.cycles=[...state.cycles,{at:now,snapshotAt:inputs.snapshotAt??null,books:receipts}].slice(-144);
  state.updatedAt=now;state.labVersion=LAB_VERSION;
  validateLabState(state);
  return {state,receipt:state.cycles.at(-1),errors:errors.slice(0,40)};
}

// ---------- Evidence ----------
export const weekIndex=t=>Math.floor((t/86400+3)/7);
const clip=p=>Math.min(1-1e-6,Math.max(1e-6,p));
const logLoss=(p,y)=>-(y*Math.log(clip(p))+(1-y)*Math.log(1-clip(p)));
export function accountEvidence(book,account){
  const trades=account.trades||[],open=(account.positions||[]).length;
  const byEvent=new Map(),bySport=new Map(),bySeries=new Map();
  let pnl=0,costs=0,cost=0,fees=0,slippage=0,stress=0;
  for(const t of trades){
    const k=t.gameKey||t.eventId||t.marketId,e=byEvent.get(k)||{pnl:0,closeAt:t.closeAt};e.pnl+=t.pnl;byEvent.set(k,e);
    for(const [map,key] of [[bySport,t.sport||'Other'],[bySeries,t.seriesId||'unknown']]){const r=map.get(key)||{key,settled:0,wins:0,pnl:0};r.settled+=1;r.wins+=t.payout===t.quantity?1:0;r.pnl=round(r.pnl+t.pnl);map.set(key,r);}
    pnl+=t.pnl;cost+=t.cost;fees+=t.fees;slippage+=t.slippage;costs+=t.fees+t.slippage;stress+=t.pnl-(PROMOTION_SCREEN.costStress-1)*(t.fees+t.slippage);
  }
  const events=byEvent.size,weeks=new Set([...byEvent.values()].filter(e=>finite(e.closeAt)).map(e=>weekIndex(e.closeAt))).size;
  const bestEvent=Math.max(0,...[...byEvent.values()].map(e=>e.pnl)),bestSport=Math.max(0,...[...bySport.values()].map(r=>r.pnl));
  const need=PROMOTION_SCREEN,enough=events>=need.minSettledEvents&&weeks>=need.minPeriods;
  const crit=(id,label,value,pass)=>({id,label,value,pass:enough||id==='events'||id==='weeks'?pass:null});
  const criteria=[
    crit('events',`At least ${need.minSettledEvents} settled events`,`${events} of ${need.minSettledEvents}`,events>=need.minSettledEvents),
    crit('weeks',`At least ${need.minPeriods} distinct UTC weeks`,`${weeks} of ${need.minPeriods}`,weeks>=need.minPeriods),
    crit('net','Net P&L positive after modeled costs',`${money(pnl)}`,pnl>0),
    crit('stress','Positive with fees and slippage +50%',`${money(stress)}`,stress>0),
    crit('event','Positive without the best single event',`${money(pnl-bestEvent)}`,pnl-bestEvent>0),
    crit('sport','Positive without the best single sport',`${money(pnl-bestSport)}`,pnl-bestSport>0),
  ];
  const met=criteria.every(c=>c.pass===true),failed=criteria.filter(c=>c.pass===false).map(c=>c.label);
  // Pick calibration: how the market's own midpoint scored on this book's picks.
  const binary=trades.filter(t=>finite(t.midSide)&&(t.payout===0||t.payout===t.quantity));
  const ys=binary.map(t=>t.payout>0?1:0),mean=xs=>xs.length?xs.reduce((n,x)=>n+x,0)/xs.length:null;
  const brierMid=mean(binary.map((t,i)=>(t.midSide-ys[i])**2)),llMid=mean(binary.map((t,i)=>logLoss(t.midSide,ys[i])));
  const model=binary.map((t,i)=>({p:t.modelSide,y:ys[i]})).filter(x=>finite(x.p));
  const brierModel=mean(model.map(x=>(x.p-x.y)**2)),llModel=mean(model.map(x=>logLoss(x.p,x.y)));
  const winRate=mean(ys),meanMid=mean(binary.map(t=>t.midSide));
  let status;
  const pausedNote=account.pause?' Entries paused.':'';
  if(book.role==='control')status=`Control: n=${events} settled event${events===1?'':'s'}; measures cost drag, not a candidate for promotion.${pausedNote}`;
  else if(!events)status=open?`n=0 settled of ${need.minSettledEvents} needed (${open} open); not evidence yet.${pausedNote}`:`n=0 settled of ${need.minSettledEvents} needed; not evidence yet.${pausedNote}`;
  else if(events<need.minSettledEvents)status=`n=${events} settled of ${need.minSettledEvents} needed; not evidence yet.${pausedNote}`;
  else if(met)status=`Promotion screen met on n=${events} settled events. Paper result only; not proof of an edge and not a real-money signal.${pausedNote}`;
  else status=`n=${events} settled; promotion screen not met (${failed.join('; ')||'more distinct weeks needed'}). Not evidence of an edge.${pausedNote}`;
  return {status,met,events,weeks,criteria,progress:Math.min(1,events/need.minSettledEvents),
    pnl:round(pnl),stressedPnl:round(stress),costs:round(costs),fees:round(fees),slippage:round(slippage),costDrag:cost?round(costs/cost):null,
    picks:{n:binary.length,wins:ys.reduce((n,y)=>n+y,0),winRate,meanMidpoint:meanMid,excess:winRate===null?null:winRate-meanMid,brierMidpoint:brierMid,logLossMidpoint:llMid,
      brierModel,logLossModel:llModel,modelN:model.length},
    bySport:[...bySport.values()].sort((a,b)=>b.settled-a.settled||(a.key<b.key?-1:1)),bySeries:[...bySeries.values()].sort((a,b)=>b.settled-a.settled||(a.key<b.key?-1:1)).slice(0,12)};
}
const money=v=>`${v<0?'-':''}$${Math.abs(v).toFixed(2)}`;

// ---------- Public snapshot ----------
const compactPosition=p=>({id:p.id,marketId:p.marketId,question:p.question,side:p.side,quantity:p.quantity,cost:p.cost,entry:p.entry,fees:p.fees,slippage:p.slippage,
  midSide:p.midSide??null,spread:p.spread??null,sport:p.sport??null,openedAt:p.openedAt,observedAt:p.observedAt??p.quoteAt,venueQuoteAt:p.venueQuoteAt??p.quoteAt,
  closeAt:p.closeAt,markValue:p.markValue,markAt:p.markAt,url:p.url||null});
const compactTrade=t=>({...compactPosition(t),payout:t.payout,pnl:t.pnl,closedAt:t.closedAt});
export function labSnapshot(state,{generatedAt,sources=[],errors=[]}={}){
  const latest=state.cycles.at(-1);
  const books=LAB_BOOKS.map(book=>{
    const rec=state.books[book.id],frozen=rec?frozenProblem(book,rec):null;
    return {id:book.id,version:book.version,role:book.role,title:book.title,rule:book.rule,params:book.params,ruleHash:rec?.ruleHash??null,registeredAt:rec?.registeredAt??null,
      frozenError:frozen,accounts:book.venues.map(venue=>{
        const a=rec?.accounts?.[venue];if(!a)return null;
        const ev=accountEvidence(book,a),cycle=latest?.books.find(b=>b.bookId===book.id&&b.venue===venue)||null;
        return {venue,startedAt:a.startedAt,initialCapital:a.initialCapital,cash:a.cash,equity:a.equity,peak:a.peak,realizedPnl:a.realizedPnl,fees:a.fees,
          open:a.positions.length,settled:a.trades.length,halted:!!a.halted,markComplete:a.markComplete,updatedAt:a.updatedAt,sourceState:a.sourceState||null,
          pause:a.pause?{...a.pause,text:pauseText(book,a.pause,state.forecasts,generatedAt)}:null,pauses:(a.pauses||[]).length,
          evidence:ev,positions:a.positions.map(compactPosition),trades:[...a.trades].sort((x,y)=>y.closedAt-x.closedAt).slice(0,40).map(compactTrade),
          lastCycle:cycle&&{at:latest.at,status:cycle.status,eligible:cycle.eligible,opened:cycle.opened?.length||0,settled:cycle.settled?.length||0}};
      }).filter(Boolean)};
  });
  return {schemaVersion:1,kind:'prediction-lab',labVersion:LAB_VERSION,generatedAt,startedAt:state.createdAt,mode:'paper',realEnabled:false,credentialsConnected:false,
    label:LAB_LABEL,screen:{version:PROMOTION_SCREEN.version,text:PROMOTION_SCREEN.text,minSettledEvents:PROMOTION_SCREEN.minSettledEvents,minPeriods:PROMOTION_SCREEN.minPeriods,costStress:PROMOTION_SCREEN.costStress},
    invariants:LAB_INVARIANTS,sources,errors,books,forecastLog:{recorded:state.forecasts.length,resolved:state.forecasts.filter(f=>f.payout!==null).length}};
}
const text=v=>typeof v==='string'&&v.length>0,count=v=>Number.isInteger(v)&&v>=0;
export function validLabSnapshot(s,now=Date.now()/1000){
  try{
    return !!(s&&s.kind==='prediction-lab'&&s.mode==='paper'&&s.realEnabled===false&&finite(s.generatedAt)&&s.generatedAt<=now+60&&
      Array.isArray(s.sources)&&Array.isArray(s.errors)&&Array.isArray(s.books)&&s.books.length>0&&
      s.books.every(b=>text(b.id)&&text(b.title)&&text(b.rule)&&Array.isArray(b.accounts)&&b.accounts.every(a=>
        (a.venue==='polymarket'||a.venue==='kalshi')&&[a.cash,a.equity,a.realizedPnl,a.initialCapital].every(finite)&&count(a.open)&&count(a.settled)&&
        Array.isArray(a.positions)&&Array.isArray(a.trades)&&a.evidence&&text(a.evidence.status)&&Array.isArray(a.evidence.criteria)&&finite(a.evidence.progress))));
  }catch{return false;}
}
