import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../scripts/live/engine.mjs';
import {D,S,mul} from '../scripts/live/risk.mjs';
import {Journal} from '../scripts/live/journal.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const BASE=1789603200,PORTFOLIO='portfolio-fixture';
const copy=x=>structuredClone(x);
function memoryJournal(initial=null){let value=copy(initial);return {events:[],load:()=>copy(value),save(state,event){value=copy(state);this.events.push(copy(event));}};}
function fixture({mode='live',usd='20',journal=memoryJournal(),...extra}={}){
 let now=BASE,sequence=0;const calls=[],orders=new Map(),prices=new Map(),feed={generatedAt:BASE,markets:[]};
 function market(product,slope){const candles=Array.from({length:100},(_,i)=>{const c=100+i*slope;return [BASE-(100-i)*3600,c-4,c+4,c-.05,c,1000];});const price=candles.at(-1)[4];return {product,status:'online',tradingDisabled:false,candles,increment:.000001,minSize:.000001,minNotional:.1,book:{bids:[[price-.01,100]],asks:[[price+.01,100]],receivedAt:BASE,requestAt:BASE-1}};}
 feed.markets=[market('BTC-USD',.01),market('ABC-USD',.1)];
 const broker={allowSubmit:true,portfolioId:PORTFOLIO,
  async permissions(){return {can_view:true,can_trade:true,can_transfer:false,portfolio_uuid:PORTFOLIO};},
  async fees(){return {takerRate:.001,checkedAt:now,raw:{fee_tier:{taker_fee_rate:'0.001'}}};},
  async accounts(){return {has_next:false,cursor:'',accounts:['USD','BTC','ABC'].map(currency=>({uuid:`account-${currency}`,retail_portfolio_id:PORTFOLIO,currency,active:true,ready:true,available_balance:{currency,value:currency==='USD'?usd:'10'}}))};},
  async product(product_id){return {product_id,product_type:'SPOT',base_currency_id:product_id.slice(0,-4),quote_currency_id:'USD',status:'online',base_increment:'0.000001',price_increment:'0.001',quote_increment:'0.01',base_min_size:'0.000001',base_max_size:'100000',quote_min_size:'0.1',quote_max_size:'100000',trading_disabled:false,is_disabled:false,cancel_only:false,view_only:false,post_only:false,limit_only:false,auction_mode:false};},
  async book(id){calls.push(`book:${id}`);const market=feed.markets.find(m=>m.product===id),bid=prices.get(id)??market.book.bids[0][0],ask=bid+.02;return {product:id,requestAt:now,receivedAt:now,bookAt:now,bids:[[bid,100]],asks:[[ask,100]],pricebook:{product_id:id,bids:[{price:String(bid),size:'100'}],asks:[{price:String(ask),size:'100'}]}};},
  async preview(body){assert.equal(body.client_order_id,undefined,'Preview schema excludes create identity');assert.equal(body.preview_id,undefined,'Preview cannot reuse a prior preview identity');calls.push({preview:copy(body)});const c=Object.values(body.order_configuration)[0],principal=mul(D(c.base_size),D(c.limit_price));return {preview_id:'preview-fixture',errs:[],warning:[],commission_total:'0.01',order_total:S(principal+D('0.01')),quote_size:S(principal),base_size:c.base_size};},
  async create(body){
   const persisted=journal.load(),all=persisted.intents.flatMap(i=>[i,...i.exits]),intent=all.find(i=>i.clientOrderId===body.client_order_id);
   assert.ok(intent,'Intent must exist in durable journal before POST');assert.equal(intent.orderId,null);assert.deepEqual(intent.body,body);
   const order_id=`order-${++sequence}`;calls.push({create:copy(body),order_id});orders.set(order_id,{...copy(body),order_id,retail_portfolio_id:PORTFOLIO,product_type:'SPOT',status:'OPEN',settled:false,filled_size:'0',filled_value:'0',total_fees:'0',total_value_after_fees:'0'});
   return {success:true,success_response:{order_id,client_order_id:body.client_order_id}};
  },
  async orders(){return {has_next:false,cursor:'',orders:[...orders.values()].map(copy)};},
  async order(id){calls.push(`order:${id}`);assert.ok(orders.has(id),`Missing fake order ${id}`);return {order:copy(orders.get(id))};},
  async cancel(ids){calls.push({cancel:copy(ids)});for(const id of ids){const row=orders.get(id);row.status='CANCELLED';row.settled=false;}return {results:ids.map(order_id=>({success:true,order_id}))};},
 };
 const config={mode,expectedPortfolioId:PORTFOLIO,...extra.config};
 let engine=new Engine({broker,journal,...extra,config,clock:()=>now});
 const f={broker,journal,orders,feed,calls,prices,get engine(){return engine;},get now(){return now;},advance(seconds){now+=seconds;},addMarket(product,slope){feed.markets.push(market(product,slope));},setUSD(value){usd=value;},restart(patch={}){engine=new Engine({broker,journal,config:{...config,...patch},clock:()=>now});return engine;},tick:()=>engine.tick(feed)};
 f.enter=async()=>{await f.tick();f.advance(61);const state=await f.tick();assert.equal(state.intents.length,1,state.hold);return state.intents[0];};
 f.fillParent=(intent,{fraction=1,terminal=true,child=true}={})=>{
  const p=orders.get(intent.orderId),size=D(intent.plan.quantity)*BigInt(fraction===1?2:1)/2n,value=mul(size,D(intent.plan.limitPrice));Object.assign(p,{status:terminal?(fraction===1?'FILLED':'CANCELLED'):'OPEN',settled:terminal&&fraction===1,filled_size:S(size),filled_value:S(value),total_fees:'0.01',total_value_after_fees:S(value+D('0.01'))});
  if(child){const childId=`child-${intent.orderId}`;p.attached_order_id=childId;orders.set(childId,{order_id:childId,originating_order_id:p.order_id,product_id:p.product_id,product_type:'SPOT',retail_portfolio_id:PORTFOLIO,side:'SELL',status:'OPEN',settled:false,filled_size:'0',filled_value:'0',total_fees:'0',total_value_after_fees:'0',order_configuration:{trigger_bracket_gtc:{base_size:S(size),limit_price:intent.plan.target,stop_trigger_price:intent.plan.stop}}});}
  return p;
 };
 return f;
}

test('preview default cannot submit or cancel; full scan confirmation and fresh authenticated checks work',async()=>{
 const f=fixture({config:{mode:undefined}});await f.tick();f.advance(61);const result=await f.tick();assert.match(result.hold,/Preview passed/);assert.equal(result.intents.length,0);assert.equal(result.initialCapital,'20');assert.equal(f.calls.filter(c=>c.create||c.cancel).length,0);assert.ok(f.calls.filter(c=>c.preview).length);
});
test('live entry persists immutable intent before POST, enforces bracket and isolated allocation',async()=>{
 const f=fixture(),intent=await f.enter();assert.equal(intent.body.side,'BUY');assert.ok(intent.body.attached_order_configuration.trigger_bracket_gtc);assert.equal(intent.body.attached_order_configuration.trigger_bracket_gtc.base_size,undefined);assert.ok(D(intent.plan.reserved)<=D('5'));assert.equal(f.engine.state.cash,'20');assert.equal(f.calls.filter(c=>c.create).length,1);
 const external=f.engine.state;external.cash='999';assert.equal(f.engine.state.cash,'20');
 f.advance(10);await f.tick();assert.equal(f.calls.filter(c=>c.create).length,1,'Pending BUY reserves cash and prevents another order');
});
test('initial funding uses only available USD up to20, minimum5, freezes capital and never adopts BTC',async()=>{
 for(const usd of ['0','4.99']){const f=fixture({usd});const s=await f.tick();assert.equal(s.funded,false);assert.equal(s.cash,'0');assert.match(s.hold,/never adopted/);assert.equal(s.intents.length,0);}
 const f=fixture({usd:'19.52'});await f.tick();assert.equal(f.engine.state.initialCapital,'19.52');f.setUSD('100');f.restart();await f.tick();assert.equal(f.engine.state.initialCapital,'19.52');assert.equal(f.engine.state.cash,'19.52');
 const rich=fixture({usd:'100'});await rich.tick();assert.equal(rich.engine.state.initialCapital,'20');
 const bounded=fixture({usd:'18.8519512',config:{allocation:'18.85'}});await bounded.tick();assert.equal(bounded.engine.state.initialCapital,'18.85');bounded.setUSD('100');bounded.restart();await bounded.tick();assert.equal(bounded.engine.state.cash,'18.85');
});
test('unknown POST never retries and restart finds the original order by client ID',async()=>{
 const f=fixture(),base=f.broker.create;f.broker.create=async body=>{await base(body);throw Error('lost response');};
 const intent=await f.enter();assert.equal(intent.orderId,null);assert.match(f.engine.state.hold,/unknown/);f.restart();f.advance(1);await f.tick();assert.equal(f.engine.state.intents[0].orderId,'order-1');assert.equal(f.calls.filter(c=>c.create).length,1);
});
test('unknown POST absent from exhausted order history holds indefinitely with no new client ID',async()=>{
 const f=fixture();let attempts=0;f.broker.create=async()=>{attempts++;throw Error('not reached or unknown');};const intent=await f.enter();
 for(let i=0;i<3;i++){f.advance(60);f.restart();const state=await f.tick();assert.equal(state.intents[0].clientOrderId,intent.clientOrderId);assert.match(state.hold,/unknown.*no retry/);}
 assert.equal(attempts,1);assert.equal(f.engine.state.cash,'20');
});
test('cancelled partial BUY fills reconcile quantity, principal and fees across restart without double counting',async()=>{
 const f=fixture(),intent=await f.enter(),raw=f.fillParent(intent,{fraction:.5});f.advance(1);let state=await f.tick();const expected=S(D('20')-D(raw.filled_value)-D(raw.total_fees));assert.equal(state.cash,expected);assert.equal(state.intents[0].filledSize,raw.filled_size);assert.equal(state.intents[0].terminal,true);assert.equal(raw.settled,false);
 f.restart();state=await f.tick();assert.equal(state.cash,expected);assert.equal(state.intents.length,1);assert.equal(state.manualRecovery,false,state.hold);
});
test('nonmonotonic, foreign-side and oversized cumulative fills latch manual recovery without changing cash',async()=>{
 for(const kind of ['decrease','side','oversize']){const f=fixture(),intent=await f.enter(),raw=f.fillParent(intent);await f.tick();const previous=f.engine.state.cash;if(kind==='decrease')raw.filled_value='0';if(kind==='side')raw.side='SELL';if(kind==='oversize')raw.filled_size=S(D(intent.plan.quantity)+D('1'));const state=await f.tick();assert.equal(state.manualRecovery,true,kind);assert.equal(state.cash,previous,kind);assert.equal(f.calls.filter(c=>c.create).length,1);}
});
test('stale BUY cancellation persists first, requires GET terminal, and retries a failed cancellation after confirmation',async()=>{
 const f=fixture(),intent=await f.enter(),cancel=f.broker.cancel;let attempts=0;f.broker.cancel=async ids=>{attempts++;assert.equal(f.journal.load().intents[0].cancelRequestedAt,f.now);if(attempts===1)throw Error('not reached');return cancel(ids);};
 f.advance(31);await f.tick();assert.equal(attempts,1);assert.equal(f.engine.state.intents[0].terminal,false);f.advance(31);await f.tick();assert.equal(attempts,2);assert.equal(f.engine.state.intents[0].terminal,false);await f.tick();assert.equal(f.engine.state.intents[0].terminal,true);assert.equal(f.engine.state.cash,'20');assert.equal(f.engine.state.intents[0].orderId,intent.orderId);
});
test('partial native SELL credits only its cumulative proceeds and holds unprotected remainder',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();const before=D(f.engine.state.cash),child=f.orders.get(`child-${intent.orderId}`),size=D(intent.plan.quantity)/2n,value=mul(size,D(intent.plan.target));Object.assign(child,{filled_size:S(size),filled_value:S(value),total_fees:'0.01',total_value_after_fees:S(value-D('0.01'))});
 const state=await f.tick();assert.equal(state.cash,S(before+value-D('0.01')));assert.equal(state.manualRecovery,true);assert.match(state.hold,/partially filled|manual recovery/);assert.equal(f.calls.filter(c=>c.create).length,1);
});
test('maximum-hold exit cancels verified child then reconciles terminal before selling only owned quantity',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();f.advance(72*3600);await f.tick();assert.deepEqual(f.calls.find(c=>c.cancel)?.cancel,[`child-${intent.orderId}`]);assert.equal(f.calls.filter(c=>c.create).length,1);
 await f.tick();const state=f.engine.state,sell=f.calls.filter(c=>c.create).at(-1).create;assert.equal(state.intents[0].exits.length,1,state.hold);assert.equal(sell.side,'SELL');assert.equal(sell.order_configuration.sor_limit_ioc.base_size,intent.plan.quantity);assert.equal(sell.product_id,intent.product);assert.ok(D(sell.order_configuration.sor_limit_ioc.base_size)<D('10'),'Existing account assets must not be sold');
 const exit=state.intents[0].exits[0],raw=f.orders.get(exit.orderId),quantity=D(raw.order_configuration.sor_limit_ioc.base_size),gross=mul(quantity,D(raw.order_configuration.sor_limit_ioc.limit_price));Object.assign(raw,{status:'FILLED',settled:true,filled_size:S(quantity),filled_value:S(gross),total_fees:'0.01',total_value_after_fees:S(gross-D('0.01'))});
 await f.tick();const closed=f.engine.state.intents[0];assert.equal(closed.exits[0].terminal,true);assert.ok(closed.closedAt);const cooldown=f.engine.state.cooldowns[intent.product];f.advance(60);await f.tick();assert.equal(f.engine.state.cooldowns[intent.product],cooldown);
});
test('exit product restrictions preserve existing native protection',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();f.advance(72*3600);const product=f.broker.product;f.broker.product=async id=>({...await product(id),view_only:true});const state=await f.tick();assert.equal(state.manualRecovery,true);assert.equal(f.calls.filter(c=>c.cancel).length,0);assert.equal(f.calls.filter(c=>c.create).length,1);
});
test('exit POST ambiguity is reconciled on restart and never sells the same quantity twice',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();f.advance(72*3600);await f.tick();const create=f.broker.create;f.broker.create=async body=>{await create(body);throw Error('unknown');};await f.tick();assert.equal(f.engine.state.intents[0].exits[0].orderId,null);f.restart();await f.tick();assert.ok(f.engine.state.intents[0].exits[0].orderId);assert.equal(f.calls.filter(c=>c.create).length,2);
});
test('cash/portfolio/trade guards and a stopped runner cannot create an order',async()=>{
 for(const kind of ['portfolio','transfer','trade','broker']){const f=fixture();if(kind==='broker')f.broker.allowSubmit=false;else{const permissions=f.broker.permissions;f.broker.permissions=async()=>({...await permissions(),...(kind==='portfolio'?{portfolio_uuid:'foreign'}:kind==='transfer'?{can_transfer:true}:{can_trade:false})});}await f.tick();f.advance(61);await f.tick();assert.equal(f.calls.filter(c=>c.create||c.cancel).length,0,kind);}
 let stopping=false;const f=fixture({isStopping:()=>stopping});await f.tick();stopping=true;f.advance(61);const s=await f.tick();assert.match(s.hold,/Shutdown/);assert.equal(s.intents.length,0);
 const low=fixture();await low.tick();low.setUSD('0');low.advance(61);await low.tick();assert.equal(low.calls.filter(c=>c.create).length,0);
});
test('slow cached quotes do not starve confirmation; executable books must still be fresh',async()=>{
 const f=fixture();for(const m of f.feed.markets){m.book.receivedAt-=35;m.book.requestAt-=35;}f.advance(15);await f.tick();for(let i=0;i<4;i++){f.advance(15);await f.tick();}assert.equal(f.engine.state.intents.length,1,f.engine.state.hold);
 const stale=fixture(),base=stale.broker.book;stale.broker.book=async id=>({...await base(id),bookAt:stale.now-16});await stale.tick();stale.advance(61);await stale.tick();assert.equal(stale.calls.filter(c=>c.create).length,0);
 const skewed=fixture(),skewBook=skewed.broker.book;skewed.broker.book=async id=>({...await skewBook(id),bookAt:skewed.now+2});await skewed.enter();
 const future=fixture(),futureBook=future.broker.book;future.broker.book=async id=>({...await futureBook(id),bookAt:future.now+6});await future.tick();future.advance(61);await future.tick();assert.equal(future.calls.filter(c=>c.create).length,0);
});
test('corrupt journal, persistence failures and concurrent ticks fail closed',async()=>{
 assert.throws(()=>fixture({journal:memoryJournal({cash:'20'})}),/journal/);
 const f=fixture();await f.tick();const save=f.journal.save;f.journal.save=()=>{throw Error('disk failure');};f.advance(61);await assert.rejects(f.tick(),/persistence failed/);assert.equal(f.calls.filter(c=>c.create).length,0);f.journal.save=save;await assert.rejects(f.tick(),/restart required/);
 const parallel=fixture();let release;parallel.broker.permissions=()=>new Promise(resolve=>{release=resolve;});const pending=parallel.tick();await assert.rejects(parallel.tick(),/already running/);release({can_view:false});await pending;
});
test('preview restart reconciles live holdings without cancellation even when exit overdue',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);f.restart({mode:'preview'});f.advance(72*3600);const state=await f.tick();assert.equal(state.intents[0].filledSize,intent.plan.quantity);assert.match(state.hold,/preview mode/);assert.equal(f.calls.filter(c=>c.cancel).length,0);assert.equal(f.calls.filter(c=>c.create).length,1);
});

async function threePositions(f){
 f.addMarket('DEF-USD',.08);let intent=await f.enter();
 for(let i=0;i<3;i++){f.fillParent(intent);await f.tick();if(i<2){f.advance(61);await f.tick();assert.equal(f.engine.state.intents.length,i+2,f.engine.state.hold);intent=f.engine.state.intents.at(-1);}}
 assert.equal(f.engine.state.intents.length,3);return f.engine.state.intents;
}
test('loss trigger uses net liquidation, persists across restart and never enables new entries again',async()=>{
 const f=fixture(),intents=await threePositions(f);assert.ok(D(f.engine.state.cash)<D('18'),'Fixture must expose more than $2 to the gap');for(const i of intents)f.prices.set(i.product,1);
 let state=await f.tick();assert.equal(state.lossLatched,true);assert.ok(D(state.equity)<=D('18'));const created=f.calls.filter(c=>c.create).length;
 f.restart();f.prices.clear();state=await f.tick();assert.equal(state.lossLatched,true);assert.equal(f.calls.filter(c=>c.create).length,created);
});
test('one unavailable order or book cannot starve independent maximum-hold exits',async()=>{
 for(const kind of ['order','book']){const f=fixture(),intents=await threePositions(f);f.advance(72*3600);if(kind==='order'){const base=f.broker.order;f.broker.order=async id=>{if(id===intents[0].orderId)throw Error('unavailable');return base(id);};}else{const base=f.broker.book;f.broker.book=async id=>{if(id===intents[0].product)throw Error('unavailable');return base(id);};}
  const state=await f.tick(),cancelled=f.calls.filter(c=>c.cancel).flatMap(c=>c.cancel);assert.equal(cancelled.length,2,`${kind}: ${state.hold}`);for(const i of intents.slice(1))assert.ok(cancelled.includes(`child-${i.orderId}`));assert.equal(state.marksComplete,false);assert.equal(f.calls.filter(c=>c.create).length,3);
 }
});
test('missing child attachment and parent-child fill snapshot races recover without permanent manual latch',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent,{child:false});let state=await f.tick();assert.equal(state.manualRecovery,false);assert.match(state.hold,/protection/);f.fillParent(intent);state=await f.tick();assert.equal(state.manualRecovery,false);
 const raced=fixture(),entry=await raced.enter(),full=raced.fillParent(entry),base=raced.broker.order;let first=true;
 raced.broker.order=async id=>{if(id===entry.orderId&&first){first=false;const size=D(full.filled_size)/2n,value=mul(size,D(entry.plan.limitPrice));return {order:{...copy(full),status:'OPEN',settled:false,filled_size:S(size),filled_value:S(value),total_value_after_fees:S(value+D('0.01'))}};}return base(id);};
 state=await raced.tick();assert.equal(state.manualRecovery,false,state.hold);assert.equal(state.intents[0].filledSize,entry.plan.quantity);
});
test('child cancel retry requires fresh OPEN observation and terminal confirmation before selling',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();f.advance(72*3600);const cancel=f.broker.cancel;let attempts=0;f.broker.cancel=async ids=>{if(++attempts===1)throw Error('unavailable');return cancel(ids);};await f.tick();assert.equal(attempts,1);assert.equal(f.calls.filter(c=>c.create).length,1);f.advance(31);await f.tick();assert.equal(attempts,2);assert.equal(f.calls.filter(c=>c.create).length,1);await f.tick();assert.equal(f.calls.filter(c=>c.create).length,2);
});
test('incoherent attached-child snapshot cannot leave an expired parent BUY open',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent,{fraction:.5,terminal:false});const child=f.orders.get(`child-${intent.orderId}`);child.order_configuration.trigger_bracket_gtc.base_size=intent.plan.quantity;
 f.advance(31);const state=await f.tick();assert.equal(f.calls.filter(c=>c.cancel).length,1);assert.deepEqual(f.calls.find(c=>c.cancel).cancel,[intent.orderId]);assert.equal(state.manualRecovery,false);assert.equal(state.intents[0].terminal,false,'Cancellation response alone is not terminal proof');
});
test('cancelled partial software SELL credits actual fees and next exit only reserves owned remainder',async()=>{
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();f.advance(72*3600);await f.tick();await f.tick();const first=f.engine.state.intents[0].exits[0],raw=f.orders.get(first.orderId),quantity=D(raw.order_configuration.sor_limit_ioc.base_size)/2n,value=mul(quantity,D(raw.order_configuration.sor_limit_ioc.limit_price)),before=D(f.engine.state.cash);
 Object.assign(raw,{status:'CANCELLED',settled:false,filled_size:S(quantity),filled_value:S(value),total_fees:'0.01',total_value_after_fees:S(value-D('0.01'))});await f.tick();const state=f.engine.state;assert.equal(state.cash,S(before+value-D('0.01')));assert.equal(state.intents[0].exits.length,2,state.hold);const next=state.intents[0].exits[1].body.order_configuration.sor_limit_ioc;assert.ok(D(next.base_size)<=D(intent.plan.quantity)-quantity);assert.equal(state.manualRecovery,false);
});
test('real SQLite journal preserves engine intents and exact accounting through close/reopen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pm-engine-'));let journal=new Journal(directory);
 try{
  const f=fixture({journal}),intent=await f.enter(),raw=f.fillParent(intent,{fraction:.5});await f.tick();const cash=f.engine.state.cash;journal.close();journal=new Journal(directory);
  const restarted=new Engine({broker:f.broker,journal,config:{mode:'preview',expectedPortfolioId:PORTFOLIO},clock:()=>f.now});
  const state=await restarted.tick(f.feed);assert.equal(state.cash,cash);assert.equal(state.cash,S(D('20')-D(raw.filled_value)-D(raw.total_fees)));assert.equal(state.intents[0].clientOrderId,intent.clientOrderId);assert.equal(state.intents[0].filledSize,raw.filled_size);assert.equal(f.calls.filter(c=>c.create).length,1);
 }finally{journal.close();rmSync(directory,{recursive:true,force:true});}
});

test('an OPEN native bracket projected total is never treated as completed sale proceeds',async()=>{
 const f=fixture(),intent=await f.enter(),parent=f.fillParent(intent),child=f.orders.get(`child-${intent.orderId}`);
 // Observed Coinbase response shape, with synthetic identifiers and amounts.
 child.total_value_after_fees=S(mul(mul(D(intent.plan.quantity),D(intent.plan.target)),D('0.991')));
 assert.ok(D(child.total_value_after_fees)>0n);
 const state=await f.tick();
 assert.equal(state.manualRecovery,false,state.hold);
 assert.equal(state.intents[0].child.status,'OPEN');
 assert.equal(state.intents[0].child.filledValue,'0');
 assert.equal(state.cash,S(D('20')-D(parent.filled_value)-D(parent.total_fees)));
 assert.equal(state.marksComplete,true);
 assert.equal(f.calls.filter(c=>c.create||c.cancel).length,1);
});
test('cancelled partial BUY credits only actual cumulative fields despite a projected order total',async()=>{
 const f=fixture(),intent=await f.enter(),parent=f.fillParent(intent,{fraction:.5});
 parent.total_value_after_fees=intent.plan.reserved;
 const state=await f.tick();
 assert.equal(state.manualRecovery,false,state.hold);
 assert.equal(state.cash,S(D('20')-D(parent.filled_value)-D(parent.total_fees)));
 assert.equal(state.intents[0].filledSize,parent.filled_size);
});
test('settled FILLED order totals must still match actual principal and fees',async()=>{
 const f=fixture(),intent=await f.enter(),parent=f.fillParent(intent);
 parent.total_value_after_fees=S(D(parent.total_value_after_fees)+D('0.01'));
 const state=await f.tick();assert.equal(state.manualRecovery,true);assert.equal(state.cash,'20');
 assert.equal(state.recoveryReason,'Venue total and cumulative fees disagree');
 assert.equal(state.hold,state.recoveryReason,'Later marking failures must not hide the original cause');
});

async function projectionIncident(){
 const f=fixture(),intent=await f.enter();f.fillParent(intent);await f.tick();
 const state=f.journal.load(),parent=state.intents[0],child=f.orders.get(parent.child.orderId);
 child.total_value_after_fees=S(mul(mul(D(parent.filledSize),D(parent.plan.target)),D('0.991')));
 // Reproduce the old durable state after the parent saved but child check failed.
 state.manualRecovery=true;parent.manualRecovery=true;parent.child.status='UNKNOWN';state.marksComplete=false;
 state.hold='Position awaits its own verified order and liquidation data';
 f.journal.save(state,{type:'legacy_fixture'});f.restart();return f;
}
test('read-only incident inspection and scoped recovery preserve actual accounting and native protection',async()=>{
 const f=await projectionIncident(),before=f.engine.state,orders=copy([...f.orders]),mutations=f.calls.filter(c=>c.create||c.cancel).length,events=f.journal.events.length;
 const report=await f.engine.inspectProjectionRecovery();
 assert.equal(report.eligible,true);assert.equal(report.protectionStatus,'OPEN');assert.match(report.token,/^projection-v1-[a-f0-9]{64}$/);
 assert.deepEqual(f.engine.state,before);assert.deepEqual(f.journal.load(),before);assert.equal(f.journal.events.length,events);
 const result=await f.engine.recoverProjectionHold(report.token),after=f.engine.state;
 assert.equal(result.recovered,true);assert.equal(after.manualRecovery,false);assert.equal(after.intents[0].manualRecovery,false);
 assert.equal(after.intents[0].child.status,'OPEN');assert.equal(after.cash,before.cash);assert.equal(after.initialCapital,before.initialCapital);
 for(const key of ['orderId','clientOrderId','filledSize','filledValue','fees','body','plan'])assert.deepEqual(after.intents[0][key],before.intents[0][key],key);
 assert.equal(after.intents[0].child.orderId,before.intents[0].child.orderId);assert.equal(after.marksComplete,true);
 assert.equal(f.journal.events.at(-1).type,'projection_recovery');assert.equal(f.calls.filter(c=>c.create||c.cancel).length,mutations);assert.deepEqual([...f.orders],orders);
});
test('ordinary reconciliation and restart never clear a persisted recovery latch',async()=>{
 const f=await projectionIncident();await f.tick();f.restart();await f.tick();
 assert.equal(f.engine.state.manualRecovery,true);assert.equal(f.engine.state.intents[0].manualRecovery,true);
 assert.equal(f.engine.state.intents[0].child.status,'OPEN');assert.equal(f.engine.state.marksComplete,true);
 assert.equal(f.calls.filter(c=>c.create||c.cancel).length,1);
});
test('recovery rejects malformed or different-entry acknowledgements and keeps ledger unchanged',async()=>{
 const f=await projectionIncident(),other=await projectionIncident(),report=await other.engine.inspectProjectionRecovery(),before=f.engine.state;
 for(const token of [undefined,'clear-all',report.token])await assert.rejects(f.engine.recoverProjectionHold(token));
 assert.deepEqual(f.engine.state,before);assert.deepEqual(f.journal.load(),before);
});
test('recovery rechecks changed evidence and rejects unrelated or unsafe incident states',async()=>{
 for(const kind of ['reason','loss','multiple','pending-parent','pending-child','child-origin','child-config','child-filled','child-cancelled','parent-fees','cash','book','liquidation']){
  const f=await projectionIncident(),report=await f.engine.inspectProjectionRecovery(),parent=f.engine.state.intents[0],rawParent=f.orders.get(parent.orderId),child=f.orders.get(parent.child.orderId);
  if(['reason','loss','multiple'].includes(kind)){
   const state=f.journal.load();
   if(kind==='reason')state.recoveryReason='Order identity, side or status mismatch';
   if(kind==='loss')state.lossLatched=true;
   if(kind==='multiple'){
    const extra=copy(state.intents[0]);extra.clientOrderId='other-client';extra.body.client_order_id=extra.clientOrderId;extra.orderId='other-order';extra.child.orderId='other-child';
    state.intents.push(extra);state.cash=S(D(state.cash)-D(extra.filledValue)-D(extra.fees));
   }
   f.journal.save(state,{type:'changed_fixture'});f.restart();
  }
  if(kind==='pending-parent')rawParent.pending_cancel=true;
  if(kind==='pending-child')child.pending_cancel=true;
  if(kind==='child-origin')child.originating_order_id='foreign-parent';
  if(kind==='child-config')child.order_configuration.trigger_bracket_gtc.limit_price='999';
  if(kind==='child-filled'){child.filled_size='0.001';child.filled_value='0.1';}
  if(kind==='child-cancelled')child.status='CANCELLED';
  if(kind==='parent-fees')rawParent.total_fees='0.02';
  if(kind==='cash')f.setUSD('0');
  if(kind==='book'){const book=f.broker.book;f.broker.book=async id=>({...await book(id),bookAt:f.now-16});}
  if(kind==='liquidation'){
   const state=f.journal.load();state.lossLimit='0.1';f.journal.save(state,{type:'small_loss_limit_fixture'});f.restart({lossLimit:'0.1'});
   f.prices.set(parent.product,0.01);
  }
  const before=f.engine.state;await assert.rejects(f.engine.recoverProjectionHold(report.token),undefined,kind);
  assert.deepEqual(f.engine.state,before,kind);assert.deepEqual(f.journal.load(),before,kind);assert.equal(f.calls.filter(c=>c.create||c.cancel).length,1,kind);
 }
});
test('recovery token replay cannot clear a subsequent unrelated hold',async()=>{
 const f=await projectionIncident(),report=await f.engine.inspectProjectionRecovery();await f.engine.recoverProjectionHold(report.token);
 const state=f.journal.load();state.manualRecovery=true;state.recoveryReason='Attached exit origin mismatch';state.intents[0].manualRecovery=true;
 f.journal.save(state,{type:'later_hold'});f.restart();const before=f.engine.state;
 assert.deepEqual(await f.engine.recoverProjectionHold(report.token),{recovered:false,alreadyRecovered:true});assert.deepEqual(f.engine.state,before);
});
test('a later distinct recovery fault remains a blocker even after its broker snapshot recovers',async()=>{
 const f=await projectionIncident(),report=await f.engine.inspectProjectionRecovery(),state=f.journal.load();
 state.recoveryReason='Venue total and cumulative fees disagree';state.intents[0].recoveryReason=state.recoveryReason;
 f.journal.save(state,{type:'known_projection_reason'});f.restart();
 const child=f.orders.get(state.intents[0].child.orderId),origin=child.originating_order_id;child.originating_order_id='foreign-parent';
 await f.tick();child.originating_order_id=origin;await f.tick();
 assert.equal(f.engine.state.recoveryReason,'Venue total and cumulative fees disagree');
 assert.ok(f.engine.state.recoveryReasons.includes('Attached exit origin mismatch'));
 await assert.rejects(f.engine.recoverProjectionHold(report.token),/different recovery reason/);assert.equal(f.engine.state.manualRecovery,true);
});
test('recovery and inspection exclusively lock the engine across broker awaits',async()=>{
 for(const recover of [false,true]){
  const f=await projectionIncident(),report=await f.engine.inspectProjectionRecovery(),permissions=f.broker.permissions;let release;
  f.broker.permissions=()=>new Promise(resolve=>{release=async()=>resolve(await permissions());});
  const pending=recover?f.engine.recoverProjectionHold(report.token):f.engine.inspectProjectionRecovery();
  await assert.rejects(f.tick(),/already running/);await assert.rejects(f.engine.inspectProjectionRecovery(),/idle healthy/);
  await assert.rejects(f.engine.recoverProjectionHold(report.token),/idle healthy/);await release();await pending;
  f.broker.permissions=permissions;await f.tick();assert.equal(f.engine.state.manualRecovery,!recover);
 }
});

test('capacity changes preserve existing ledger, holdings, protection and immutable plans across restart',async()=>{
 const f=fixture();await threePositions(f);f.addMarket('GHI-USD',.06);
 const before=f.engine.state,creates=f.calls.filter(c=>c.create).length;
 f.restart({capacityProfile:'expanded'});let state=await f.tick();
 assert.equal(state.capacityProfile,'expanded');assert.equal(state.initialCapital,before.initialCapital);assert.equal(state.cash,before.cash);
 for(let i=0;i<3;i++){assert.deepEqual(state.intents[i].plan,before.intents[i].plan);assert.equal(state.intents[i].child.orderId,before.intents[i].child.orderId);}
 assert.ok(f.journal.events.some(e=>e.type==='capacity_change'));assert.equal(f.calls.filter(c=>c.cancel).length,0);
 f.advance(61);state=await f.tick();assert.equal(state.intents.length,4,state.hold);assert.equal(f.calls.filter(c=>c.create).length,creates+1);
 assert.equal(state.intents[3].plan.capacityProfile,'expanded');f.fillParent(state.intents[3]);await f.tick();
 f.restart({capacityProfile:'standard'});state=await f.tick();
 assert.equal(state.capacityProfile,'standard');assert.equal(state.intents.length,4);assert.match(state.hold,/Maximum owned positions/);
 assert.equal(f.calls.filter(c=>c.cancel).length,0,'Reducing capacity does not liquidate existing protected holdings');
 assert.equal(state.initialCapital,before.initialCapital);
});
async function expandedPositions(count=10){
 const f=fixture({usd:'18.85',config:{allocation:'18.85',capacityProfile:'expanded'}});
 for(let i=0;i<11;i++)f.addMarket(`T${i}-USD`,.099-i*.001);
 let intent=await f.enter();
 for(let i=0;i<count;i++){
  f.fillParent(intent);await f.tick();
  if(i<count-1){f.advance(61);const state=await f.tick();assert.equal(state.intents.length,i+2,`${i}: ${state.hold}`);intent=state.intents.at(-1);}
 }
 return f;
}
test('expanded capacity can hold ten distinct positions but refuses an eleventh and does not top up',async()=>{
 const f=await expandedPositions();
 f.setUSD('1000');f.advance(61);f.restart();const state=await f.tick();
 assert.equal(state.intents.length,10);assert.match(state.hold,/Maximum owned positions/);assert.equal(state.initialCapital,'18.85');
 assert.ok(D(state.cash)>=0n);assert.equal(f.calls.filter(c=>c.create).length,10);assert.equal(f.calls.filter(c=>c.cancel).length,0);
 for(const position of state.intents){assert.equal(position.child.status,'OPEN');assert.ok(D(position.plan.reserved)<=D('5'));assert.ok(D(position.plan.risk)<=D('0.1885'));}
});
test('ten slow position reads refresh fees and cannot starve independently valid software exits',async()=>{
 const f=await expandedPositions(),book=f.broker.book,fees=f.broker.fees,accounts=f.broker.accounts;let feeReads=0;
 f.broker.accounts=async()=>{const result=await accounts();for(const position of f.engine.state.intents){const currency=position.product.slice(0,-4);if(!result.accounts.some(a=>a.currency===currency))result.accounts.push({uuid:`account-${currency}`,retail_portfolio_id:PORTFOLIO,currency,active:true,ready:true,available_balance:{currency,value:position.filledSize}});}return result;};
 f.broker.book=async id=>{const result=await book(id);f.advance(1.6);return result;};
 f.broker.fees=async()=>{feeReads++;return fees();};
 f.advance(72*3600);await f.tick();
 assert.equal(f.calls.filter(c=>c.cancel).length,10,'Every independently verified protective child must reach cancellation');
 assert.ok(feeReads>1,'Aging authenticated fees must be refreshed, not trusted past expiry');
 assert.equal(f.engine.state.marksComplete,false,'Oldest aggregate book is over15s old');
 await f.tick();assert.equal(f.calls.filter(c=>c.create).length,20,'Ten fee-checked software exits can follow confirmed child cancellation');
 assert.equal(f.engine.state.manualRecovery,false,f.engine.state.hold);
});
test('slow aggregate marking never labels expired books as complete or spends from stale equity',async()=>{
 const f=await expandedPositions(),book=f.broker.book;
 f.broker.book=async id=>{const result=await book(id);f.advance(1.6);return result;};
 const state=await f.tick();assert.equal(state.marksComplete,false);assert.match(state.hold,/aged during marking/);
 assert.equal(f.calls.filter(c=>c.create).length,10);assert.equal(f.calls.filter(c=>c.cancel).length,0);
});
test('a pending BUY is reconciled and cancelled before slow reads of nine established holdings',async()=>{
 const f=await expandedPositions(9);f.advance(61);await f.tick();const pending=f.engine.state.intents.at(-1);
 assert.equal(f.engine.state.intents.length,10);assert.equal(pending.terminal,false);
 const order=f.broker.order;f.broker.order=async id=>{f.advance(1.6);return order(id);};
 const start=f.calls.length;f.advance(31);await f.tick();const cycle=f.calls.slice(start);
 assert.equal(cycle.find(c=>typeof c==='string'&&c.startsWith('order:')),`order:${pending.orderId}`);
 const cancelIndex=cycle.findIndex(c=>c.cancel?.includes(pending.orderId));assert.ok(cancelIndex>=0);
 assert.ok(cancelIndex<cycle.findIndex(c=>c===`order:${f.engine.state.intents[0].orderId}`));
 assert.equal(f.engine.state.manualRecovery,false);
});
test('capacity configuration rejects invalid profiles and position counts beyond the selected profile',()=>{
 for(const config of [{capacityProfile:'unlimited'},{maxPositions:4},{capacityProfile:'expanded',maxPositions:11},{capacityProfile:'expanded',maxPositions:0}])assert.throws(()=>fixture({config}));
});
