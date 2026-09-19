import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {CoinbaseLive,normalizeFees,validateOrderBody} from '../scripts/live/coinbase.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const credentials={keyName:'organizations/fixture/apiKeys/fixture',privateKey:privateKey.export({type:'pkcs8',format:'pem'}),portfolioId:'portfolio-1'};
const BASE='/api/v3/brokerage',NOW=1_800_000_000;
const permissions={can_view:true,can_trade:true,can_transfer:false,portfolio_uuid:'portfolio-1'};
const product={product_id:'BTC-USD',product_type:'SPOT',base_currency_id:'BTC',quote_currency_id:'USD',status:'online',is_disabled:false,trading_disabled:false,cancel_only:false,view_only:false,auction_mode:false,limit_only:false,post_only:false};
const buy=()=>({client_order_id:'intent-1',product_id:'BTC-USD',side:'BUY',order_configuration:{sor_limit_ioc:{base_size:'0.00005',limit_price:'80000'}},attached_order_configuration:{trigger_bracket_gtc:{limit_price:'88000',stop_trigger_price:'76000'}}});
const order=id=>({order_id:id,retail_portfolio_id:'portfolio-1',product_id:'BTC-USD',product_type:'SPOT'});
const fill=(id='fill-1',oid='order-1')=>({entry_id:id,order_id:oid,retail_portfolio_id:'portfolio-1',product_id:'BTC-USD',price:'80000',size:'0.00005',commission:'0.024',size_in_quote:false});
const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
function fixture(responses,{config={},...options}={}){
 const calls=[];
 const broker=new CoinbaseLive({...credentials,...config},{clock:()=>NOW,...options,fetcher:async(url,opts)=>{
  calls.push({url:new URL(url),opts});
  assert.ok(responses.length,'Unexpected extra broker request');
  const response=responses.shift();
  return typeof response==='function'?response(url,opts):json(response);
 }});
 return {broker,calls};
}

test('signed requests bind exact method and path, with documented query separation',async()=>{
 const {broker,calls}=fixture([product]);
 assert.deepEqual(await broker.product('BTC-USD'),product);
 assert.equal(calls[0].url.href,'https://api.coinbase.com/api/v3/brokerage/products/BTC-USD?get_tradability_status=true');
 const {opts}=calls[0];assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');assert.equal(opts.method,'GET');
 const [h,p,s]=opts.headers.Authorization.slice(7).split('.'),claims=JSON.parse(Buffer.from(p,'base64url'));
 assert.equal(claims.uri,'GET api.coinbase.com/api/v3/brokerage/products/BTC-USD');
 assert.equal(claims.nbf,NOW);assert.equal(claims.exp,NOW+120);
 assert.ok(verify('sha256',Buffer.from(`${h}.${p}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')));
 assert.deepEqual(Object.keys(broker),[],'Credentials must not be enumerable');
});

test('accounts and spot order history exhaust pages without dropping prior rows',async()=>{
 const account=id=>({uuid:id,retail_portfolio_id:'portfolio-1',currency:'USD'});
 const {broker,calls}=fixture([
  {accounts:[account('a')],has_next:true,cursor:'next&raw'},
  {accounts:[account('b')],has_next:false,cursor:''},
  {orders:[order('o1')],has_next:true,cursor:'second'},
  {orders:[order('o2')],has_next:false,cursor:''},
 ]);
 assert.deepEqual((await broker.accounts()).accounts.map(a=>a.uuid),['a','b']);
 assert.equal(calls[1].url.searchParams.get('cursor'),'next&raw');
 assert.equal(calls[1].url.searchParams.get('limit'),'100');
 const result=await broker.orders({product:'BTC-USD'});
 assert.deepEqual(result.orders.map(o=>o.order_id),['o1','o2']);assert.equal(result.has_next,false);
 assert.equal(calls[2].url.searchParams.get('product_type'),'SPOT');
 assert.equal(calls[2].url.searchParams.get('product_ids'),'BTC-USD');
});

test('fill history follows cursors through an empty terminal page and deduplicates by entry_id',async()=>{
 const {broker,calls}=fixture([{fills:[fill()],cursor:'next'},{fills:[fill(),fill('fill-2')],cursor:'last'},{fills:[],cursor:''}]);
 assert.deepEqual((await broker.fills('order-1')).fills.map(f=>f.entry_id),['fill-1','fill-2']);
 assert.equal(calls.length,3);assert.equal(calls[0].url.searchParams.get('order_ids'),'order-1');
});

test('pagination fails closed on missing continuation, repeated cursors, bounds and unstable rows',async()=>{
 for(const pages of [
  [{accounts:[]}],
  [{accounts:[],has_next:true}],
  [{accounts:[],has_next:true,cursor:'same'},{accounts:[],has_next:true,cursor:'same'}],
  [{accounts:[],has_next:true,cursor:'a'},{accounts:[],has_next:true,cursor:'b'}],
 ]){
  const {broker}=fixture(pages,{maxPages:2});await assert.rejects(broker.accounts(),/pagination/);
 }
 const {broker}=fixture([{orders:[order('o1')],has_next:true,cursor:'a'},{orders:[{...order('o1'),status:'FILLED'}],has_next:false}]);
 await assert.rejects(broker.orders(),/changed during pagination/);
 const wrong=fixture([{fills:[fill('f','other-order')],cursor:''}]);await assert.rejects(wrong.broker.fills('order-1'),/different order/);
 const badCursor=fixture([{fills:[],cursor:null}]);await assert.rejects(badCursor.broker.fills('order-1'),/cursor/);
});

test('portfolio and complete permission checks reject inconsistent broker data',async()=>{
 for(const raw of [{...permissions,portfolio_uuid:'another'}, {...permissions,can_view:undefined}]){
  const {broker}=fixture([raw]);await assert.rejects(broker.permissions(),/portfolio|permissions/);
 }
 const {broker}=fixture([{accounts:[{uuid:'a',retail_portfolio_id:'other'}],has_next:false}]);
 await assert.rejects(broker.accounts(),/unexpected portfolio/);
 const missing=fixture([{orders:[{order_id:'o1'}],has_next:false}]);await assert.rejects(missing.broker.orders(),/portfolio/);
 const challenge=fixture([{proof_token_required:true,accounts:[],has_next:false}]);await assert.rejects(challenge.broker.accounts(),/additional authentication/);
});

test('fees require real finite maker and taker rates and request the spot fee tier',async()=>{
 const raw={fee_tier:{maker_fee_rate:'0',taker_fee_rate:'0.006'}};
 const {broker,calls}=fixture([raw]);const fees=await broker.fees();
 assert.equal(fees.makerRate,0);assert.equal(fees.takerRate,.006);assert.equal(fees.checkedAt,NOW);assert.deepEqual(fees.raw,raw);
 assert.equal(calls[0].url.searchParams.get('product_type'),'SPOT');
 for(const value of [null,undefined,'',false,'garbage','-0.01','0.1','Infinity'])assert.throws(()=>normalizeFees({fee_tier:{maker_fee_rate:'0.001',taker_fee_rate:value}}),/unavailable or invalid/);
});

test('book preserves raw decimals, sorts levels and reports server and receipt times',async()=>{
 const raw={pricebook:{product_id:'BTC-USD',time:new Date((NOW-1)*1000).toISOString(),bids:[{price:'79999',size:'0.100000000000000001'},{price:'80000',size:'1'}],asks:[{price:'80002',size:'2'},{price:'80001',size:'3'}]}};
 const {broker}=fixture([raw]);const book=await broker.book('BTC-USD');
 assert.deepEqual(book.bids,[[80000,1],[79999,.1]]);assert.equal(book.ask,80001);assert.equal(book.bid,80000);
 assert.deepEqual(book.pricebook,raw.pricebook);assert.equal(book.requestAt,NOW);assert.equal(book.receivedAt,NOW);assert.equal(book.bookAt,NOW-1);
});

test('books reject stale, future, crossed, wrong-product and malformed levels',async()=>{
 const normal={product_id:'BTC-USD',time:new Date(NOW*1000).toISOString(),bids:[{price:'100',size:'1'}],asks:[{price:'101',size:'1'}]};
 for(const patch of [{time:new Date((NOW-31)*1000).toISOString()},{time:new Date((NOW+6)*1000).toISOString()},{time:'invalid'}, {product_id:'ETH-USD'}, {asks:[{price:'99',size:'1'}]}, {bids:[]}, {asks:[{price:'101',size:'NaN'}]}]){
  const {broker}=fixture([{pricebook:{...normal,...patch}}]);await assert.rejects(broker.book('BTC-USD'),/book/);
 }
});

test('no endpoint, query, or order body can smuggle transfers or derivatives',async()=>{
 const {broker,calls}=fixture([],{config:{allowSubmit:true}});
 for(const path of [`${BASE}/portfolios/move_funds`,`${BASE}/orders/../transfers`,'https://attacker.invalid/x',`${BASE}/cfm/orders`])await assert.rejects(broker.request('POST',path,{}),/not permitted/);
 await assert.rejects(broker.request('GET',`${BASE}/transaction_summary`,undefined,{product_type:'FUTURE'}),/spot/);
 for(const id of ['BTC-USDC','BTC-PERP','BTC-USD?x=1','../accounts','BTC/USD','BTC-USD/..'])await assert.rejects(broker.product(id),/USD spot/);
 for(const patch of [{leverage:'2'},{margin_type:'CROSS'},{retail_portfolio_id:'other'},{side:'SHORT'},{product_id:'BTC-PERP'}])await assert.rejects(broker.create({...buy(),...patch}));
 await assert.rejects(broker.create({...buy(),order_configuration:{market_market_ioc:{quote_size:'4',leverage:'2'}}}));
 assert.equal(calls.length,0);
});

test('submission and cancellation are disarmed by default even through request()',async()=>{
 const {broker,calls}=fixture([]);
 await assert.rejects(broker.create(buy()),/disabled/);
 await assert.rejects(broker.cancel(['order-1']),/disabled/);
 await assert.rejects(broker.request('POST',`${BASE}/orders`,buy()),/disabled/);
 await assert.rejects(broker.request('POST',`${BASE}/orders/batch_cancel`,{order_ids:['order-1']}),/disabled/);
 assert.equal(calls.length,0);
});

test('strict order sizes and attached brackets accept only supported unleveraged shapes',()=>{
 const body=buy();assert.equal(validateOrderBody(body,{create:true}),body);
 for(const size of ['0','-1','1e2',1,Infinity,'NaN','01',''])assert.throws(()=>validateOrderBody({...buy(),order_configuration:{market_market_ioc:{quote_size:size}}}),/positive/);
 for(const configuration of [
  {market_market_ioc:{base_size:'1',quote_size:'1'}},
  {market_market_ioc:{}},
  {limit_limit_gtc:{base_size:'1',limit_price:'0'}},
  {market_market_fok:{base_size:'1'}},
 ])assert.throws(()=>validateOrderBody({...buy(),order_configuration:configuration}));
 assert.throws(()=>validateOrderBody({...buy(),side:'SELL',order_configuration:{market_market_ioc:{quote_size:'1'}}}),/base quantity/);
 assert.throws(()=>validateOrderBody({...buy(),client_order_id:undefined},{create:true}),/identifier/);
 assert.throws(()=>validateOrderBody({...buy(),attached_order_configuration:{trigger_bracket_gtc:{base_size:'1',limit_price:'100',stop_trigger_price:'90'}}}),/Unsupported/);
 assert.throws(()=>validateOrderBody({...buy(),attached_order_configuration:{trigger_bracket_gtc:{limit_price:'100',stop_trigger_price:'101'}}}),/bracket/);
 const sell={client_order_id:'exit-1',product_id:'BTC-USD',side:'SELL',order_configuration:{trigger_bracket_gtc:{base_size:'0.00005',limit_price:'88000',stop_trigger_price:'76000'}}};
 assert.equal(validateOrderBody(sell,{create:true}),sell);
});

test('preview and armed create recheck account-specific product tradability and send exact immutable order shape',async()=>{
 const preview={preview_id:'preview-1',errs:[],order_total:'4',commission_total:'.024'};
 const created={success:true,success_response:{order_id:'order-1',client_order_id:'intent-1'}};
 const {broker,calls}=fixture([product,preview,permissions,product,created],{config:{allowSubmit:true}});
 assert.deepEqual(await broker.preview(buy()),preview);
 assert.deepEqual(await broker.create({...buy(),preview_id:'preview-1'}),created);
 const post=calls.filter(c=>c.opts.method==='POST');assert.equal(post.length,2);
 assert.deepEqual(JSON.parse(post[1].opts.body),{...buy(),preview_id:'preview-1'});
 for(const call of post){const claims=JSON.parse(Buffer.from(call.opts.headers.Authorization.split('.')[1],'base64url'));assert.equal(claims.uri,`POST api.coinbase.com${call.url.pathname}`);}
});

test('armed create rejects unavailable products, mismatched instruments and insufficient permissions before POST',async()=>{
 for(const patch of [{view_only:true},{trading_disabled:true},{is_disabled:undefined},{status:'offline'},{post_only:true},{product_type:'FUTURE'},{quote_currency_id:'USDC'},{product_id:'ETH-USD'}]){
  const {broker,calls}=fixture([permissions,{...product,...patch}],{config:{allowSubmit:true}});
  await assert.rejects(broker.create(buy()),/tradable|post-only|USD spot/);assert.ok(calls.every(c=>c.opts.method==='GET'));
 }
 const {broker,calls}=fixture([{...permissions,can_trade:false}],{config:{allowSubmit:true}});await assert.rejects(broker.create(buy()),/permission/);assert.equal(calls.length,1);
 const noPortfolio=fixture([],{config:{allowSubmit:true,portfolioId:undefined}});await assert.rejects(noPortfolio.broker.create(buy()),/configured portfolio/);
});

test('cancellation verifies identity and portfolio for every ID and copies input before awaits',async()=>{
 const ids=['order-1'];const {broker,calls}=fixture([()=>{ids.push('unverified');return json({order:order('order-1')});},{results:[{success:true,order_id:'order-1'}]}],{config:{allowSubmit:true}});
 await broker.cancel(ids);assert.deepEqual(JSON.parse(calls[1].opts.body),{order_ids:['order-1']});
 assert.equal(calls[1].url.pathname,`${BASE}/orders/batch_cancel`);
 for(const patch of [{retail_portfolio_id:'other'},{order_id:'other'},{product_type:'FUTURE'},{product_id:'BTC-PERP'}]){
  const bad=fixture([{order:{...order('order-1'),...patch}}],{config:{allowSubmit:true}});await assert.rejects(bad.broker.cancel(['order-1']));assert.equal(bad.calls.length,1);
 }
});

test('oversized, invalid, redirected and failed responses never expose response bodies or credentials',async()=>{
 const secret='sensitive-response-token';
 for(const response of [()=>new Response(secret,{status:401}),()=>new Response(`{"data":"${secret.repeat(50)}"}`),()=>new Response(secret),()=>Promise.reject(Error(secret))]){
  const {broker}=fixture([response],{maxBytes:128});await assert.rejects(broker.permissions(),error=>!error.message.includes(secret)&&!error.message.includes(credentials.keyName));
 }
 const signing=new CoinbaseLive({...credentials,privateKey:secret},{fetcher:()=>assert.fail('invalid key must not fetch')});
 await assert.rejects(signing.permissions(),error=>error.message==='Coinbase signing configuration is invalid.');
 const {broker}=fixture([product,()=>Promise.reject(Error(secret))]);await assert.rejects(broker.preview(buy()),/outcome unknown/);
});

test('a timed-out transport fails closed and passes an abort signal',async()=>{
 const keepAlive=setTimeout(()=>{},1000);
 try{
  const {broker}=fixture([(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('transport secret')),{once:true}))],{timeoutMs:5});
  await assert.rejects(broker.permissions(),/failed or timed out/);
 }finally{clearTimeout(keepAlive);}
});
