import {createHash,randomUUID} from 'node:crypto';
import {evaluateUniverse} from '../../dashboard/crypto-strategies-core.mjs';
import {D,S,mul,div,floorStep,planEntry,validatePreview} from './risk.mjs';
import {validateOrderBody} from './coinbase.mjs';
import {getCapacityProfile} from './capacity.mjs';

const ZERO='0',CENT=D('0.01'),ONE=D('1');
const min=(...values)=>values.reduce((a,b)=>a<b?a:b);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const terminal=new Set(['FILLED','CANCELLED','EXPIRED','FAILED','REJECTED']);
const statuses=new Set([...terminal,'PENDING','OPEN','QUEUED','CANCEL_QUEUED','EDIT_QUEUED']);
const clone=value=>structuredClone(value);
const nonnegative=value=>{const n=D(value);if(n<0n)throw Error('Negative ledger value');return n;};
const upFee=(amount,rate)=>((amount*rate+ONE*CENT-1n)/(ONE*CENT))*CENT;
class Hold extends Error {constructor(message,manual=false){super(message);this.manual=manual;}}
const hold=(message,manual=false)=>{throw new Hold(message,manual);};
function latch(state,reason,parent){
 for(const record of [state,parent].filter(Boolean)){
  record.manualRecovery=true;record.recoveryReason??=reason;record.recoveryReasons??=[];
  if(!record.recoveryReasons.includes(reason))record.recoveryReasons.push(reason);
 }
}
function configOf(config={}){
 const capacity=getCapacityProfile(config.capacityProfile);
 const c={mode:config.mode??'preview',allocation:String(config.allocation??20),maxOrder:String(config.maxOrder??5),lossLimit:String(config.lossLimit??2),expectedPortfolioId:config.expectedPortfolioId??config.portfolioId,confirmationSeconds:config.confirmationSeconds??60,capacityProfile:capacity.name,maxPositions:config.maxPositions??capacity.maxPositions};
 if(!['preview','live'].includes(c.mode)||!id(c.expectedPortfolioId)||D(c.allocation)<=0n||D(c.allocation)>D('20')||D(c.maxOrder)<=0n||D(c.maxOrder)>D('5')||D(c.maxOrder)>D(c.allocation)||D(c.lossLimit)<=0n||D(c.lossLimit)>D('2')||D(c.lossLimit)>=D(c.allocation)||!Number.isFinite(c.confirmationSeconds)||c.confirmationSeconds<60||c.confirmationSeconds>1800||!Number.isInteger(c.maxPositions)||c.maxPositions<1||c.maxPositions>capacity.maxPositions)throw Error('Invalid bounded execution configuration');
 return Object.freeze(c);
}
function remaining(intent){return D(intent.filledSize)-D(intent.child?.filledSize??ZERO)-intent.exits.reduce((sum,exit)=>sum+D(exit.filledSize),0n);}
function cashFrom(state){
 let cash=state.funded?D(state.initialCapital):0n;
 for(const i of state.intents){cash-=D(i.filledValue)+D(i.fees);for(const exit of [i.child,...i.exits].filter(Boolean))cash+=D(exit.filledValue)-D(exit.fees);}
 return cash;
}
function validateState(state,config){
 if(!state||state.version!==1||state.kind!=='coinbase-rotation-engine'||state.portfolioId!==config.expectedPortfolioId||state.allocation!==config.allocation||state.maxOrder!==config.maxOrder||state.lossLimit!==config.lossLimit||!['preview','live'].includes(state.mode)||!['funded','lossLatched','manualRecovery','marksComplete'].every(k=>typeof state[k]==='boolean')||!Array.isArray(state.intents)||state.intents.length>10000||!state.confirmations||!state.cooldowns)throw Error('Invalid execution journal; refusing to reset or adopt balances');
 for(const key of ['lastTickAt','lastSuccessAt','lastMarkedAt'])if(state[key]!==null&&(!Number.isFinite(state[key])||state[key]<=0))throw Error('Invalid execution receipt');
 getCapacityProfile(state.capacityProfile);
 if(state.projectionRecoveryToken!==undefined&&!/^projection-v1-[a-f0-9]{64}$/.test(state.projectionRecoveryToken))throw Error('Invalid recovery receipt');
 for(const record of [state,...state.intents])if(record.recoveryReason!==undefined&&record.recoveryReason!==null&&(typeof record.recoveryReason!=='string'||!record.recoveryReason.length||record.recoveryReason.length>500))throw Error('Invalid recovery reason');
 for(const record of [state,...state.intents])if(record.recoveryReasons!==undefined&&(!Array.isArray(record.recoveryReasons)||record.recoveryReasons.length>100||record.recoveryReasons.some(reason=>typeof reason!=='string'||!reason.length||reason.length>500)))throw Error('Invalid recovery reasons');
 const seen=new Set();
 for(const intent of state.intents){
  if(!id(intent.clientOrderId)||seen.has(intent.clientOrderId)||!Number.isFinite(intent.createdAt)||intent.createdAt<=0||!Array.isArray(intent.exits)||!intent.plan?.ok||D(intent.plan.reserved)>D(config.maxOrder)||D(intent.plan.reserved)<=0n||D(intent.plan.quantity)<=0n)throw Error('Invalid persisted intent');
  seen.add(intent.clientOrderId);validateOrderBody(intent.body,{create:true,portfolioId:config.expectedPortfolioId});
  if(typeof intent.manualRecovery!=='boolean'||(intent.exitReason!==null&&!['loss-trigger','trend-exit','maximum-hold'].includes(intent.exitReason)))throw Error('Invalid persisted recovery state');
  for(const key of ['closedAt','lastAuditAt'])if(intent[key]!==null&&(!Number.isFinite(intent[key])||intent[key]<intent.createdAt))throw Error('Invalid persisted order receipt');
  if(intent.body.client_order_id!==intent.clientOrderId||intent.body.product_id!==intent.product||intent.body.side!=='BUY'||intent.body.order_configuration?.limit_limit_gtc?.base_size!==intent.plan.quantity||intent.body.order_configuration.limit_limit_gtc.limit_price!==intent.plan.limitPrice||intent.body.attached_order_configuration?.trigger_bracket_gtc?.limit_price!==intent.plan.target||intent.body.attached_order_configuration.trigger_bracket_gtc.stop_trigger_price!==intent.plan.stop)throw Error('Persisted intent does not match its immutable plan');
  for(const order of [intent,intent.child,...intent.exits].filter(Boolean)){
   if(order.orderId!==null&&!id(order.orderId))throw Error('Invalid persisted order identity');
   if(typeof order.terminal!=='boolean'||!Number.isFinite(order.createdAt)||order.createdAt<=0||(!statuses.has(order.status)&&order.status!=='UNKNOWN')||(order.terminal&&(!terminal.has(order.status)||order.orderId===null))||(order.orderId===null&&order.status!=='UNKNOWN')||(order.cancelRequestedAt!==null&&(!Number.isFinite(order.cancelRequestedAt)||order.cancelRequestedAt<order.createdAt)))throw Error('Invalid persisted order state');
   for(const field of ['filledSize','filledValue','fees'])nonnegative(order[field]);
   if(order!==intent&&order!==intent.child){validateOrderBody(order.body,{create:true,portfolioId:config.expectedPortfolioId});if(!id(order.clientOrderId)||seen.has(order.clientOrderId)||order.body.client_order_id!==order.clientOrderId||order.body.side!=='SELL'||order.body.product_id!==intent.product)throw Error('Invalid persisted exit');seen.add(order.clientOrderId);}
  }
  if(D(intent.filledSize)>D(intent.plan.quantity)||D(intent.filledValue)+D(intent.fees)>D(intent.plan.reserved)||remaining(intent)<0n)throw Error('Persisted fills exceed owned quantity or reservation');
 }
 if((!state.funded&&(state.intents.length||D(state.initialCapital)!==0n))||(state.funded&&(D(state.initialCapital)<D('5')||D(state.initialCapital)>D(config.allocation))))throw Error('Invalid initial allocation');
 if(cashFrom(state)!==nonnegative(state.cash))throw Error('Execution cash ledger does not reconcile');
 nonnegative(state.equity);nonnegative(state.exposure);
 return state;
}
function record(body,now){return {clientOrderId:body.client_order_id,body:clone(body),orderId:null,createdAt:now,status:'UNKNOWN',terminal:false,filledSize:ZERO,filledValue:ZERO,fees:ZERO,cancelRequestedAt:null};}
function freshBook(book,product,now){
 if((book?.product??book?.pricebook?.product_id)!==product||[book.requestAt,book.receivedAt].some(t=>!Number.isFinite(t)||t>now||now-t>15)||!Number.isFinite(book.bookAt)||book.bookAt>now+5||now-book.bookAt>15||book.requestAt>book.receivedAt)hold('Fresh authenticated book unavailable');
 const exact=book.pricebook??book.raw?.pricebook??book;
 const rows=side=>{if(!Array.isArray(exact[side])||!exact[side].length)hold('Displayed depth unavailable');return exact[side].map(r=>{const price=D(Array.isArray(r)?r[0]:r.price),size=D(Array.isArray(r)?r[1]:r.size);if(price<=0n||size<=0n)hold('Invalid displayed depth');return [price,size];}).sort((a,b)=>a[0]===b[0]?0:(a[0]<b[0]?-1:1)*(side==='bids'?-1:1));};
 const bids=rows('bids'),asks=rows('asks');if(bids[0][0]>asks[0][0])hold('Crossed authenticated book');return {bids,asks};
}
function liquidation(book,quantity,rate,product,now){
 const {bids}=freshBook(book,product,now);let left=quantity,gross=0n;
 for(const [price,size] of bids){const take=min(left,size);gross+=mul(take,price);left-=take;if(left===0n)break;}
 if(left>0n)hold('Insufficient fresh depth for liquidation mark');
 const net=gross-upFee(gross,rate)-mul(gross,D('0.001'));return {gross,net:net>0n?net:0n};
}

/** Private durable execution. The caller owns the journal lifetime/lock. A live
 * config and the broker's explicit guard are both required for every mutation.
 * Native bracket stops are not guaranteed fills; $2 is an exit trigger, not a
 * promised maximum loss. Unknown submissions are never blindly retried. */
export class Engine {
 #broker;#journal;#config;#clock;#state;#running=false;#fatal=false;#isStopping;#verified=new Set();#cycleHold=null;
 constructor({broker,journal,config={},clock=()=>Date.now()/1000,isStopping=()=>false}){
  if(!broker||typeof journal?.load!=='function'||typeof journal.save!=='function'||typeof clock!=='function')throw Error('Broker and durable journal are required');
  if(typeof isStopping!=='function')throw Error('Invalid shutdown guard');this.#isStopping=isStopping;
  this.#broker=broker;this.#journal=journal;this.#config=configOf(config);this.#clock=clock;
  const prior=journal.load(),c=this.#config;
  this.#state=prior?clone(validateState(prior,c)):{version:1,kind:'coinbase-rotation-engine',mode:c.mode,portfolioId:c.expectedPortfolioId,allocation:c.allocation,maxOrder:c.maxOrder,lossLimit:c.lossLimit,initialCapital:ZERO,funded:false,cash:ZERO,equity:ZERO,exposure:ZERO,marksComplete:false,lastMarkedAt:null,lossLatched:false,manualRecovery:false,hold:null,lastTickAt:null,lastSuccessAt:null,confirmations:{},cooldowns:{},intents:[]};
 }
 get state(){return clone(this.#state);}
 #beginRecovery(){
  if(this.#running||this.#fatal||this.#isStopping())hold('Recovery inspection requires an idle healthy engine');
  this.#running=true;
 }
 async #projectionRecoverySnapshot(){
  const state=this.state,parent=state.intents[0];
  if(!state.funded||!state.manualRecovery||state.lossLatched||state.intents.length!==1||!parent?.manualRecovery||parent.closedAt!==null||parent.exitReason!==null||parent.exits.length||!parent.terminal||parent.status!=='FILLED'||D(parent.filledSize)<=0n||parent.cancelRequestedAt!==null)hold('Recovery is restricted to one settled protected entry');
  if([state.recoveryReason,parent.recoveryReason,...(state.recoveryReasons??[]),...(parent.recoveryReasons??[])].some(reason=>reason!==undefined&&reason!==null&&reason!=='Venue total and cumulative fees disagree'))hold('A different recovery reason requires separate review');
  const child=parent.child;
  if(!child||!['UNKNOWN','OPEN'].includes(child.status)||child.terminal||child.cancelRequestedAt!==null||[child.filledSize,child.filledValue,child.fees].some(v=>D(v)!==0n))hold('Recovery requires an unfilled, uncancelled protective bracket');
  const token='projection-v1-'+createHash('sha256').update(JSON.stringify({version:1,portfolioId:state.portfolioId,allocation:state.allocation,initialCapital:state.initialCapital,clientOrderId:parent.clientOrderId,orderId:parent.orderId,childOrderId:child.orderId,plan:parent.plan,createdAt:parent.createdAt})).digest('hex');
  await this.#permissions();
  const observedParent=(await this.#broker.order(parent.orderId)).order;
  if(observedParent?.status!=='FILLED'||observedParent.settled!==true||observedParent.pending_cancel===true||observedParent.attached_order_id!==child.orderId)hold('Entry identity, settlement or attachment changed');
  if(['filled_size','filled_value','total_fees'].some((key,n)=>D(observedParent[key])!==D([parent.filledSize,parent.filledValue,parent.fees][n])))hold('Entry accounting changed; separate reconciliation is required');
  this.#apply(state,parent,observedParent,parent,'parent');
  const observedChild=(await this.#broker.order(child.orderId)).order;
  if(observedChild?.status!=='OPEN'||observedChild.settled!==false||observedChild.pending_cancel===true||['filled_size','filled_value','total_fees'].some(k=>D(observedChild[k])!==0n)||D(observedChild.total_value_after_fees)<=0n)hold('Protective order no longer matches the unfilled projection incident');
  this.#apply(state,child,observedChild,parent,'child');
  const fees=await this.#broker.fees(),balances=await this.#accounts(),book=await this.#broker.book(parent.product),rate=this.#fee(fees),mark=liquidation(book,remaining(parent),rate,parent.product,this.#now());
  if((balances.get('USD')??0n)<D(state.cash))hold('Available cash does not cover the preserved allocation ledger');
  const equity=D(state.cash)+mark.net;
  if(equity<=D(state.initialCapital)-D(state.lossLimit))hold('Current liquidation value reaches the loss trigger');
  state.equity=S(equity);state.exposure=S(mark.gross);state.marksComplete=true;state.lastMarkedAt=this.#now();
  return {state,report:{eligible:true,token,product:parent.product,quantity:parent.filledSize,protectionStatus:'OPEN'}};
 }
 async inspectProjectionRecovery(){
  this.#beginRecovery();
  try{return (await this.#projectionRecoverySnapshot()).report;}finally{this.#running=false;}
 }
 async recoverProjectionHold(token){
  if(typeof token!=='string'||!/^projection-v1-[a-f0-9]{64}$/.test(token))hold('Invalid projection recovery acknowledgement');
  // A persisted token cannot clear a later unrelated hold, even if the
  // operator leaves the one-time environment variable in place.
  if(token===this.#state.projectionRecoveryToken)return {recovered:false,alreadyRecovered:true};
  this.#beginRecovery();
  try{
  const {state,report}=await this.#projectionRecoverySnapshot();
  if(token!==report.token)hold('Recovery acknowledgement belongs to a different entry');
  if(this.#isStopping())hold('Shutdown in progress; recovery not saved');
  state.manualRecovery=false;state.recoveryReason=null;state.recoveryReasons=[];state.hold=null;state.projectionRecoveryToken=token;
  state.intents[0].manualRecovery=false;state.intents[0].recoveryReason=null;state.intents[0].recoveryReasons=[];state.intents[0].lastAuditAt=this.#now();
  this.#save(state,'projection_recovery');return {...report,recovered:true};
  }finally{this.#running=false;}
 }
 #save(next,event='tick'){
  if(this.#fatal)throw Error('Execution journal failed; restart and reconcile');
  try{validateState(next,this.#config);this.#journal.save(next,{type:event,time:this.#now()});this.#state=clone(next);}catch{this.#fatal=true;throw Error('Execution persistence failed; stop and reconcile before restart');}
 }
 #now(){const now=this.#clock();if(!Number.isFinite(now)||now<=0)throw Error('Invalid execution clock');return now;}
 #mutation(){if(this.#isStopping())hold('Shutdown in progress; mutation disabled');if(this.#config.mode!=='live'||this.#broker.allowSubmit!==true)hold('Live mutation guard is disabled');}
 #fee(fees){const now=this.#now();if(!Number.isFinite(fees?.checkedAt)||fees.checkedAt>now||now-fees.checkedAt>15)hold('Fresh authenticated fees unavailable');const rate=D(fees.raw?.fee_tier?.taker_fee_rate??fees.takerRate);if(rate<0n||rate>=D('0.1')||(fees.takerRate!==undefined&&rate!==D(fees.takerRate)))hold('Account fee rate invalid');return rate;}
 async #refreshFees(fees){
  // A larger portfolio must not reuse one aging receipt for every exit.
  // Refresh well before expiry; the original strict 15-second gate still applies.
  if(Number.isFinite(fees?.checkedAt)&&this.#now()-fees.checkedAt>5)fees=await this.#broker.fees();
  this.#fee(fees);return fees;
 }
 async #accounts(){
  const raw=await this.#broker.accounts();if(!Array.isArray(raw?.accounts)||raw.has_next!==false||(raw.cursor!==undefined&&raw.cursor!==''))hold('Incomplete account pagination');
  const seen=new Set(),balances=new Map();
  for(const a of raw.accounts){if(!id(a?.uuid)||seen.has(a.uuid)||a.retail_portfolio_id!==this.#config.expectedPortfolioId||a.available_balance?.currency!==a.currency)hold('Account identity or portfolio mismatch');seen.add(a.uuid);const value=nonnegative(a.available_balance.value);if(a.currency==='USD'&&(a.active!==true||a.ready!==true))hold('USD account is not ready');balances.set(a.currency,(balances.get(a.currency)??0n)+value);}
  return balances;
 }
 async #permissions(){const p=await this.#broker.permissions();if(p?.portfolio_uuid!==this.#config.expectedPortfolioId||p.can_view!==true||p.can_transfer!==false||(this.#config.mode==='live'&&p.can_trade!==true)||(this.#broker.portfolioId!==undefined&&this.#broker.portfolioId!==this.#config.expectedPortfolioId))hold('Portfolio or least-privilege permissions could not be verified');}
 #apply(state,record,raw,parent,kind){
  if(!raw||raw.order_id!==record.orderId||raw.product_id!==parent.product||raw.product_type!=='SPOT'||raw.retail_portfolio_id!==state.portfolioId||raw.side!==(kind==='parent'?'BUY':'SELL')||!statuses.has(raw.status))hold('Order identity, side or status mismatch',true);
  if(kind==='child'){
   if(raw.originating_order_id!==parent.orderId)hold('Attached exit origin mismatch',true);
   const bracket=raw.order_configuration?.trigger_bracket_gtc;
   if(!bracket||D(bracket.limit_price)!==D(parent.plan.target)||D(bracket.stop_trigger_price)!==D(parent.plan.stop)||D(bracket.base_size)<=0n)hold('Attached bracket configuration mismatch',true);
   if(D(bracket.base_size)>D(parent.filledSize)||(parent.terminal&&D(bracket.base_size)!==D(parent.filledSize)))hold('Attached bracket and parent size snapshots are not yet coherent');
  }else{
   if(raw.client_order_id!==record.clientOrderId)hold('Order client identity mismatch',true);
   const type=kind==='parent'?'limit_limit_gtc':'sor_limit_ioc',reported=raw.order_configuration?.[type],expected=record.body.order_configuration[type];
   if(!reported||D(reported.base_size)!==D(expected.base_size)||D(reported.limit_price)!==D(expected.limit_price))hold('Order configuration differs from persisted intent',true);
  }
  const size=nonnegative(raw.filled_size),value=nonnegative(raw.filled_value),fees=nonnegative(raw.total_fees);
  if(size<D(record.filledSize)||value<D(record.filledValue)||fees<D(record.fees)||(size===0n&&value!==0n)||(size>0n&&value===0n))hold('Nonmonotonic or incomplete cumulative fills',true);
  // OPEN native brackets can report projected proceeds here despite zero
  // fills. Actual accounting always uses cumulative filled value and fees.
  // The derived total is a consistency check only after complete settlement.
  if(raw.status==='FILLED'&&raw.settled===true&&raw.total_value_after_fees!==undefined&&D(raw.total_value_after_fees)!==(kind==='parent'?value+fees:value-fees))hold('Venue total and cumulative fees disagree',true);
  const isTerminal=terminal.has(raw.status)&&(raw.status!=='FILLED'||raw.settled===true);
  if(record.terminal&&!isTerminal)hold('Terminal order became active again',true);
  const maximum=kind==='child'?D(parent.filledSize):D(record.body.order_configuration[kind==='parent'?'limit_limit_gtc':'sor_limit_ioc'].base_size);
  if(size>maximum||(kind==='parent'&&value+fees>D(parent.plan.reserved)))hold('Cumulative fills exceed reserved cash or owned size',true);
  record.filledSize=S(size);record.filledValue=S(value);record.fees=S(fees);record.status=raw.status;record.terminal=isTerminal;
  if(kind==='parent'&&raw.attached_order_id){if(!id(raw.attached_order_id)||(parent.child&&parent.child.orderId!==raw.attached_order_id))hold('Attached child identity changed',true);parent.child??={orderId:raw.attached_order_id,createdAt:parent.createdAt,status:'UNKNOWN',terminal:false,filledSize:ZERO,filledValue:ZERO,fees:ZERO,cancelRequestedAt:null};}
  if(remaining(parent)<0n||cashFrom(state)<0n)hold('Broker fills oversold owned quantity or cash',true);
  state.cash=S(cashFrom(state));
 }
 async #resolve(record){
  if(record.orderId)return record.orderId;
  const result=await this.#broker.orders({product:record.body.product_id});
  if(!Array.isArray(result?.orders)||result.has_next!==false||(result.cursor!==undefined&&result.cursor!==''))hold('Order reconciliation pagination is incomplete');
  const matches=result.orders.filter(o=>o.client_order_id===record.clientOrderId);
  if(matches.length!==1||!id(matches[0].order_id)){if(matches.length>1)hold('Duplicate order identity requires manual recovery',true);return null;}
  return matches[0].order_id;
 }
 async #reconcile(){
  // Even terminal orders are reread: delayed commission updates must be
  // accounted before new spending. Cancelled partial fills are not discarded.
  const priority=intent=>intent.closedAt!==null?2:intent.terminal?1:0;
  const indexes=this.#state.intents.map((_,index)=>index).sort((a,b)=>priority(this.#state.intents[a])-priority(this.#state.intents[b]));let auditedClosed=false;
  for(const index of indexes){
   let parentObserved=false;
   try{
   let state=this.state,parent=state.intents[index];
   if(parent.closedAt!==null){if(auditedClosed||this.#now()-(parent.lastAuditAt??0)<3600)continue;auditedClosed=true;}
   parent.orderId=await this.#resolve(parent);if(parent.orderId===null){this.#cycleHold='Submission outcome unknown; reservation retained and no retry';continue;}
   this.#apply(state,parent,(await this.#broker.order(parent.orderId)).order,parent,'parent');
   this.#save(state,'parent_reconcile');parentObserved=true;
   if(parent.child&&D(parent.filledSize)>0n){const child=(await this.#broker.order(parent.child.orderId)).order;if(D(child.order_configuration?.trigger_bracket_gtc?.base_size??ZERO)>D(parent.filledSize))this.#apply(state,parent,(await this.#broker.order(parent.orderId)).order,parent,'parent');this.#apply(state,parent.child,child,parent,'child');}
   for(const exit of parent.exits){exit.orderId=await this.#resolve(exit);if(exit.orderId!==null)this.#apply(state,exit,(await this.#broker.order(exit.orderId)).order,parent,'exit');}
   const quantity=remaining(parent);
   if(parent.child&&D(parent.child.filledSize)>0n&&quantity>0n){state.hold='A protective SELL partially filled; remaining protection requires manual recovery';latch(state,state.hold,parent);}
   if(parent.terminal&&quantity>0n&&parent.child?.terminal&&!parent.exitReason){state.hold='Owned position has no verified active native bracket; manual recovery required';latch(state,state.hold,parent);}
   if(parent.terminal&&quantity===0n&&parent.closedAt===null&&(!parent.child||parent.child.terminal)&&parent.exits.every(exit=>exit.terminal)){parent.closedAt=this.#now();state.cooldowns[parent.product]=parent.closedAt+21600;}
   parent.lastAuditAt=this.#now();this.#save(state,'reconcile');this.#verified.add(index);
   }catch(error){if(this.#fatal)throw error;this.#cycleHold=error instanceof Hold?error.message:'Order reconciliation unavailable; affected position held';if(error instanceof Hold&&error.manual){const state=this.state;latch(state,this.#cycleHold,state.intents[index]);state.hold=state.recoveryReason;this.#save(state,'manual_recovery');}}
   // A child snapshot problem must never leave a freshly verified stale BUY
   // open. Cancellation is retried only after this tick's authoritative GET.
   const parent=this.#state.intents[index];
   if(parentObserved&&!parent.terminal&&parent.status!=='FILLED'&&parent.orderId&&this.#now()-parent.createdAt>=30&&(parent.cancelRequestedAt===null||this.#now()-parent.cancelRequestedAt>=30)&&this.#config.mode==='live'){
    try{this.#mutation();const state=this.state;state.intents[index].cancelRequestedAt=this.#now();this.#save(state,'cancel_intent');await this.#broker.cancel([parent.orderId]);}
    catch(error){if(this.#fatal)throw error;this.#cycleHold='BUY cancellation awaiting authoritative terminal reconciliation';}
   }
  }
 }
 async #mark(fees){
  this.#fee(fees);let equity=D(this.#state.cash),exposure=0n;const books=new Map();
  let complete=!this.#state.intents.some(i=>!i.terminal||i.exits.some(e=>!e.terminal)||(i.child&&!i.child.terminal&&(i.child.cancelRequestedAt!==null||remaining(i)===0n)));
  for(const [index,parent] of this.#state.intents.entries()){
   const quantity=remaining(parent);if(quantity===0n)continue;
   try{if(!this.#verified.has(index))hold('Position is not reconciled this tick');const book=await this.#broker.book(parent.product);fees=await this.#refreshFees(fees);const mark=liquidation(book,quantity,this.#fee(fees),parent.product,this.#now());books.set(parent.product,book);equity+=mark.net;exposure+=mark.gross;}
   catch{complete=false;this.#cycleHold='Some owned positions lack current verified liquidation marks';}
  }
  // Earlier books may have aged while later positions were read. Keep those
  // positions eligible for independently refreshed exits, but not new spending.
  for(const [product,book] of books){try{freshBook(book,product,this.#now());}catch{complete=false;this.#cycleHold='Portfolio books aged during marking; new entries await fresh aggregate marks';}}
  const state=this.state;state.marksComplete=complete;if(complete){state.equity=S(equity);state.exposure=S(exposure);state.lastMarkedAt=this.#now();if(equity<=D(state.initialCapital)-D(state.lossLimit))state.lossLatched=true;}this.#save(state,'mark');return books;
 }
 async #send(index,exitIndex=null){
  this.#mutation();const intent=this.#state.intents[index],record=exitIndex===null?intent:intent.exits[exitIndex];
  // This record was durably saved as UNKNOWN before entering this method.
  // Any response error leaves it UNKNOWN; a future tick only reconciles it.
  let response;try{response=await this.#broker.create(clone(record.body));}catch{hold('Submission outcome unknown; persisted intent must be reconciled');}
  const orderId=response?.success===true?response.success_response?.order_id:null;
  if(!id(orderId))hold('Submission response is ambiguous; persisted intent must be reconciled');
  if(response.success_response.client_order_id!==undefined&&response.success_response.client_order_id!==record.clientOrderId)hold('Submission response client identity mismatch',true);
  const state=this.state;state.marksComplete=false;(exitIndex===null?state.intents[index]:state.intents[index].exits[exitIndex]).orderId=orderId;this.#save(state,'submitted');
 }
 async #exits(feed,books,fees){
  let view;try{view=evaluateUniverse(feed?.markets??[],this.#now());}catch{view={markets:[]};}
  let held=null;
  for(let index=0;index<this.#state.intents.length;index++){
   try{
   let parent=this.#state.intents[index];if(remaining(parent)===0n)continue;
   if(!this.#verified.has(index)||!books.has(parent.product))hold('Position awaits its own verified order and liquidation data');
   const feature=view.markets.find(m=>m.product===parent.product),trend=feature?.status==='ready'&&feature.change6<-.015&&feature.price<feature.ema20;
   if(!parent.exitReason&&(this.#state.lossLatched||this.#now()-parent.createdAt>=72*3600||trend)){const state=this.state;state.intents[index].exitReason=this.#state.lossLatched?'loss-trigger':trend?'trend-exit':'maximum-hold';this.#save(state,'exit_requested');parent=this.#state.intents[index];}
   if(!parent.exitReason)continue;
   if(parent.manualRecovery)hold('This position requires manual recovery');
   if(!parent.terminal)hold('Exit requested; waiting for originating BUY terminal reconciliation');
   if(this.#config.mode!=='live')hold('Exit requested; preview mode cannot mutate existing orders');
   if(!parent.child)hold('Exit has no verified child identity',true);
   if(parent.exits.some(exit=>!exit.terminal))hold('Exit order pending reconciliation');
   const product=await this.#broker.product(parent.product),book=await this.#broker.book(parent.product);fees=await this.#refreshFees(fees);
   const rate=this.#fee(fees),now=this.#now(),{bids}=freshBook(book,parent.product,now);
   if(product.product_id!==parent.product||product.product_type!=='SPOT'||product.quote_currency_id!=='USD'||product.status!=='online'||['is_disabled','trading_disabled','cancel_only','view_only','post_only','auction_mode'].some(k=>product[k]!==false))hold('Exit product is currently unavailable',true);
   const step=D(product.base_increment),priceStep=D(product.price_increment??product.quote_increment);
   if(step<=0n||priceStep<=0n)hold('Exit increments invalid',true);
   const price=floorStep(mul(bids[0][0],D('0.999')),priceStep),budget=D(this.#config.maxOrder)-2n*CENT;
   const quantity=floorStep(min(remaining(parent),div(budget,mul(bids[0][0],ONE+rate)),D(product.base_max_size)),step);
   if(quantity<=0n||quantity<D(product.base_min_size)||mul(quantity,price)<D(product.quote_min_size))hold('Owned remainder is below supported exit minimum; manual recovery required',true);
   const mark=liquidation(book,quantity,rate,parent.product,this.#now());if(mark.gross+upFee(mark.gross,rate)>D(this.#config.maxOrder))hold('Exit exceeds fee-inclusive order cap');
   if(!parent.child.terminal){
    if(parent.child.cancelRequestedAt===null||this.#now()-parent.child.cancelRequestedAt>=30){this.#mutation();const state=this.state;state.marksComplete=false;state.intents[index].child.cancelRequestedAt=this.#now();this.#save(state,'child_cancel_intent');await this.#broker.cancel([parent.child.orderId]);}
    hold('Protective child cancellation awaiting terminal reconciliation');
   }
   const balances=await this.#accounts();if((balances.get(parent.product.slice(0,-4))??0n)<quantity)hold('Owned exit inventory is not yet available after cancellation');
   const body={client_order_id:randomUUID(),product_id:parent.product,side:'SELL',retail_portfolio_id:this.#config.expectedPortfolioId,order_configuration:{sor_limit_ioc:{base_size:S(quantity),limit_price:S(price)}}};
   const {client_order_id:_exitClientId,preview_id:_exitPreviewId,...previewBody}=body;
   const preview=await this.#broker.preview(previewBody);
   if(!id(preview?.preview_id)||!Array.isArray(preview.errs)||preview.errs.length||(preview.warning?.length)||(preview.warnings?.length)||D(preview.base_size??S(quantity))!==quantity||nonnegative(preview.commission_total)>upFee(mark.gross,rate)||nonnegative(preview.order_total)>D(this.#config.maxOrder))hold('Exit preview failed bounded size or fee verification');
   this.#fee(fees);freshBook(book,parent.product,this.#now());body.preview_id=preview.preview_id;
   const state=this.state,exit=record(body,this.#now());state.marksComplete=false;state.intents[index].exits.push(exit);this.#save(state,'exit_intent');await this.#send(index,state.intents[index].exits.length-1);hold('Exit submitted; waiting for cumulative fill reconciliation');
   }catch(error){if(this.#fatal)throw error;held=error instanceof Hold?error:new Hold('Exit broker verification failed; no further action for this position');if(held.manual){const state=this.state;latch(state,held.message,state.intents[index]);this.#save(state,'manual_recovery');}}
  }
  if(held)throw held;
 }
 async #entry(feed,fees){
  const now=this.#now(),at=feed?.generatedAt??feed?.universe?.generatedAt;
  if(!Array.isArray(feed?.markets)||feed.markets.length>1000||!Number.isFinite(at)||at>now||now-at>900)hold('Fresh full-universe feed unavailable for new entries');
  if(this.#state.intents.some(i=>!i.terminal||i.exits.some(e=>!e.terminal)))hold('An order or ambiguous intent remains pending');
  if(this.#state.intents.some(i=>i.child&&!i.child.terminal&&remaining(i)===0n))hold('Completed exit is awaiting final settlement before cash reuse');
  if(this.#state.intents.some(i=>remaining(i)>0n&&(!i.child||i.child.terminal)))hold('Owned position protection is not yet verified; no new entries');
  if(this.#state.intents.some(i=>i.exitReason&&remaining(i)>0n))hold('An exit is still in progress');
  if(this.#state.intents.filter(i=>remaining(i)>0n).length>=this.#config.maxPositions)hold('Maximum owned positions reached');
  // Rank the complete collection at its actual collection time. Cached book
  // ages must not erase a valid confirmation before authenticated refresh.
  const view=evaluateUniverse(feed.markets,at),candidates=view.decisions.filter(d=>d.strategyId==='rotation'&&d.status==='candidate'&&!this.#state.intents.some(i=>i.product===d.product&&remaining(i)>0n)&&(this.#state.cooldowns[d.product]??0)<=now);
  const candidate=candidates[0];if(!candidate){const state=this.state;state.confirmations={};this.#save(state,'confirmation');hold('No qualifying rotation candidate');}
  const product=await this.#broker.product(candidate.product),book=await this.#broker.book(candidate.product),btc=candidate.product==='BTC-USD'?book:await this.#broker.book('BTC-USD');
  freshBook(book,candidate.product,this.#now());freshBook(btc,'BTC-USD',this.#now());
  const refreshed=feed.markets.map(m=>m.product===candidate.product?{...m,sourceError:undefined,status:product.status,tradingDisabled:product.trading_disabled,increment:Number(product.base_increment),minSize:Number(product.base_min_size),minNotional:Number(product.quote_min_size),book}:m.product==='BTC-USD'?{...m,sourceError:undefined,book:btc}:m);
  const decision=evaluateUniverse(refreshed,this.#now()).decisions.find(d=>d.strategyId==='rotation'&&d.product===candidate.product);
  if(decision?.status!=='candidate'){const state=this.state;state.confirmations={};this.#save(state,'confirmation');hold('Candidate no longer qualifies against refreshed books');}
  const state=this.state,prior=state.confirmations[candidate.product],confirmation=prior&&prior.signalId===decision.id&&now-prior.lastSeen<=1800?{...prior,lastSeen:now}:{signalId:decision.id,at:now,lastSeen:now};state.confirmations={[candidate.product]:confirmation};this.#save(state,'confirmation');
  if(now-confirmation.at<this.#config.confirmationSeconds)hold('Waiting for a second qualifying scan at least 60 seconds later');
  const balances=await this.#accounts(),rate=this.#fee(fees),cash=min(D(this.#state.cash),D(this.#config.allocation),balances.get('USD')??0n);
  const plan=planEntry({decision,product,book,cash:S(cash),equity:S(min(D(this.#state.equity),D(this.#config.allocation))),exposure:this.#state.exposure,feeRate:S(rate),config:{allocation:this.#config.allocation,maxOrder:this.#config.maxOrder,capacityProfile:this.#config.capacityProfile,feeVerified:true},now:this.#now()});
  if(plan.hold)hold(plan.hold);
  const body={client_order_id:randomUUID(),product_id:candidate.product,side:'BUY',retail_portfolio_id:this.#config.expectedPortfolioId,order_configuration:{limit_limit_gtc:{base_size:plan.quantity,limit_price:plan.limitPrice,post_only:false}},attached_order_configuration:{trigger_bracket_gtc:{limit_price:plan.target,stop_trigger_price:plan.stop}}};
  const {client_order_id:_entryClientId,preview_id:_entryPreviewId,...previewBody}=body;
  const preview=await this.#broker.preview(previewBody),checked=validatePreview(plan,preview,S(rate),this.#now());if(checked.hold)hold(checked.hold);
  this.#fee(fees);freshBook(book,candidate.product,this.#now());freshBook(btc,'BTC-USD',this.#now());
  const finalCash=(await this.#accounts()).get('USD')??0n;if(finalCash<D(plan.reserved))hold('Available USD fell below the reserved entry cost');
  this.#fee(fees);freshBook(book,candidate.product,this.#now());freshBook(btc,'BTC-USD',this.#now());
  if(this.#config.mode==='preview')hold('Preview passed; live submission remains disabled');
  this.#mutation();body.preview_id=checked.previewId;
  const nextState=this.state;nextState.marksComplete=false;nextState.intents.push({...record(body,this.#now()),product:candidate.product,plan:clone(plan),child:null,exits:[],exitReason:null,closedAt:null,lastAuditAt:null,manualRecovery:false});nextState.confirmations={};this.#save(nextState,'entry_intent');await this.#send(nextState.intents.length-1);hold('Entry submitted; reserved cash remains unavailable until terminal reconciliation');
 }
 async tick(feed){
  if(this.#running)throw Error('Execution tick already running');if(this.#fatal)throw Error('Execution journal failed; restart required');this.#running=true;
  try{
   this.#verified=new Set();this.#cycleHold=null;const start=this.state,capacityChanged=(start.capacityProfile??'standard')!==this.#config.capacityProfile;start.mode=this.#config.mode;start.capacityProfile=this.#config.capacityProfile;start.lastTickAt=this.#now();start.marksComplete=false;if(!start.manualRecovery)start.hold=null;this.#save(start,capacityChanged?'capacity_change':'tick');
   await this.#permissions();await this.#reconcile();const fees=await this.#broker.fees();this.#fee(fees);const balances=await this.#accounts();
   if(!this.#state.funded){const initial=min(balances.get('USD')??0n,D(this.#config.allocation));if(initial<D('5'))hold('At least $5 available USD is required; existing crypto is never adopted or converted');const state=this.state;state.funded=true;state.initialCapital=S(initial);state.cash=state.initialCapital;state.equity=state.initialCapital;this.#save(state,'allocation_initialized');}
   const books=await this.#mark(fees);await this.#exits(feed,books,fees);
   if(this.#state.manualRecovery)hold(this.#state.hold??'Manual recovery required');if(this.#cycleHold)hold(this.#cycleHold);if(this.#state.lossLatched)hold('Loss trigger latched; new entries remain disabled');
   const state=this.state;state.lastSuccessAt=this.#now();this.#save(state,'verified');await this.#entry(feed,await this.#refreshFees(fees));
  }catch(error){
   if(this.#fatal)throw error;
   const state=this.state;const reason=error instanceof Hold?error.message:'Broker data or transport could not be verified; no new action taken';if(error instanceof Hold&&error.manual)latch(state,reason);state.hold=state.recoveryReason??reason;this.#save(state,'held');
  }finally{this.#running=false;}
  return this.state;
 }
}

export default Engine;
