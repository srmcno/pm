import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,constants} from 'node:crypto';
import {KalshiLive,signKalshi,parseKalshiKey,validateOrderBody,API_ROOT} from '../scripts/predlive/kalshi.mjs';
import {PolymarketUSReadOnly,parsePolymarketSecret,signPolymarket,POLYMARKET_SUBMIT_SUPPORTED} from '../scripts/predlive/polymarket.mjs';

const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const RSA_PEM=rsa.privateKey.export({type:'pkcs1',format:'pem'});
const ed=generateKeyPairSync('ed25519');
const ED_PEM=ed.privateKey.export({type:'pkcs8',format:'pem'});
const KEY_ID='a952bcbe-ec3b-4b5b-b8f9-11dae589608c';
function json(body,status=200){return {ok:status>=200&&status<300,status,headers:new Map(),text:async()=>JSON.stringify(body)};}
const order=(extra={})=>({ticker:'KXTEST-26-A',client_order_id:'8c35ecb3-328f-4f52-8c7c-0f4b9862f8d1',side:'bid',count:'3',price:'0.4200',time_in_force:'fill_or_kill',
  self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:false,cancel_order_on_pause:true,...extra});

test('Kalshi RSA-PSS and Ed25519 signatures verify against locally generated keys',()=>{
  const path=`${API_ROOT}/portfolio/orders`,ts=1703123456789;
  const message=Buffer.from(`${ts}POST${path}`);
  const rsaSig=signKalshi(parseKalshiKey(RSA_PEM),ts,'POST',path);
  assert.equal(verify('sha256',message,{key:rsa.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(rsaSig,'base64')),true);
  // PSS is randomized; a second signature differs but also verifies.
  assert.notEqual(signKalshi(parseKalshiKey(RSA_PEM),ts,'POST',path),rsaSig);
  const edSig=signKalshi(parseKalshiKey(ED_PEM),ts,'POST',path);
  assert.equal(verify(null,message,ed.publicKey,Buffer.from(edSig,'base64')),true);
  // Escaped newlines from a hosting dashboard parse; query strings are never signed.
  assert.ok(parseKalshiKey(RSA_PEM.replace(/\n/g,'\\n')));
  assert.throws(()=>signKalshi(parseKalshiKey(RSA_PEM),ts,'GET',`${path}?limit=5`));
  assert.throws(()=>parseKalshiKey('not a key'.padEnd(80,'x')),/could not be parsed/);
  const small=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'});
  assert.throws(()=>parseKalshiKey(small),/2048/);
});

test('Kalshi requests sign the path without query and send documented headers; public reads carry no credentials',async()=>{
  const seen=[];
  const k=new KalshiLive({keyId:KEY_ID,privateKey:RSA_PEM,allowSubmit:true},{clock:()=>1700000000.123,fetcher:async(url,init)=>{seen.push({url,init});
    if(url.includes('/portfolio/orders?'))return json({orders:[],cursor:''});
    if(url.includes('/markets/orderbooks'))return json({orderbooks:[{ticker:'KXTEST-26-A',orderbook_fp:{yes_dollars:[],no_dollars:[]}}]});
    return json({order_id:'o-1',client_order_id:order().client_order_id,fill_count:'3.00',remaining_count:'0.00',ts_ms:1});}});
  await k.ordersFor('KXTEST-26-A',100);
  const signed=seen[0];
  assert.equal(new URL(signed.url).origin,'https://external-api.kalshi.com');
  assert.equal(signed.init.headers['KALSHI-ACCESS-KEY'],KEY_ID);assert.equal(signed.init.headers['KALSHI-ACCESS-TIMESTAMP'],'1700000000123');
  const msg=Buffer.from(`1700000000123GET${API_ROOT}/portfolio/orders`);
  assert.equal(verify('sha256',msg,{key:rsa.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(signed.init.headers['KALSHI-ACCESS-SIGNATURE'],'base64')),true);
  assert.equal(signed.init.redirect,'error');
  await k.orderbooks(['KXTEST-26-A']);
  assert.equal(seen[1].init.headers['KALSHI-ACCESS-KEY'],undefined,'public data is unsigned');
  await k.create(order());
  const post=seen[2];assert.equal(post.init.method,'POST');assert.ok(post.url.endsWith('/trade-api/v2/portfolio/events/orders'));
  assert.deepEqual(JSON.parse(post.init.body),order());
});

test('Kalshi route and order allowlist: immediate-only buys, no cancel, transfer or resting order paths',async()=>{
  assert.ok(validateOrderBody(order()));assert.ok(validateOrderBody(order({side:'ask',time_in_force:'immediate_or_cancel',reduce_only:true})));
  for(const bad of [order({time_in_force:'good_till_canceled'}),order({post_only:true}),order({count:'0'}),order({count:'1.5'}),order({price:'1.00'}),order({price:'0.12345'}),
    order({reduce_only:true}),order({side:'buy'}),order({expiration_time:1}),order({buy_max_cost:100}),order({subaccount:1}),order({self_trade_prevention_type:'maker'}),order({cancel_order_on_pause:false})])
    assert.throws(()=>validateOrderBody(bad));
  let calls=0;const k=new KalshiLive({keyId:KEY_ID,privateKey:ED_PEM,allowSubmit:true},{fetcher:async()=>{calls++;return json({});}});
  // Private methods only reach allowlisted routes; there is no cancel/transfer API surface at all.
  for(const name of ['cancel','transfer','amend','withdraw','request'])assert.equal(typeof k[name],'undefined');
  await assert.rejects(k.create(order({time_in_force:'good_till_canceled'})));
  await assert.rejects(k.order('../balance'));await assert.rejects(k.market('KX/../../x'));
  assert.equal(calls,0);
  const preview=new KalshiLive({keyId:KEY_ID,privateKey:ED_PEM},{fetcher:async()=>{calls++;return json({});}});
  await assert.rejects(preview.create(order()),/disabled/);assert.equal(calls,0);
  const anon=new KalshiLive({},{fetcher:async()=>{calls++;return json({});}});
  await assert.rejects(anon.balance(),/credentials are not configured/);assert.equal(calls,0);
  assert.throws(()=>new KalshiLive({allowSubmit:true}),/credentials/);
  assert.throws(()=>new KalshiLive({keyId:KEY_ID}),/together/);
});

test('Kalshi errors never echo credentials, bodies or upstream messages; responses are size bounded',async()=>{
  const secretBody=`{"error":"${KEY_ID} ${RSA_PEM.slice(40,80)}"}`;
  const failing=new KalshiLive({keyId:KEY_ID,privateKey:RSA_PEM,allowSubmit:true},{fetcher:async()=>{throw Error(`socket ${KEY_ID} ${RSA_PEM}`);}});
  const e1=await failing.create(order()).catch(e=>e);assert.match(e1.message,/outcome unknown/);
  const e2=await failing.balance().catch(e=>e);
  const http=new KalshiLive({keyId:KEY_ID,privateKey:RSA_PEM},{fetcher:async()=>({ok:false,status:401,headers:new Map(),body:{cancel:async()=>{}},text:async()=>secretBody})});
  const e3=await http.balance().catch(e=>e);assert.equal(e3.message,'Kalshi returned HTTP 401.');
  const big=new KalshiLive({keyId:KEY_ID,privateKey:RSA_PEM},{maxBytes:1024,fetcher:async()=>json({x:'y'.repeat(5000)})});
  const e4=await big.balance().catch(e=>e);assert.match(e4.message,/size limit/);
  const invalid=new KalshiLive({keyId:KEY_ID,privateKey:RSA_PEM},{fetcher:async()=>({ok:true,status:200,headers:new Map(),text:async()=>secretBody.slice(0,20)})});
  const e5=await invalid.balance().catch(e=>e);
  for(const e of [e1,e2,e3,e4,e5]){assert.ok(!e.message.includes(KEY_ID));assert.ok(!e.message.includes('PRIVATE'));assert.ok(!e.message.includes('socket'));}
  const hang=new KalshiLive({},{timeoutMs:100,fetcher:(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  const keepAlive=setInterval(()=>{},20);// the adapter's own timer is unref'd
  try{await assert.rejects(hang.market('KXTEST-26-A'),/failed or timed out/);}finally{clearInterval(keepAlive);}
});

test('Kalshi reconciliation reads paginate by cursor and reject identity mismatches',async()=>{
  const pages=[{orders:[{order_id:'a'}],cursor:'c1'},{orders:[{order_id:'b'}],cursor:''}];let i=0;
  const k=new KalshiLive({keyId:KEY_ID,privateKey:ED_PEM},{fetcher:async url=>{if(url.includes('fills'))return json({fills:[{fill_id:'f',order_id:'other'}],cursor:''});return json(pages[i++]);}});
  assert.deepEqual((await k.ordersFor('KXTEST-26-A',0)).map(o=>o.order_id),['a','b']);
  await assert.rejects(k.fills('mine'),/identity mismatch/);
  const loop=new KalshiLive({keyId:KEY_ID,privateKey:ED_PEM},{fetcher:async()=>json({orders:[],cursor:'same'})});
  await assert.rejects(loop.ordersFor('KXTEST-26-A',0),/did not advance/);
});

test('Polymarket US: Ed25519 read-only signing, and order submission is unavailable by design',async()=>{
  const seed=Buffer.alloc(64,7),secret=seed.toString('base64');
  const key=parsePolymarketSecret(secret);
  const sig=signPolymarket(key,1700000000000,'GET','/v1/portfolio/positions');
  const pub=key.asymmetricKeyType==='ed25519'?(await import('node:crypto')).createPublicKey(key):null;
  assert.equal(verify(null,Buffer.from('1700000000000GET/v1/portfolio/positions'),pub,Buffer.from(sig,'base64')),true);
  const seen=[];const p=new PolymarketUSReadOnly({keyId:'pmkey-12345678',secretKey:secret},{clock:()=>1700000000,fetcher:async(url,init)=>{seen.push({url,init});return json({positions:{}});}});
  await p.positions();assert.equal(seen[0].init.headers['X-PM-Access-Key'],'pmkey-12345678');assert.equal(seen[0].init.headers['X-PM-Timestamp'],'1700000000000');
  assert.equal(new URL(seen[0].url).origin,'https://api.polymarket.us');
  assert.equal(POLYMARKET_SUBMIT_SUPPORTED,false);assert.equal(p.canSubmit,false);assert.equal(p.allowSubmit,false);
  await assert.rejects(p.create({}),/no client order ID/);assert.equal(seen.length,1);
  assert.throws(()=>signPolymarket(key,1,'POST','/v1/orders'));
  await assert.rejects(p.book('../account/balances'));
});
