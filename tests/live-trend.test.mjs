import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {Engine} from '../scripts/live/engine.mjs';
import {D,S,mul,planEntry} from '../scripts/live/risk.mjs';
import {CoinbaseLive} from '../scripts/live/coinbase.mjs';
import {configuration,receipt,newState,trendSummary} from '../scripts/live/runner.mjs';
import {TrendFeed} from '../scripts/live/trend-feed.mjs';
import {TREND_POLICY,trendSignal,completedDaily} from '../dashboard/trend-core.mjs';

const DAY=86400,BASE=1789603200,PORTFOLIO='portfolio-fixture';
const copy=x=>structuredClone(x);
// Daily bars ending with the bar that closed at BASE. Rising closes put the
// latest close well above the 100-day average: an entry signal.
function daily(closeAt=i=>60+i*.3,count=150,end=BASE){return Array.from({length:count},(_,k)=>{const i=k,time=end-(count-k)*DAY,c=closeAt(i);return [time,c-1,c+1,c-.2,c,1000];});}
const exitBars=()=>{const bars=daily();for(const bar of bars.slice(-3)){bar[4]=80;bar[1]=79;bar[2]=81;bar[3]=80.5;}return bars;};
function memoryJournal(initial=null){let value=copy(initial);return {events:[],load:()=>copy(value),save(state,event){value=copy(state);this.events.push(copy(event));}};}

function fixture({mode='live',usd='18.85',rate='0.009',journal=memoryJournal(),config={}}={}){
 let now=BASE+120,sequence=0;const calls=[],orders=new Map(),prices=new Map([['BTC-USD',104.5],['ETH-USD',104.5]]);
 const trend={policyId:TREND_POLICY.id,candles:{'BTC-USD':daily(),'ETH-USD':daily()},fetchedAt:{'BTC-USD':now,'ETH-USD':now}};
 const broker={allowSubmit:true,portfolioId:PORTFOLIO,createResponse:null,
  async permissions(){return {can_view:true,can_trade:true,can_transfer:false,portfolio_uuid:PORTFOLIO};},
  async fees(){return {takerRate:Number(rate),checkedAt:now,raw:{fee_tier:{taker_fee_rate:rate,maker_fee_rate:'0.005'}}};},
  async accounts(){return {has_next:false,cursor:'',accounts:['USD','BTC','ETH'].map(currency=>({uuid:`account-${currency}`,retail_portfolio_id:PORTFOLIO,currency,active:true,ready:true,available_balance:{currency,value:currency==='USD'?usd:'10'}}))};},
  async product(product_id){return {product_id,product_type:'SPOT',base_currency_id:product_id.slice(0,-4),quote_currency_id:'USD',status:'online',base_increment:'0.00000001',price_increment:'0.01',quote_increment:'0.01',base_min_size:'0.00000001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'1000000',trading_disabled:false,is_disabled:false,cancel_only:false,view_only:false,post_only:false,limit_only:false,auction_mode:false};},
  async book(id){calls.push(`book:${id}`);const bid=prices.get(id),ask=Math.round((bid+.02)*100)/100;return {product:id,requestAt:now,receivedAt:now,bookAt:now,bids:[[bid,100]],asks:[[ask,100]],pricebook:{product_id:id,bids:[{price:String(bid),size:'100'}],asks:[{price:String(ask),size:'100'}]}};},
  async preview(body){assert.equal(body.client_order_id,undefined);calls.push({preview:copy(body)});const c=Object.values(body.order_configuration)[0],principal=mul(D(c.base_size),D(c.limit_price)),fee=(principal*D(rate)/10n**18n+D('0.01')-1n)/D('0.01')*D('0.01');return {preview_id:'preview-fixture',errs:[],warning:[],commission_total:S(fee),order_total:S(principal+fee),quote_size:S(principal),base_size:c.base_size};},
  async create(body){
   const persisted=journal.load(),all=persisted.intents.flatMap(i=>[i,...i.exits]),intent=all.find(i=>i.clientOrderId===body.client_order_id);
   assert.ok(intent,'Intent must exist in durable journal before POST');assert.equal(intent.orderId,null);
   calls.push({create:copy(body)});
   if(broker.createResponse)return broker.createResponse;
   const order_id=`order-${++sequence}`;orders.set(order_id,{...copy(body),order_id,retail_portfolio_id:PORTFOLIO,product_type:'SPOT',status:'OPEN',settled:false,filled_size:'0',filled_value:'0',total_fees:'0',total_value_after_fees:'0'});
   return {success:true,success_response:{order_id,client_order_id:body.client_order_id}};
  },
  async orders(){return {has_next:false,cursor:'',orders:[...orders.values()].map(copy)};},
  async order(id){assert.ok(orders.has(id),`Missing fake order ${id}`);return {order:copy(orders.get(id))};},
  async cancel(ids){calls.push({cancel:copy(ids)});for(const id of ids){const row=orders.get(id);row.status='CANCELLED';row.settled=false;}return {results:ids.map(order_id=>({success:true,order_id}))};},
 };
 const base={mode,expectedPortfolioId:PORTFOLIO,allocation:'18.85',strategy:'trend',capacityProfile:'trend',...config};
 let engine=new Engine({broker,journal,config:base,clock:()=>now});
 const f={broker,journal,orders,calls,prices,trend,get engine(){return engine;},get now(){return now;},
  advance(seconds){now+=seconds;},
  restart(patch={}){engine=new Engine({broker,journal,config:{...base,...patch},clock:()=>now});return engine;},
  tick:()=>engine.tick({markets:[],trend:copy(trend)}),
  creates:()=>calls.filter(c=>c.create).map(c=>c.create)};
 f.enter=async()=>{const before=f.engine.state.intents.length;await f.tick();f.advance(61);const state=await f.tick();assert.equal(state.intents.length,before+1,state.hold);return state.intents.at(-1);};
 f.fill=intent=>{
  const p=orders.get(intent.orderId),size=D(intent.plan.quantity),value=mul(size,D(intent.plan.limitPrice));
  Object.assign(p,{status:'FILLED',settled:true,filled_size:S(size),filled_value:S(value),total_fees:'0.03',total_value_after_fees:S(value+D('0.03')),attached_order_id:`child-${intent.orderId}`});
  orders.set(`child-${intent.orderId}`,{order_id:`child-${intent.orderId}`,originating_order_id:p.order_id,product_id:p.product_id,product_type:'SPOT',retail_portfolio_id:PORTFOLIO,side:'SELL',status:'OPEN',settled:false,filled_size:'0',filled_value:'0',total_fees:'0',total_value_after_fees:'0',order_configuration:{trigger_bracket_gtc:{base_size:S(size),limit_price:intent.plan.target,stop_trigger_price:intent.plan.stop}}});
 };
 f.fillSell=exit=>{const raw=orders.get(exit.orderId),c=raw.order_configuration.sor_limit_ioc,q=D(c.base_size),gross=mul(q,D(c.limit_price));Object.assign(raw,{status:'FILLED',settled:true,filled_size:S(q),filled_value:S(gross),total_fees:'0.02',total_value_after_fees:S(gross-D('0.02'))});};
 return f;
}

test('trend signal uses completed daily bars with entry and exit hysteresis',()=>{
 const now=BASE+60,bars=daily();
 const enter=trendSignal({product:'BTC-USD',candles:bars,now});
 assert.equal(enter.status,'ready');assert.equal(enter.action,'enter');assert.ok(enter.close>enter.upper);
 assert.equal(enter.signalId,`${TREND_POLICY.id}:BTC-USD:${BASE-DAY}`);
 assert.equal(trendSignal({product:'BTC-USD',candles:bars,now,held:true}).action,'hold');
 const inside=daily(i=>i<149?100:100.5);
 assert.equal(trendSignal({product:'BTC-USD',candles:inside,now}).action,'wait','Inside the entry band stays flat');
 assert.equal(trendSignal({product:'BTC-USD',candles:inside,now,held:true}).action,'hold','Inside the exit band stays long');
 assert.equal(trendSignal({product:'BTC-USD',candles:exitBars(),now,held:true}).action,'exit');
 const partial=[...bars,[BASE,1,500,100,400,1]];
 assert.equal(trendSignal({product:'BTC-USD',candles:partial,now}).close,bars.at(-1)[4],'The in-progress UTC bar is ignored');
});
test('trend signal fails closed on stale, gapped, short or foreign history',()=>{
 const bars=daily();
 assert.equal(trendSignal({product:'BTC-USD',candles:bars,now:BASE+27*3600}).status,'unavailable');
 assert.equal(trendSignal({product:'BTC-USD',candles:bars.filter((_,i)=>i!==120),now:BASE+60}).status,'unavailable');
 assert.equal(trendSignal({product:'BTC-USD',candles:bars.slice(-100),now:BASE+60}).status,'unavailable');
 assert.equal(trendSignal({product:'SOL-USD',candles:bars,now:BASE+60}).status,'unavailable');
 assert.throws(()=>completedDaily([[BASE-DAY,1,2,1,'x',1]],BASE+60));
});
test('trend entry rests at the best bid with a native crash bracket and capped size',async()=>{
 const f=fixture(),intent=await f.enter(),body=intent.body,plan=intent.plan;
 assert.equal(intent.product,'BTC-USD','Candidates are tried in policy order');
 assert.equal(body.order_configuration.limit_limit_gtc.limit_price,'104.5','Passive limit equals the best bid');
 assert.equal(body.order_configuration.limit_limit_gtc.post_only,false);
 const close=f.trend.candles['BTC-USD'].at(-1)[4];
 assert.equal(plan.stop,S(D((close*.8).toFixed(2))),'Crash stop is 80% of the signal close');
 assert.ok(D(plan.target)>=D((close*1.59).toFixed(2)));
 assert.equal(plan.strategy,TREND_POLICY.id);assert.equal(plan.restSeconds,240);assert.equal(plan.passive,true);
 assert.ok(D(plan.reserved)<=D('5'),'The $5 hard order cap still applies');
 assert.ok(D(plan.risk)<=D('1.3195'));assert.ok(D(plan.reserved)>D('4'),'Uses most of the capped order');
 assert.equal(f.creates().length,1);
});
test('realistic 0.9% taker fees still admit trend entries and the fixed precision path',()=>{
 const input={decision:{status:'candidate',product:'ABC-USD',stop:0.0034567890123456788*.8,target:0.0034567890123456788*1.6,features:{price:0.0034567890123456788,atr:0.00012345678901234567}},
  product:{product_id:'ABC-USD',base_currency_id:'ABC',quote_currency_id:'USD',product_type:'SPOT',status:'online',base_increment:'1',price_increment:'0.0000001',quote_increment:'0.01',base_min_size:'1',base_max_size:'10000000',quote_min_size:'1',quote_max_size:'100000',trading_disabled:false,is_disabled:false,cancel_only:false,view_only:false,post_only:false,limit_only:false,auction_mode:false},
  book:{bids:[['0.0034560','100000']],asks:[['0.0034570','100000']],requestAt:999,receivedAt:1000,bookAt:999},
  cash:'18.85',equity:'18.85',exposure:'0',feeRate:'0.009',config:{allocation:'18.85',maxOrder:'5',capacityProfile:'trend',feeVerified:true,passive:true},now:1001};
 const plan=planEntry(input);assert.equal(plan.ok,true,JSON.stringify(plan));assert.equal(plan.limitPrice,'0.003456');
 input.config.passive=false;assert.notEqual(planEntry(input).hold,'Decimal exceeds 18-place precision');
});
test('flat, stale or missing trend data never enters',async()=>{
 const f=fixture();f.trend.candles['BTC-USD']=daily(i=>200-i*.3);f.trend.candles['ETH-USD']=daily(i=>200-i*.3);
 await f.tick();f.advance(61);let state=await f.tick();assert.match(state.hold,/No trend entry: BTC-USD wait, ETH-USD wait/);assert.equal(f.creates().length,0);
 const g=fixture();g.trend.fetchedAt={'BTC-USD':g.now-7201,'ETH-USD':g.now-7201};await g.tick();g.advance(61);state=await g.tick();assert.match(state.hold,/Fresh daily trend data unavailable/);
 const h=fixture();h.trend.candles={};await h.tick();h.advance(61);state=await h.tick();assert.match(state.hold,/Fresh daily trend data unavailable/);assert.equal(h.creates().length,0);
});
test('preview mode evaluates both trend products without submitting',async()=>{
 const f=fixture({mode:'preview'});await f.tick();f.advance(61);const state=await f.tick();
 assert.match(state.hold,/Preview passed/);assert.equal(f.creates().length,0);assert.equal(f.calls.filter(c=>c.preview).length,2);
});
test('unfilled passive BUY rests four minutes, then cancels with a short retry cooldown',async()=>{
 const f=fixture(),intent=await f.enter();
 f.advance(60);await f.tick();assert.equal(f.calls.filter(c=>c.cancel).length,0,'A resting bid is not cancelled after 30 seconds');
 f.advance(181);await f.tick();assert.deepEqual(f.calls.find(c=>c.cancel).cancel,[intent.orderId]);
 await f.tick();const closed=f.engine.state.intents[0];assert.equal(closed.terminal,true);assert.ok(closed.closedAt);
 assert.equal(f.engine.state.cooldowns['BTC-USD'],closed.closedAt+60);assert.equal(f.engine.state.cash,'18.85');
 f.advance(61);await f.tick();f.advance(61);const state=await f.tick();assert.equal(state.intents.length,2,state.hold);
});
test('filled BTC keeps its bracket while ETH enters; trend positions ignore the legacy 72-hour hold',async()=>{
 const f=fixture(),btc=await f.enter();f.fill(btc);await f.tick();
 f.advance(61);const state=await f.tick();assert.equal(state.intents.length,2,state.hold);assert.equal(state.intents[1].product,'ETH-USD');
 f.fill(state.intents[1]);f.advance(80*3600);f.trend.fetchedAt={'BTC-USD':f.now,'ETH-USD':f.now};
 for(const product of ['BTC-USD','ETH-USD'])f.trend.candles[product]=daily(i=>60+i*.3,150,BASE+3*DAY);
 await f.tick();assert.equal(f.engine.state.intents.every(i=>i.exitReason===null),true,f.engine.state.hold);assert.equal(f.calls.filter(c=>c.cancel).length,0);
});
test('trend exit cancels the bracket, then sells only the owned quantity',async()=>{
 const f=fixture(),btc=await f.enter();f.fill(btc);await f.tick();
 f.trend.candles['BTC-USD']=exitBars();f.prices.set('BTC-USD',80);
 await f.tick();assert.equal(f.engine.state.intents[0].exitReason,'trend-exit');assert.deepEqual(f.calls.find(c=>c.cancel).cancel,[`child-${btc.orderId}`]);
 await f.tick();const sell=f.creates().at(-1);assert.equal(sell.side,'SELL');assert.equal(sell.order_configuration.sor_limit_ioc.base_size,btc.plan.quantity);
 f.fillSell(f.engine.state.intents[0].exits[0]);await f.tick();const closed=f.engine.state.intents[0];assert.ok(closed.closedAt);
 assert.equal(f.engine.state.cooldowns['BTC-USD'],Math.max(closed.closedAt+3600,(Math.floor(closed.closedAt/86400)+1)*86400+300),'Re-entry waits for the next daily bar');
});
test('switching strategies retires sellable legacy holdings and leaves dust with its native bracket',async()=>{
 for(const [allocation,retire] of [['5',true],['1.5',false]]){
  const f=fixture({config:{maxOrder:allocation}}),btc=await f.enter();f.fill(btc);await f.tick();
  const persisted=f.journal.load();delete persisted.intents[0].plan.strategy;delete persisted.intents[0].plan.restSeconds;f.journal.save(persisted,{type:'legacy_fixture'});
  f.restart();await f.tick();
  assert.equal(f.engine.state.lossLatched,false);
  assert.equal(f.engine.state.intents[0].exitReason,retire?'strategy-change':null,allocation);
  assert.equal(f.calls.some(c=>c.cancel),retire);
 }
});
test('a capped exit never leaves an unsellable remainder',async()=>{
 const f=fixture(),btc=await f.enter();f.fill(btc);await f.tick();
 const persisted=f.journal.load();delete persisted.intents[0].plan.strategy;f.journal.save(persisted,{type:'legacy_fixture'});
 f.prices.set('BTC-USD',125);f.restart();await f.tick();await f.tick();
 const sell=f.creates().at(-1),sold=D(sell.order_configuration.sor_limit_ioc.base_size),left=D(btc.plan.quantity)-sold;
 assert.ok(sold>0n&&left>0n);assert.ok(mul(left,D('125'))>=D('1.5'),'Remainder stays above 1.5x the venue minimum');
 assert.ok(mul(sold,D('125'))<=D('4.98'));
});
test('a definitive venue rejection releases its reservation only after history confirms absence',async()=>{
 const f=fixture();f.broker.createResponse={success:false,failure_reason:'UNKNOWN_FAILURE_REASON',error_response:{error:'INSUFFICIENT_FUND',message:'Insufficient balance'}};
 const intent=await f.enter();assert.equal(intent.rejection.reason,'INSUFFICIENT_FUND');assert.match(f.engine.state.hold,/Venue rejected/);
 f.advance(30);await f.tick();assert.match(f.engine.state.hold,/confirming absence/);assert.equal(f.engine.state.intents[0].terminal,false);
 f.advance(31);f.restart();await f.tick();const rejected=f.engine.state.intents[0];
 assert.equal(rejected.status,'REJECTED');assert.equal(rejected.terminal,true);assert.equal(rejected.orderId,null);assert.equal(f.engine.state.cash,'18.85');
 f.broker.createResponse=null;f.advance(61);await f.tick();f.advance(61);const state=await f.tick();
 assert.equal(state.intents.length,2,state.hold);assert.notEqual(state.intents[1].clientOrderId,intent.clientOrderId);
 f.advance(3601);f.restart();await f.tick();assert.equal(f.engine.state.manualRecovery,false,'Hourly audit of a rejected intent stays quiet');
});
test('an unspecific failure stays ambiguous, and a rejected ID that later appears is reconciled, not duplicated',async()=>{
 const f=fixture();f.broker.createResponse={success:false,failure_reason:'UNKNOWN_FAILURE_REASON'};
 const intent=await f.enter();assert.equal(intent.rejection,undefined);f.advance(120);let state=await f.tick();assert.match(state.hold,/unknown.*no retry/);
 const g=fixture();g.broker.createResponse={success:false,error_response:{error:'INSUFFICIENT_FUND'}};const second=await g.enter();
 g.orders.set('late-order',{...copy(second.body),order_id:'late-order',retail_portfolio_id:PORTFOLIO,product_type:'SPOT',status:'OPEN',settled:false,filled_size:'0',filled_value:'0',total_fees:'0',total_value_after_fees:'0'});
 g.advance(61);state=await g.tick();assert.equal(state.intents[0].orderId,'late-order');assert.notEqual(state.intents[0].status,'REJECTED');assert.equal(g.creates().length,1);
});
test('strategy and capacity configuration keep the hard order and loss limits',()=>{
 const env={MM_DATA_DIR:'/var/data/test'};
 const trend=configuration({...env,MM_STRATEGY:'trend',MM_CAPACITY_PROFILE:'trend',MM_ALLOCATION_USD:'18.85'});
 assert.equal(trend.strategy,'trend');assert.equal(trend.engine.strategy,'trend');assert.equal(trend.engine.maxOrder,'5');assert.equal(trend.engine.lossLimit,'2');
 assert.equal(configuration(env).engine.strategy,'rotation');
 assert.throws(()=>configuration({...env,MM_STRATEGY:'martingale'}));
 assert.throws(()=>new Engine({broker:{},journal:memoryJournal(),config:{expectedPortfolioId:PORTFOLIO,strategy:'grid'}}));
 assert.throws(()=>new Engine({broker:{},journal:memoryJournal(),config:{expectedPortfolioId:PORTFOLIO,maxOrder:'10.01'}}));
 assert.throws(()=>new Engine({broker:{},journal:memoryJournal(),config:{expectedPortfolioId:PORTFOLIO,lossLimit:'5.01'}}));
 const owner=configuration({...env,MM_MAX_ORDER_USD:'9.4',MM_LOSS_LIMIT_USD:'4',MM_ALLOCATION_USD:'18.85'});assert.equal(owner.engine.maxOrder,'9.4');assert.equal(owner.engine.lossLimit,'4');
 for(const bad of [{MM_MAX_ORDER_USD:'10.01'},{MM_LOSS_LIMIT_USD:'5.01'},{MM_MAX_ORDER_USD:'0.5'},{MM_LOSS_LIMIT_USD:'18.85',MM_ALLOCATION_USD:'18.85'}])assert.throws(()=>configuration({...env,MM_ALLOCATION_USD:'18.85',...bad}),String(Object.keys(bad)));
});
test('status reports public trend signals without balances or identities',()=>{
 const trend={candles:{'BTC-USD':daily(),'ETH-USD':exitBars()},fetchedAt:{'BTC-USD':BASE,'ETH-USD':BASE}};
 const engine={funded:true,intents:[{product:'ETH-USD',plan:{strategy:TREND_POLICY.id},closedAt:null,status:'FILLED'}]};
 const status=receipt(newState(BASE),{mode:'live',strategy:'trend',monthlyHosting:7.25},BASE+60,engine,trend);
 assert.equal(status.strategy,'trend');
 assert.deepEqual(status.trend.map(s=>[s.product,s.action]),[['BTC-USD','enter'],['ETH-USD','exit']]);
 assert.ok(!JSON.stringify(status.trend).match(/order|portfolio|quantity|cash/i));
 assert.equal(trendSummary(null,engine,BASE),null);
});
test('trend feed keeps prior bars on failure and ignores the in-progress day',async()=>{
 let now=BASE+3600,fail=false;const requests=[];
 const bars=[...daily(),[BASE,90,110,100,105,1]];
 const feed=new TrendFeed({clock:()=>now,fetcher:async url=>{requests.push(url);if(fail)return new Response('no',{status:500});return new Response(JSON.stringify(bars),{status:200});}});
 assert.equal(feed.refresh(),true);await feed.finish();
 const first=feed.snapshot();assert.equal(first.candles['BTC-USD'].length,150);assert.equal(first.fetchedAt['BTC-USD'],BASE+3600);
 assert.ok(requests.every(url=>url.startsWith('https://api.exchange.coinbase.com/products/')&&url.includes('granularity=86400')));
 assert.equal(feed.refresh(),false,'Fresh data is not refetched');
 now+=3600;fail=true;assert.equal(feed.refresh(),true);await feed.finish();
 assert.equal(feed.snapshot().fetchedAt['BTC-USD'],BASE+3600,'A failed refresh keeps the original fetch time');
});
test('capability discovery only reads product listings and futures balance presence',async()=>{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),calls=[];
 const responses=[{products:[{product_id:'BIP-20DEC30-CDE',display_name:'BTC PERP',status:'online',trading_disabled:false}]},{products:[]},{balance_summary:{futures_buying_power:{value:'0'}}}];
 const broker=new CoinbaseLive({keyName:'organizations/x/apiKeys/y',privateKey:privateKey.export({type:'pkcs8',format:'pem'}),portfolioId:'portfolio-1'},{clock:()=>BASE,fetcher:async(url,opts)=>{calls.push({url:new URL(url),opts});const body=responses.shift();return new Response(JSON.stringify(body),{status:200});}});
 const found=await broker.capabilities();
 assert.deepEqual(found.futures,{visible:1,tradable:1,sample:['BTC PERP']});assert.equal(found.equities.visible,0);assert.equal(found.futuresAccount,'present');
 assert.ok(calls.every(c=>c.opts.method==='GET'));
 assert.deepEqual(calls.map(c=>c.url.pathname),['/api/v3/brokerage/products','/api/v3/brokerage/products','/api/v3/brokerage/cfm/balance_summary']);
 await assert.rejects(broker.request('GET','/api/v3/brokerage/transaction_summary',undefined,{product_type:'FUTURE'}),/spot/);
 await assert.rejects(broker.request('POST','/api/v3/brokerage/cfm/sweeps',{}),/not permitted/);
});
test('review H1: generic UNKNOWN failure codes never become a retryable rejection',async()=>{
 for(const response of [
  {success:false,error_response:{error:'UNKNOWN_FAILURE_REASON',preview_failure_reason:'UNKNOWN_PREVIEW_FAILURE_REASON',new_order_failure_reason:'UNKNOWN_FAILURE_REASON'}},
  {success:false,error_response:{error:'INSUFFICIENT_FUND',new_order_failure_reason:'UNKNOWN_FAILURE_REASON'}},
  {success:false,error_response:{error:'SOME_NEW_CODE'}},
  {success:false,failure_reason:'INTERNAL_ERROR',error_response:{error:'INSUFFICIENT_FUND'}}]){
  const f=fixture();f.broker.createResponse=response;const intent=await f.enter();assert.equal(intent.rejection,undefined,JSON.stringify(response));
  f.advance(3600);await f.tick();assert.match(f.engine.state.hold,/unknown.*no retry/);assert.equal(f.creates().length,1);
 }
});
test('review M1: an ambiguous SELL response is never resent as a second exit',async()=>{
 const f=fixture(),btc=await f.enter();f.fill(btc);await f.tick();
 f.trend.candles['BTC-USD']=exitBars();f.prices.set('BTC-USD',80);await f.tick();await f.tick();
 f.broker.createResponse={success:false,error_response:{error:'INSUFFICIENT_FUND'}};
 const sells=()=>f.creates().filter(c=>c.side==='SELL').length;const before=sells();
 const persisted=f.journal.load();persisted.intents[0].exits=[];f.journal.save(persisted,{type:'exit_reset'});f.restart();
 await f.tick();assert.equal(sells(),before+1);assert.equal(f.engine.state.intents[0].exits[0].rejection,undefined);
 f.advance(3600);await f.tick();f.advance(3600);await f.tick();assert.equal(sells(),before+1,'Unknown exit outcome blocks further SELLs');
});
test('review M2: a rejected BUY that later appears at the venue latches manual recovery',async()=>{
 const f=fixture();f.broker.createResponse={success:false,error_response:{error:'INSUFFICIENT_FUND'}};const intent=await f.enter();
 f.advance(61);await f.tick();assert.equal(f.engine.state.intents[0].status,'REJECTED');
 f.orders.set('late',{...copy(intent.body),order_id:'late',retail_portfolio_id:PORTFOLIO,product_type:'SPOT',status:'FILLED',settled:true,filled_size:intent.plan.quantity,filled_value:'1',total_fees:'0',total_value_after_fees:'1'});
 f.advance(3601);f.broker.createResponse=null;await f.tick();assert.equal(f.engine.state.manualRecovery,true);assert.match(f.engine.state.hold,/later appeared/);
});
test('review M4 and L3: repeated zero-fill trend closes back off; trend profile requires trend strategy',async()=>{
 const f=fixture();f.broker.createResponse={success:false,error_response:{error:'INSUFFICIENT_FUND'}};
 const waits=[];f.trend.candles['ETH-USD']=daily(i=>200-i*.3);
 for(let i=0;i<4;i++){f.trend.fetchedAt={'BTC-USD':f.now,'ETH-USD':f.now};await f.enter();f.advance(61);await f.tick();const s=f.engine.state;waits.push(s.cooldowns['BTC-USD']-s.intents.at(-1).closedAt);f.advance(waits.at(-1)+1);}
 assert.deepEqual(waits,[60,120,240,480]);
 assert.throws(()=>configuration({MM_DATA_DIR:'/var/data/test',MM_CAPACITY_PROFILE:'trend'}),/requires MM_STRATEGY=trend/);
});
test('review M5: a filled BUY without an attached bracket latches after its grace period',async()=>{
 const f=fixture(),btc=await f.enter();f.fill(btc);const raw=f.orders.get(btc.orderId);delete raw.attached_order_id;
 await f.tick();assert.equal(f.engine.state.manualRecovery,false,'Grace period for venue attachment');
 f.advance(400);await f.tick();assert.equal(f.engine.state.manualRecovery,true);assert.match(f.engine.state.hold,/no attached native bracket/);
});
test('leftover legacy holdings do not consume trend position slots',async()=>{
 const g=fixture({config:{maxOrder:'1.5',maxPositions:1}}),first=await g.enter();g.fill(first);await g.tick();
 const legacy=g.journal.load();delete legacy.intents[0].plan.strategy;g.journal.save(legacy,{type:'legacy_fixture'});g.restart();
 await g.tick();g.advance(61);const state=await g.tick();
 assert.equal(state.intents[0].exitReason,null,'Dust keeps its bracket');assert.notEqual(state.hold,'Maximum owned positions reached');
});

test('the owner can raise the order cap and loss trigger; the journal follows within hard ceilings and never unlatches',async()=>{
 const f=fixture(),first=await f.enter();f.fill(first);await f.tick();
 assert.equal(f.engine.state.maxOrder,'5');assert.equal(f.engine.state.lossLimit,'2');
 f.restart({maxOrder:'9.4',lossLimit:'4'});await f.tick();
 assert.equal(f.engine.state.maxOrder,'9.4');assert.equal(f.engine.state.lossLimit,'4');assert.deepEqual(f.engine.state.limitsChangedFrom,{maxOrder:'5',lossLimit:'2'});
 assert.equal(f.journal.events.some(e=>e.type==='limits_change'),true);
 // A latched loss trigger stays latched after the limit changes.
 const persisted=f.journal.load();persisted.lossLatched=true;f.journal.save(persisted,{type:'latch_fixture'});
 f.restart({maxOrder:'9.4',lossLimit:'5'});await f.tick();assert.equal(f.engine.state.lossLatched,true);
 // Changing the allocation is still refused rather than migrated.
 assert.throws(()=>f.restart({allocation:'19',maxOrder:'9.4',lossLimit:'5'}),/Invalid execution journal/);
});
test('at the full-allocation setting each trend entry uses about half the allocation within the hard cap',async()=>{
 const f=fixture({config:{maxOrder:'9.4',lossLimit:'4'}}),btc=await f.enter();
 assert.ok(D(btc.plan.reserved)>D('8')&&D(btc.plan.reserved)<=D('9.4'),btc.plan.reserved);
 f.fill(btc);await f.tick();f.advance(61);const state=await f.tick();
 assert.equal(state.intents.length,2,state.hold);assert.ok(D(state.intents[1].plan.reserved)>D('7'),state.intents[1].plan.reserved);
 assert.ok(D(state.intents[0].plan.reserved)+D(state.intents[1].plan.reserved)<=D('18.85'));
});
