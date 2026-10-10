// Durable execution for locked prediction-market arbitrage.
//
// Safety design copied from the Coinbase worker (scripts/live/engine.mjs):
// - every order is persisted with an immutable client ID BEFORE its POST;
// - an unknown POST outcome is reconciled by that client ID, never resent;
// - accounting uses cumulative venue fills (count, own-outcome price, fee);
// - two mutation guards: engine mode 'live' AND adapter allowSubmit;
// - frozen allocation, permanent loss latch, manual-recovery latch.
// Execution: legs are fill-or-kill limit buys, scarcest displayed depth first;
// a leg is sent only after every previous leg filled completely. A broken
// package gets one bounded hedge attempt, then one bounded reduce-only unwind,
// then a manual-review latch that records the exact residual exposure.
import {randomUUID} from 'node:crypto';
import {D,S} from '../live/risk.mjs';
import {legCostBound,MAX_BOOK_AGE_SECONDS} from './arb.mjs';
import {validateOrderBody} from './kalshi.mjs';
import {HARD_LIMITS} from './config.mjs';

const ONE=D('1'),CENT=D('0.01'),ZERO=0n,SCALE=10n**18n;
const LOG_LIMIT=500,PACKAGE_LIMIT=5000;
const UNKNOWN_LIMIT_SECONDS=600,RESTING_LIMIT_SECONDS=60;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const clone=v=>structuredClone(v);
const min=(...xs)=>xs.reduce((a,b)=>a<b?a:b);
const max=(...xs)=>xs.reduce((a,b)=>a>b?a:b);
const nonneg=v=>{const n=D(v);if(n<0n)throw Error('Negative ledger value');return n;};
const opposite=o=>o==='yes'?'no':'yes';
class Hold extends Error{constructor(message,manual=false){super(message);this.manual=manual;}}
const hold=(message,manual=false)=>{throw new Hold(message,manual);};
const OPEN_STAGES=new Set(['legs','review']);

function configOf(c={}){
  const out={mode:c.mode??'preview',allocation:{kalshi:String(c.allocation?.kalshi??'0'),polymarket:String(c.allocation?.polymarket??'0')},
    maxTrade:String(c.maxTrade??'5'),lossLimit:String(c.lossLimit??'5'),margin:String(c.margin??'0.01'),hedgeTolerance:String(c.hedgeTolerance??'0.02'),
    unwindTolerance:String(c.unwindTolerance??'0.05'),allowSports:c.allowSports===true,exhaustiveSeries:[...(c.exhaustiveSeries??[])]};
  const bad=!['preview','live'].includes(out.mode)||Object.values(out.allocation).some(a=>D(a)<0n||D(a)>D(HARD_LIMITS.allocation))||
    D(out.maxTrade)<=0n||D(out.maxTrade)>D(HARD_LIMITS.maxTrade)||D(out.lossLimit)<=0n||D(out.lossLimit)>D(HARD_LIMITS.lossLimit)||
    D(out.margin)<CENT||D(out.hedgeTolerance)<0n||D(out.hedgeTolerance)>D('0.05')||D(out.unwindTolerance)<CENT||D(out.unwindTolerance)>D('0.10');
  if(bad)throw Error('Invalid bounded prediction execution configuration');
  return Object.freeze(out);
}
function newState(c,now){
  return {version:1,kind:'prediction-arbitrage-engine',mode:c.mode,allocation:clone(c.allocation),maxTrade:c.maxTrade,lossLimit:c.lossLimit,
    funding:{kalshi:{funded:false,initialCapital:'0',fundedAt:null}},lossLatched:false,manualRecovery:false,recoveryReasons:[],hold:null,
    packages:[],stats:{scans:0,seen:0,positive:0,unlockedGaps:0,executable:0,attempted:0,filled:0,latestNetEdge:null,latestAt:null,bestNetEdge:null},
    log:[],createdAt:now,lastTickAt:null,lastSuccessAt:null,lastScanAt:null};
}
function validateOrder(o){
  if(!ID.test(o?.clientOrderId??'')||o.venue!=='kalshi'||!['leg','hedge','unwind'].includes(o.role)||!['yes','no'].includes(o.outcome)||!Number.isFinite(o.createdAt))throw Error('Invalid persisted order');
  validateOrderBody(o.body);
  if(o.body.client_order_id!==o.clientOrderId||o.body.ticker!==o.ticker||o.body.side!==(o.outcome==='yes'?'bid':'ask')||o.body.reduce_only!==(o.role==='unwind'))throw Error('Persisted order does not match its immutable body');
  if(o.orderId!==null&&!ID.test(o.orderId))throw Error('Invalid persisted order identity');
  for(const k of ['filled','cost','fees'])nonneg(o[k]);
  if(D(o.filled)>D(o.body.count))throw Error('Persisted fills exceed the order size');
  if(typeof o.terminal!=='boolean'||typeof o.accounted!=='boolean'||(o.accounted&&!o.terminal))throw Error('Invalid persisted order state');
}
function validateState(state,c){
  if(!state||state.version!==1||state.kind!=='prediction-arbitrage-engine'||!Array.isArray(state.packages)||state.packages.length>PACKAGE_LIMIT||!Array.isArray(state.log)||state.log.length>LOG_LIMIT||
    !['lossLatched','manualRecovery'].every(k=>typeof state[k]===('boolean'))||!Array.isArray(state.recoveryReasons)||typeof state.funding?.kalshi?.funded!=='boolean')throw Error('Invalid prediction journal; refusing to reset it');
  if(state.funding.kalshi.funded){
    if(state.allocation.kalshi!==c.allocation.kalshi)throw Error('The funded Kalshi allocation is frozen; refusing a changed PM_KALSHI_ALLOCATION_USD');
    const initial=nonneg(state.funding.kalshi.initialCapital);
    if(initial<D(HARD_LIMITS.minFunding)||initial>D(state.allocation.kalshi))throw Error('Invalid frozen allocation');
  }else if(nonneg(state.funding.kalshi.initialCapital)!==0n)throw Error('Invalid unfunded allocation');
  const seen=new Set();
  for(const p of state.packages){
    if(typeof p.id!=='string'||!['complement','cross-venue','multi-outcome'].includes(p.type)||!Array.isArray(p.legs)||!Array.isArray(p.orders)||!['legs','review','complete','closed','manual'].includes(p.stage))throw Error('Invalid persisted package');
    for(const o of p.orders){if(seen.has(o.clientOrderId))throw Error('Duplicate client order identity');seen.add(o.clientOrderId);validateOrder(o);}
  }
  return state;
}
/** Net holdings per ticker after venue netting: a YES and a NO on the same
 * market are a $1 pair that Kalshi settles immediately. */
export function holdings(pkg){
  const byTicker=new Map();
  let cost=0n,fees=0n;
  for(const o of pkg.orders){
    const row=byTicker.get(o.ticker)??{yes:0n,no:0n};row[o.outcome]+=D(o.filled);byTicker.set(o.ticker,row);
    cost+=D(o.cost);fees+=D(o.fees);
  }
  let pairs=0n;
  for(const row of byTicker.values()){const p=min(row.yes,row.no);pairs+=p;row.yes-=p;row.no-=p;}
  const held=pkg.legs.map(l=>byTicker.get(l.ticker)?.[l.outcome]??0n);
  const distinct=new Set(pkg.legs.map(l=>l.ticker)).size===pkg.legs.length;
  const sets=distinct?min(...held):0n;
  const excess=held.map(h=>h-sets);
  const stray=[...byTicker.entries()].some(([t,row])=>!pkg.legs.some(l=>l.ticker===t&&row[l.outcome]>0n)&&(row.yes>0n||row.no>0n));
  return {byTicker,held,sets,excess,pairs,cost,fees,stray};
}
function cashFlow(h){return h.pairs-h.cost-h.fees;}
function exposureText(pkg,h){
  const rows=[];
  for(const [ticker,row] of h.byTicker)for(const o of ['yes','no']){
    const sets=pkg.legs.some(l=>l.ticker===ticker&&l.outcome===o)&&new Set(pkg.legs.map(l=>l.ticker)).size===pkg.legs.length?h.sets:0n;
    const residual=row[o]-sets;if(residual>0n)rows.push({ticker,outcome:o,contracts:S(residual)});
  }
  return rows;
}
function latch(state,reason){state.manualRecovery=true;if(!state.recoveryReasons.includes(reason))state.recoveryReasons.push(reason);state.hold=state.recoveryReasons[0];}

export class PredictionArbEngine {
  #venues;#journal;#config;#clock;#state;#running=false;#fatal=false;#isStopping;#settlement;#scopeCheck=null;
  constructor({venues,journal,config,clock=()=>Date.now()/1000,isStopping=()=>false,settlement=async()=>null}){
    if(!venues?.kalshi||typeof journal?.load!=='function'||typeof journal.save!=='function')throw Error('Venue adapters and a durable journal are required');
    this.#venues=venues;this.#journal=journal;this.#config=configOf(config);this.#clock=clock;this.#isStopping=isStopping;this.#settlement=settlement;
    let prior=journal.load();
    if(prior){
      const c=this.#config;
      if(!prior.funding?.kalshi?.funded&&prior.allocation?.kalshi!==c.allocation.kalshi)prior={...clone(prior),allocation:clone(c.allocation)};
      if(prior.maxTrade!==c.maxTrade||prior.lossLimit!==c.lossLimit)prior={...clone(prior),maxTrade:c.maxTrade,lossLimit:c.lossLimit,limitsChangedAt:this.#now()};
      validateState(prior,c);
    }
    this.#state=prior?clone(prior):newState(this.#config,this.#now());
    if(!prior)this.#save(this.#state,'initialize');
  }
  get state(){return clone(this.#state);}
  /** Packages still executing or under repair: the host polls these quickly. */
  get activePackages(){return this.#state.packages.filter(p=>OPEN_STAGES.has(p.stage)).length;}
  #now(){const n=this.#clock();if(!Number.isFinite(n)||n<=0)throw Error('Invalid execution clock');return n;}
  #save(next,type='tick'){
    if(this.#fatal)throw Error('Prediction journal failed; restart and reconcile');
    try{validateState(next,this.#config);this.#journal.save(next,{type,time:this.#now()});this.#state=clone(next);}
    catch{this.#fatal=true;throw Error('Prediction persistence failed; stop and reconcile before restart');}
  }
  #mutationAllowed(adapter){
    if(this.#isStopping())hold('Shutdown in progress; mutation disabled');
    if(this.#config.mode!=='live'||adapter?.allowSubmit!==true||adapter?.canSubmit!==true)hold('Live mutation guard is disabled');
  }
  /** Ledger, from cumulative fills only. */
  ledger(state=this.#state){
    const initial=D(state.funding.kalshi.initialCapital);let flow=0n,locked=0n,realized=0n,lockedPnl=0n;
    for(const p of state.packages){
      const h=holdings(p),f=cashFlow(h)+(p.settlement?D(p.settlement.payout):0n);flow+=f;
      if(p.stage==='closed')realized+=f;
      else if(p.stage==='complete'){locked+=h.sets;lockedPnl+=f+h.sets;}
    }
    return {initial,cash:initial+flow,conservativeEquity:initial+flow+locked,realized,lockedPnl};
  }
  recordScan(opportunities,now=this.#now()){
    const state=this.state,s=state.stats,list=Array.isArray(opportunities)?opportunities:[];
    s.scans++;s.seen+=list.length;state.lastScanAt=now;
    let best=null;
    for(const o of list){
      const edge=o?.evaluation?.bestNetEdgePerContract;if(typeof edge!=='string')continue;
      // Only packages whose payout is locked in every outcome count as arbitrage.
      if(!o.locked){if(o.rawPositive)s.unlockedGaps=(s.unlockedGaps??0)+1;continue;}
      if(best===null||D(edge)>D(best))best=edge;
      if(o.positive){s.positive++;state.log.push({at:now,kind:'opportunity',type:o.type,key:String(o.key).slice(0,600),netEdgePerContract:edge,netEdge:o.evaluation.bestNetEdge??null,
        quantity:o.evaluation.bestNetEdgeQuantity??null,executable:o.executable===true,reason:o.executable?null:String(o.reasons?.[0]??'').slice(0,300)});}
      if(o.executable)s.executable++;
    }
    state.log.push({at:now,kind:'scan',evaluated:list.length,positive:list.filter(o=>o?.positive).length,executable:list.filter(o=>o?.executable).length,bestNetEdgePerContract:best});
    if(best!==null){s.latestNetEdge=best;s.latestAt=now;if(s.bestNetEdge===null||D(best)>D(s.bestNetEdge))s.bestNetEdge=best;}
    state.log=state.log.slice(-LOG_LIMIT);
    this.#save(state,'scan');
  }
  async #checkScopes(){
    const k=this.#venues.kalshi;if(!k.authenticated)return null;
    const now=this.#now();
    if(this.#scopeCheck&&now-this.#scopeCheck.at<3600)return this.#scopeCheck.result;
    let result;
    try{
      const {scopes}=await k.keyScopes();
      if(scopes.includes('write')||scopes.includes('write::transfer'))result='Kalshi key has transfer or broad write scope; create a key with only read and write::trade';
      else if(this.#config.mode==='live'&&(!scopes.includes('write::trade')||!(scopes.includes('read')||scopes.includes('read::portfolio_balance'))))result='Kalshi key lacks read or write::trade scope';
      else result=null;
    }catch{result='Kalshi key permissions could not be verified';}
    this.#scopeCheck={at:now,result};return result;
  }
  // ---------- reconciliation ----------
  async #reconcileOrder(pi,oi){
    const k=this.#venues.kalshi,state=this.state,pkg=state.packages[pi],o=pkg.orders[oi],now=this.#now();
    if(o.orderId===null){
      const rows=(await k.ordersFor(o.ticker,o.createdAt-300)).filter(r=>r.client_order_id===o.clientOrderId);
      if(rows.length>1){latch(state,'Duplicate venue orders share one client ID; manual review required');this.#save(state,'manual_recovery');hold(state.hold,true);}
      if(!rows.length){
        if(now-o.createdAt>=UNKNOWN_LIMIT_SECONDS){latch(state,'An order outcome stayed unknown for 10 minutes; manual review of the Kalshi account is required');this.#save(state,'manual_recovery');hold(state.hold,true);}
        hold('Order outcome unknown; reconciling by client ID, never resending');
      }
      o.orderId=rows[0].order_id;if(!ID.test(o.orderId))hold('Venue order identity invalid',true);
    }
    const raw=await k.order(o.orderId);
    if(raw.client_order_id!==o.clientOrderId||raw.ticker!==o.ticker)hold('Venue order identity differs from the persisted intent',true);
    const side=raw.book_side??(raw.outcome_side==='yes'?'bid':raw.outcome_side==='no'?'ask':null);
    if(side!==o.body.side)hold('Venue order direction differs from the persisted intent',true);
    if(!['resting','canceled','executed'].includes(raw.status))hold('Unknown venue order status');
    const filled=nonneg(raw.fill_count_fp);
    if(filled<D(o.filled)||filled>D(o.body.count))hold('Nonmonotonic or oversized cumulative fills',true);
    o.status=raw.status;o.terminal=raw.status!=='resting';o.lastCheckedAt=now;
    if(!o.terminal&&now-o.createdAt>RESTING_LIMIT_SECONDS){latch(state,'An immediate-only order is resting; manual review required (this worker has no cancel permission path)');this.#save(state,'manual_recovery');hold(state.hold,true);}
    if(o.terminal){
      const fills=await k.fills(o.orderId);let count=0n,cost=0n,fees=0n;
      const limit=o.outcome==='yes'?D(o.body.price):ONE-D(o.body.price);
      for(const f of fills){
        if(f.outcome_side!==o.outcome)hold('Fill direction differs from the order',true);
        const c=nonneg(f.count_fp),p=nonneg(o.outcome==='yes'?f.yes_price_dollars:f.no_price_dollars),fee=nonneg(f.fee_cost??'0');
        if(c<=0n||p<=0n||p>limit)hold('Fill price exceeds the order limit',true);
        count+=c;cost+=c*p/SCALE;fees+=fee;
      }
      if(count>filled)hold('Venue fills exceed the order fill count',true);
      if(count===filled){o.filled=S(count);o.cost=S(cost);o.fees=S(fees);o.accounted=true;}
      else hold('Fills not yet visible for a terminal order; waiting');
    }
    this.#save(state,'reconcile');
  }
  async #reconcile(){
    let pending=null;
    for(let pi=0;pi<this.#state.packages.length;pi++){
      for(let oi=0;oi<this.#state.packages[pi].orders.length;oi++){
        if(this.#state.packages[pi].orders[oi].accounted)continue;
        try{await this.#reconcileOrder(pi,oi);}
        catch(error){if(this.#fatal)throw error;if(error instanceof Hold&&error.manual&&!this.#state.manualRecovery){const s=this.state;latch(s,error.message);this.#save(s,'manual_recovery');}pending??=error instanceof Hold?error.message:'Kalshi order reconciliation unavailable';}
      }
    }
    return pending;
  }
  // ---------- package lifecycle ----------
  #order(pkg,{role,legIndex,ticker,outcome,count,yesPrice,tif}){
    const body={ticker,client_order_id:randomUUID(),side:outcome==='yes'?'bid':'ask',count:String(count),price:S(yesPrice),time_in_force:tif,
      self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:role==='unwind',cancel_order_on_pause:true};
    validateOrderBody(body);
    return {clientOrderId:body.client_order_id,venue:'kalshi',role,legIndex,ticker,outcome,body,orderId:null,status:'UNKNOWN',terminal:false,accounted:false,
      filled:'0',cost:'0',fees:'0',createdAt:this.#now(),responseFill:null,lastCheckedAt:null};
  }
  /** Persist, then POST. Returns the immediate fill count, or throws a Hold
   * that leaves the persisted order UNKNOWN for reconciliation. */
  async #submit(pi,record){
    const k=this.#venues.kalshi;this.#mutationAllowed(k);
    const state=this.state;state.packages[pi].orders.push(record);this.#save(state,`${record.role}_intent`);
    let response;
    try{response=await k.create(clone(record.body));}catch{hold('Submission outcome unknown; persisted order must be reconciled by client ID');}
    if(!ID.test(response?.order_id??'')||(response.client_order_id!==undefined&&response.client_order_id!==record.clientOrderId))hold('Order response is ambiguous; persisted order must be reconciled');
    let fill;try{fill=nonneg(response.fill_count);}catch{hold('Order response omitted its fill count; reconciling');}
    if(fill>D(record.body.count))hold('Order response reports an oversized fill',true);
    const next=this.state,o=next.packages[pi].orders.find(x=>x.clientOrderId===record.clientOrderId);
    o.orderId=response.order_id;o.responseFill=S(fill);this.#save(next,'submitted');
    return fill;
  }
  async #runLegs(pi){
    const pkg=this.#state.packages[pi];
    for(let i=pkg.nextLeg;i<pkg.legs.length;i++){
      const leg=pkg.legs[i],limit=D(leg.limit);
      const record=this.#order(pkg,{role:'leg',legIndex:i,ticker:leg.ticker,outcome:leg.outcome,count:pkg.quantity,yesPrice:leg.outcome==='yes'?limit:ONE-limit,tif:'fill_or_kill'});
      const fill=await this.#submit(pi,record);
      const state=this.state,p=state.packages[pi];
      if(fill!==D(pkg.quantity)){p.stage='review';this.#save(state,i===0&&fill===0n?'first_leg_unfilled':'leg_incomplete');return;}
      p.nextLeg=i+1;if(p.nextLeg===p.legs.length)p.stage='review';this.#save(state,'leg_filled');
    }
  }
  async #review(pi){
    const pkg=this.#state.packages[pi];
    if(pkg.orders.some(o=>!o.accounted))return 'Package orders awaiting fill accounting';
    const h=holdings(pkg),excess=h.excess.some(e=>e>0n);
    if(h.stray)hold('Package holds an unexpected position',true);
    if(!excess){
      const state=this.state,p=state.packages[pi];
      p.stage=h.sets>0n?'complete':'closed';if(p.stage==='closed')p.closedAt=this.#now();
      if(p.orders.length===p.legs.length&&p.orders.every(o=>o.role==='leg'&&D(o.filled)===D(p.quantity)))state.stats.filled++;
      this.#save(state,'package_'+p.stage);return null;
    }
    const k=this.#venues.kalshi,cash=this.ledger().cash;
    this.#mutationAllowed(k);
    if(!pkg.hedgeTried){
      const state=this.state;state.packages[pi].hedgeTried=true;this.#save(state,'hedge_review');
      const top=max(...h.held);let budget=cash,placed=0;
      for(let i=0;i<pkg.legs.length;i++){
        const deficit=top-h.held[i];if(deficit<=0n||deficit%SCALE!==0n)continue;
        const leg=pkg.legs[i],limit=min(D('0.99'),D(leg.limit)+D(this.#config.hedgeTolerance)),count=deficit/SCALE;
        let bound;try{bound=legCostBound(count,limit,leg.feeRate);}catch{continue;}
        if(bound>budget)continue;budget-=bound;
        const record=this.#order(pkg,{role:'hedge',legIndex:i,ticker:leg.ticker,outcome:leg.outcome,count,yesPrice:leg.outcome==='yes'?limit:ONE-limit,tif:'immediate_or_cancel'});
        await this.#submit(pi,record);placed++;
      }
      if(placed)return 'Hedge attempted; awaiting fill accounting';
    }
    if(!this.#state.packages[pi].unwindTried){
      const state=this.state;state.packages[pi].unwindTried=true;this.#save(state,'unwind_review');
      for(let i=0;i<pkg.legs.length;i++){
        const e=h.excess[i];if(e<=0n)continue;
        const leg=pkg.legs[i],floor=max(CENT,D(leg.limit)-D(this.#config.unwindTolerance));
        // Buy the opposite outcome, reduce-only: it can only close what is held.
        if(e%SCALE!==0n)continue;
        const outcome=opposite(leg.outcome),buyPrice=ONE-floor,count=e/SCALE;
        const record=this.#order(pkg,{role:'unwind',legIndex:i,ticker:leg.ticker,outcome,count,yesPrice:outcome==='yes'?buyPrice:floor,tif:'immediate_or_cancel'});
        await this.#submit(pi,record);
      }
      return 'Unwind attempted; awaiting fill accounting';
    }
    const state=this.state,p=state.packages[pi];p.stage='manual';p.exposure=exposureText(p,h);
    latch(state,`Residual exposure after hedge and unwind: ${p.exposure.length} position(s), ${S(p.exposure.reduce((n,r)=>n+D(r.contracts),0n))} contracts; manual review required`);
    this.#save(state,'manual_recovery');hold(state.hold,true);
  }
  async #advance(){
    let pending=null;
    for(let pi=0;pi<this.#state.packages.length;pi++){
      const p=this.#state.packages[pi];
      if(!OPEN_STAGES.has(p.stage))continue;
      try{
        if(p.stage==='legs'){
          // A package interrupted between legs (restart, unknown outcome) is
          // never resumed on stale prices; it goes through bounded repair.
          const state=this.state;state.packages[pi].stage='review';this.#save(state,'interrupted_package');
        }
        const message=await this.#review(pi);pending??=message;
      }catch(error){if(this.#fatal)throw error;if(error instanceof Hold&&error.manual&&!this.#state.manualRecovery){const s=this.state;latch(s,error.message);this.#save(s,'manual_recovery');}pending??=error instanceof Hold?error.message:'Package repair unavailable';}
    }
    return pending;
  }
  async #settle(){
    const now=this.#now();
    for(let pi=0;pi<this.#state.packages.length;pi++){
      const p=this.#state.packages[pi];
      if(p.stage!=='complete'||now-(p.settlementCheckedAt??0)<900)continue;
      const h=holdings(p);let payout=0n,missing=false;
      for(const [ticker,row] of h.byTicker){
        if(row.yes===0n&&row.no===0n)continue;
        let r=null;try{r=await this.#settlement(ticker);}catch{r=null;}
        if(!r){missing=true;break;}
        const v=D(r.value);if(v<0n||v>ONE){missing=true;break;}
        payout+=row.yes*v/SCALE+row.no*(ONE-v)/SCALE;
      }
      const state=this.state,q=state.packages[pi];q.settlementCheckedAt=now;
      if(!missing){q.settlement={payout:S(payout),at:now};q.stage='closed';q.closedAt=now;}
      this.#save(state,missing?'settlement_check':'settled');
    }
  }
  async #fund(){
    if(this.#state.funding.kalshi.funded||this.#config.mode!=='live')return;
    const {balance}=await this.#venues.kalshi.balance(),initial=min(D(balance),D(this.#config.allocation.kalshi));
    if(initial<D(HARD_LIMITS.minFunding))hold(`At least $${HARD_LIMITS.minFunding} of available Kalshi cash is required to freeze the allocation`);
    const state=this.state;state.funding.kalshi={funded:true,initialCapital:S(initial),fundedAt:this.#now()};state.allocation=clone(this.#config.allocation);this.#save(state,'allocation_frozen');
  }
  #checkLoss(){
    if(!this.#state.funding.kalshi.funded)return;
    const l=this.ledger();
    if(l.conservativeEquity<=l.initial-D(this.#config.lossLimit)&&!this.#state.lossLatched){const s=this.state;s.lossLatched=true;this.#save(s,'loss_latched');}
  }
  async #enter(opportunities,refresh){
    const k=this.#venues.kalshi;
    if(this.#state.packages.some(p=>OPEN_STAGES.has(p.stage)))hold('A package is still being executed or repaired');
    const candidates=(opportunities||[]).filter(o=>o?.executable).sort((a,b)=>D(b.evaluation.netEdge)>D(a.evaluation.netEdge)?1:-1);
    if(!candidates.length)hold('No executable opportunity after fees and safety margin');
    const unsupported=candidates.find(o=>o.venues.some(v=>v!=='kalshi'));
    const kalshiOnly=candidates.filter(o=>o.venues.every(v=>v==='kalshi'));
    if(!kalshiOnly.length)hold(unsupported?'Executable opportunity requires Polymarket US, which is scan-only':'No executable Kalshi opportunity');
    if(this.#config.mode!=='live'){
      const s=this.state;s.log.push({at:this.#now(),kind:'would_trade',type:kalshiOnly[0].type,key:String(kalshiOnly[0].key).slice(0,600),netEdge:kalshiOnly[0].evaluation.netEdge,quantity:kalshiOnly[0].evaluation.quantity});s.log=s.log.slice(-LOG_LIMIT);this.#save(s,'preview_opportunity');
      hold('Preview: executable opportunity found; live submission is disabled');
    }
    this.#mutationAllowed(k);
    const ledger=this.ledger(),{balance}=await k.balance();
    const cash=min(ledger.cash,D(balance));
    if(cash<=0n)hold('No Kalshi cash available within the frozen allocation');
    // Re-read every book immediately before trading; never trade on the scan copy.
    const fresh=await refresh(kalshiOnly[0],{cash:{kalshi:S(cash)},maxTradeUsd:this.#config.maxTrade,margin:this.#config.margin,now:this.#now()});
    const e=fresh?.evaluation;
    const canonical=key=>String(key).split('|').sort().join('|');
    if(!fresh?.executable||!e?.ok||fresh.type!==kalshiOnly[0].type||canonical(fresh.key)!==canonical(kalshiOnly[0].key))hold('Opportunity did not survive a fresh book check');
    if(D(e.costBound)>D(this.#config.maxTrade)||D(e.costBound)>cash)hold('Package exceeds the trade cap or available cash');
    if(this.#now()-fresh.observedAt>=MAX_BOOK_AGE_SECONDS)hold('Fresh books aged before submission');
    const state=this.state;
    state.packages.push({id:randomUUID(),type:fresh.type,key:fresh.key,createdAt:this.#now(),quantity:e.quantity,costBound:e.costBound,netEdge:e.netEdge,
      legs:e.legs.map(l=>({ticker:l.ticker,outcome:l.outcome,limit:l.limit,feeRate:l.feeRate,costBound:l.costBound})),orders:[],stage:'legs',nextLeg:0,hedgeTried:false,unwindTried:false,closedAt:null,settlement:null});
    state.stats.attempted++;this.#save(state,'package_intent');
    await this.#runLegs(state.packages.length-1);
    return 'Package submitted; awaiting fill accounting';
  }
  /** One cycle. `opportunities` come from the latest scan; `refresh` re-fetches
   * books for one opportunity and re-evaluates it with the given limits. */
  async tick({opportunities=[],refresh=async()=>null}={}){
    if(this.#running)throw Error('Prediction tick already running');
    if(this.#fatal)throw Error('Prediction journal failed; restart required');
    this.#running=true;
    try{
      const start=this.state;start.lastTickAt=this.#now();start.mode=this.#config.mode;if(!start.manualRecovery)start.hold=null;this.#save(start,'tick');
      const k=this.#venues.kalshi;
      if(k.authenticated){
        const scope=await this.#checkScopes();if(scope)hold(scope);
        const r=await this.#reconcile();const a=await this.#advance();await this.#settle();
        if(this.#state.manualRecovery)hold(this.#state.hold??'Manual review required');
        if(r||a)hold(r||a);
        await this.#fund();this.#checkLoss();
        if(this.#state.lossLatched)hold('Loss limit latched; new packages are permanently disabled');
      }else if(this.#config.mode==='live')hold('Kalshi credentials are required for live mode');
      const s=this.state;s.lastSuccessAt=this.#now();this.#save(s,'verified');
      hold(await this.#enter(opportunities,refresh));
    }catch(error){
      if(this.#fatal)throw error;
      const state=this.state,reason=error instanceof Hold?error.message:'Venue data could not be verified; no new action taken';
      if(error instanceof Hold&&error.manual)latch(state,reason);
      state.hold=state.manualRecovery?state.recoveryReasons[0]:reason;this.#save(state,'held');
    }finally{this.#running=false;}
    return this.state;
  }
  /** Aggregate status only: no tickers, identifiers, balances or credentials. */
  status(){
    const s=this.#state,l=this.ledger();
    return {mode:this.#config.mode,realOrdersEnabled:this.#config.mode==='live'&&this.#venues.kalshi.allowSubmit===true,
      funded:s.funding.kalshi.funded,lossLatched:s.lossLatched,manualRecovery:s.manualRecovery,hold:s.hold,
      scans:s.stats.scans,opportunitiesSeen:s.stats.seen,opportunitiesPositive:s.stats.positive,unlockedGapsIgnored:s.stats.unlockedGaps??0,opportunitiesExecutable:s.stats.executable,
      attempted:s.stats.attempted,filled:s.stats.filled,latestNetEdgePerContractUsd:s.stats.latestNetEdge,bestNetEdgePerContractUsd:s.stats.bestNetEdge,
      latestAt:s.stats.latestAt,lastScanAt:s.lastScanAt,lastTickAt:s.lastTickAt,
      realizedPnlUsd:s.funding.kalshi.funded?S(l.realized):null,lockedPnlUsd:s.funding.kalshi.funded?S(l.lockedPnl):null,
      openPackages:s.packages.filter(p=>p.stage!=='closed').length};
  }
}
export default PredictionArbEngine;
