import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorCycle} from '../scripts/live/monitor.mjs';
import {D,S,mul} from '../scripts/live/risk.mjs';
const now=1789603200;
function market(product='ABC-USD',slope=.1){
 const candles=Array.from({length:100},(_,i)=>{const c=100+i*slope;return [now-(100-i)*3600,c-4,c+4,c-.05,c,1000];});
 const price=candles.at(-1)[4];return {product,status:'online',tradingDisabled:false,candles,increment:.000001,minSize:.000001,minNotional:.1,
  book:{bids:[[price-.01,100]],asks:[[price+.01,100]],receivedAt:now,requestAt:now-1}};
}
function fixture(count=1){
 const feed={markets:[market('BTC-USD',.01),...Array.from({length:count},(_,i)=>market(`COIN${i}-USD`,.1+i*.01))]},calls=[];
 const broker={portfolioId:'private-portfolio',
  async permissions(){calls.push('permissions');return {can_view:true,can_trade:false,can_transfer:false,portfolio_uuid:'private-portfolio'};},
  async fees(){calls.push('fees');return {takerRate:.001,checkedAt:now,raw:{fee_tier:{taker_fee_rate:'0.001'}}};},
  async accounts(){calls.push('accounts');return {has_next:false,cursor:'',accounts:[{uuid:'secret-account',retail_portfolio_id:'private-portfolio',currency:'USD',active:true,ready:true,available_balance:{value:'123456.789',currency:'USD'}}]};},
  async product(id){calls.push(`product:${id}`);return {product_id:id,base_currency_id:id.slice(0,-4),quote_currency_id:'USD',product_type:'SPOT',status:'online',base_increment:'0.000001',price_increment:'0.001',quote_increment:'0.01',base_min_size:'0.000001',base_max_size:'100000',quote_min_size:'0.1',quote_max_size:'100000',trading_disabled:false,is_disabled:false,cancel_only:false,view_only:false,post_only:false,limit_only:false,auction_mode:false};},
  async book(id){calls.push(`book:${id}`);const m=feed.markets.find(m=>m.product===id);return {...m.book,product:id,bookAt:now,pricebook:{product_id:id,bids:m.book.bids.map(([p,q])=>({price:String(p),size:String(q)})),asks:m.book.asks.map(([p,q])=>({price:String(p),size:String(q)}))}};},
  async preview(body){calls.push({preview:body});const o=body.order_configuration.sor_limit_ioc,quote=mul(D(o.base_size),D(o.limit_price));return {preview_id:'secret-preview',errs:[],commission_total:'0.01',order_total:S(quote+D('0.01')),quote_size:S(quote),base_size:o.base_size};},
  async create(){assert.fail('Monitor must never create orders');},async cancel(){assert.fail('Monitor must never cancel orders');},async convert(){assert.fail('Monitor must never convert balances');},
 };return {feed,broker,calls};
}
test('without credentials publishes market coverage and explicitly unverified monitoring',async()=>{
 const {feed}=fixture();const result=await monitorCycle({feed,now});
 assert.equal(result.mode,'preview-only');assert.equal(result.realEnabled,false);assert.equal(result.status,'market_monitoring');assert.equal(result.credentialStatus,'needs_credentials');assert.equal(result.feeStatus,'modeled-unverified');assert.equal(result.coverage.ready,2);assert.equal(result.coverage.selected,2);assert.equal(result.generatedAt,now);assert.ok(result.candidates.length);assert.match(result.note,/not real-money/);
});
test('view-only credential permits capped previews with an attached bracket and publishes no private data',async()=>{
 const {feed,broker,calls}=fixture();const result=await monitorCycle({feed,broker,now});
 assert.equal(result.credentialStatus,'view_verified');assert.equal(result.feeStatus,'account_verified');assert.ok(result.coverage.previewed>0,JSON.stringify(result));assert.ok(result.candidates.some(c=>c.status==='preview_passed'),JSON.stringify(result));
 const output=JSON.stringify(result);for(const secret of ['private-portfolio','secret-account','secret-preview','123456.789'])assert.ok(!output.includes(secret));
 for(const {preview} of calls.filter(c=>typeof c==='object')){assert.equal(preview.client_order_id,undefined);assert.equal(preview.preview_id,undefined);assert.equal(preview.side,'BUY');assert.ok(preview.attached_order_configuration.trigger_bracket_gtc);assert.equal(preview.attached_order_configuration.trigger_bracket_gtc.base_size,undefined);assert.ok(mul(D(preview.order_configuration.sor_limit_ioc.base_size),D(preview.order_configuration.sor_limit_ioc.limit_price))<D('4'));}
 assert.ok(calls.indexOf('permissions')<calls.indexOf('accounts'));
});
test('never examines more than three top rotation candidates',async()=>{
 const {feed,broker,calls}=fixture(6);const result=await monitorCycle({feed,broker,now});
 assert.equal(result.candidates.length,3);assert.ok(calls.filter(c=>typeof c==='string'&&c.startsWith('product:')).length<=3);assert.ok(result.coverage.previewed<=3);
});
test('permissions and portfolio mismatches stop before account access',async()=>{
 for(const kind of ['view','portfolio']){const {feed,broker,calls}=fixture();broker.permissions=async()=>({can_view:kind!=='view',portfolio_uuid:kind==='portfolio'?'unexpected':'private-portfolio'});const r=await monitorCycle({feed,broker,now});assert.equal(r.status,'held');assert.ok(!calls.includes('accounts'));}
});
test('malformed, foreign or incomplete accounts cannot fund previews',async()=>{
 for(const patch of [a=>a.has_next=true,a=>a.accounts[0].retail_portfolio_id='other',a=>a.accounts[0].available_balance.value='NaN',a=>a.accounts[0].available_balance.currency='BTC',a=>a.accounts.push({...a.accounts[0]}),a=>a.accounts[0].ready=false]){
  const {feed,broker,calls}=fixture(),base=broker.accounts;broker.accounts=async()=>{const a=await base();patch(a);return a;};const r=await monitorCycle({feed,broker,now});assert.equal(r.status,'held');assert.equal(calls.some(c=>typeof c==='object'),false);
 }
});
test('BTC assets never become USD funding or trigger conversion',async()=>{
 const {feed,broker,calls}=fixture();broker.accounts=async()=>({has_next:false,accounts:[{uuid:'bitcoin',retail_portfolio_id:'private-portfolio',currency:'BTC',available_balance:{value:'100',currency:'BTC'}}]});
 const r=await monitorCycle({feed,broker,now});assert.equal(r.status,'held');assert.match(r.hold,/never converted/);assert.equal(calls.some(c=>typeof c==='object'),false);
});
test('stale fees and changed authenticated books hold without a preview',async()=>{
 for(const kind of ['fees','book']){const {feed,broker,calls}=fixture();if(kind==='fees')broker.fees=async()=>({takerRate:.001,checkedAt:now-16});else{const base=broker.book;broker.book=async id=>({...await base(id),bookAt:now-16});}const r=await monitorCycle({feed,broker,now});assert.equal(calls.some(c=>typeof c==='object'),false);assert.ok(r.status==='held'||r.candidates.every(c=>c.status==='held'));}
});
test('broker failure text and rejected preview identities never leak',async()=>{
 for(const fail of ['fees','preview']){const {feed,broker}=fixture();broker[fail]=async()=>{throw Error('PRIVATE-KEY secret-account SECRET-BALANCE');};const r=await monitorCycle({feed,broker,now});assert.ok(!JSON.stringify(r).includes('PRIVATE-KEY'));assert.ok(!JSON.stringify(r).includes('SECRET-BALANCE'));}
});
test('invalid feed and malformed future clocks produce explicit safe holds',async()=>{
 for(const args of [{feed:null,now},{feed:{markets:[]},now:NaN},{feed:{markets:[null]},now}]){const r=await monitorCycle(args);assert.equal(r.status,'held');}
});
test('small server clock skew passes while excessive future books cannot preview',async()=>{
 for(const skew of [2,6]){const {feed,broker}=fixture(),base=broker.book;broker.book=async id=>({...await base(id),bookAt:now+skew});
  const result=await monitorCycle({feed,broker,now,allocation:'18.85'});
  assert.equal(result.coverage.previewed>0,skew===2,JSON.stringify(result));
 }
});
