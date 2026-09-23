import test from 'node:test';
import assert from 'node:assert/strict';
import {D,S,mul,div,floorStep,planEntry,validatePreview} from '../scripts/live/risk.mjs';
function input(){return {
  decision:{status:'candidate',product:'ABC-USD',stop:'0.9501',target:'1.3009',features:{price:'1',atr:'0.02'}},
  product:{product_id:'ABC-USD',base_currency_id:'ABC',quote_currency_id:'USD',product_type:'SPOT',status:'online',base_increment:'0.01',price_increment:'0.001',quote_increment:'0.01',base_min_size:'0.01',base_max_size:'100000',quote_min_size:'0.1',quote_max_size:'100000',trading_disabled:false,is_disabled:false,cancel_only:false,view_only:false,post_only:false,limit_only:false,auction_mode:false},
  book:{bids:[['0.999','100']],asks:[['1','100']],requestAt:999,receivedAt:1000,bookAt:999},
  cash:'20',equity:'20',exposure:'0',feeRate:'0.009',config:{allocation:'20',maxOrder:'5',feeVerified:true},now:1001,
};}
test('fixed18 parsing preserves signed exact decimals and rejects lossy input',()=>{
  assert.equal(S(D('-12.000000000000000001')),'-12.000000000000000001');
  assert.equal(S(D(1e-7)),'0.0000001');assert.equal(S(D('1e2')),'100');
  for(const n of [NaN,Infinity,'NaN','',' 1','1.0000000000000000000','1e-19',9007199254740992,null])assert.throws(()=>D(n));
  assert.equal(S(mul(D('0.1'),D('0.2'))),'0.02');assert.equal(S(div(D('1'),D('8'))),'0.125');
  assert.equal(S(floorStep(D('1.239'),D('0.01'))),'1.23');assert.throws(()=>div(D('1'),0n));assert.throws(()=>floorStep(D('-1'),D('0.1')));
});
test('entry obeys allocation, fee reserve, conservative stop risk and decimal venue steps',()=>{
  const p=planEntry(input());assert.equal(p.ok,true,JSON.stringify(p));
  assert.equal(p.limitPrice,'1.001');assert.equal(p.stop,'0.951');assert.equal(p.target,'1.3');assert.equal(p.stopLimitPrice,'0.903');
  assert.ok(D(p.reserved)<=D('4'));assert.ok(D(p.risk)<=D('0.20'));assert.ok(D(p.reward)*10n>=D(p.risk)*11n);
  assert.equal(D(p.quantity)%D('0.01'),0n);assert.ok(D(p.reserved)>D(p.principal));
  // No paper $10 floor: actual venue minimum is honored.
  assert.ok(D(p.principal)<D('5'));
});
test('hard cap, verified fee, nonnegative balance and exact venue restrictions fail closed',()=>{
  const changes=[x=>x.config.allocation='20.01',x=>x.config.maxOrder='5.01',x=>x.config.feeVerified=false,x=>x.cash='-1',x=>x.exposure='-1',x=>x.feeRate='NaN',x=>x.product.product_type='FUTURE',x=>x.product.quote_currency_id='USDC',x=>x.product.base_currency_id='WRONG',x=>x.product.cancel_only=true,x=>delete x.product.view_only,x=>x.decision.status='waiting',x=>x.decision.product='XYZ-USD'];
  for(const change of changes){const x=input();change(x);assert.ok(planEntry(x).hold,String(change));}
});
test('book freshness, stale server timestamp, crossed spread and malformed depth hold',()=>{
  const changes=[x=>x.now=1015,x=>x.book.bookAt=980,x=>x.book.receivedAt=1002,x=>x.book.asks=[['NaN','1']],x=>x.book.bids=[['1.01','1']],x=>x.book.bids=[['0.98','1']],x=>x.book.asks=[]];
  for(const change of changes){const x=input();change(x);assert.ok(planEntry(x).hold,String(change));}
});
test('bounded server clock skew preserves strict local quote freshness',()=>{
  const x=input();x.book.bookAt=x.now+2;assert.equal(planEntry(x).ok,true);
  x.book.bookAt=x.now+6;assert.ok(planEntry(x).hold);
  x.book.bookAt=x.now;x.book.receivedAt=x.now+1;assert.ok(planEntry(x).hold);
});
test('venue minimums, depth and fees never force a quantity above risk budget',()=>{
  const changes=[x=>x.product.quote_min_size='5',x=>x.product.base_min_size='10',x=>x.product.base_increment='10',x=>x.book.asks=[['1','0.001']],x=>x.book.bids=[['0.999','0.001']],x=>x.exposure='12',x=>x.cash='0.01',x=>x.decision.target='1.01',x=>x.decision.stop='1.01'];
  for(const change of changes){const x=input();change(x);assert.ok(planEntry(x).hold,String(change));}
});
test('raw decimal book is authoritative over approximate normalized numbers',()=>{
  const x=input();x.book.raw={pricebook:{bids:[{price:'0.999',size:'100'}],asks:[{price:'1',size:'100'}]}};x.book.asks=[['99','100']];assert.equal(planEntry(x).ok,true);
});
function preview(plan){return {preview_id:'preview-1',errs:[],warning:[],commission_total:plan.feeReserve,order_total:S(D(plan.principal)+D(plan.feeReserve)),quote_size:plan.principal,base_size:plan.quantity};}
test('preview verifies fees, arithmetic and exact requested quantity against reserve',()=>{
  const p=planEntry(input()),r=preview(p),result=validatePreview(p,r,'0.009',1001);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.previewId,'preview-1');assert.ok(D(result.cost)<=D(p.reserved));
  const changes=[x=>delete x.preview_id,x=>delete x.errs,x=>x.errs=['PREVIEW_INVALID'],x=>x.warning='INSUFFICIENT_LIQUIDITY',x=>x.warnings=['WARNING_WITH_EMPTY_WARNING_ARRAY'],x=>x.est_average_filled_price='1.002',x=>x.commission_total='-1',x=>x.commission_total='NaN',x=>x.commission_total='0.05',x=>x.order_total='5.01',x=>x.base_size='999',x=>x.product_id='XYZ-USD',x=>x.side='SELL',x=>x.quote_size='9'];
  for(const change of changes){const r=preview(p);change(r);assert.ok(validatePreview(p,r,'0.009').hold,String(change));}
});
test('preview refuses a forged plan beyond the hard five-dollar cap',()=>{
  const p={...planEntry(input()),reserved:'10',maxOrder:'10',quantity:'6',principal:'6.006'};
  assert.ok(validatePreview(p,{preview_id:'p',errs:[],commission_total:'0.01',order_total:'6.02',quote_size:'6.006',base_size:'6'},'0.009').hold);
});
test('expanded capacity admits entries above the old exposure ceiling while preserving risk and cash bounds',()=>{
 const x=input();x.cash='6.85';x.equity='18.85';x.exposure='12';x.config.allocation='18.85';
 assert.match(planEntry(x).hold,/exposure budget exhausted/);
 x.config.capacityProfile='expanded';const plan=planEntry(x);assert.equal(plan.ok,true,JSON.stringify(plan));
 assert.equal(plan.capacityProfile,'expanded');assert.ok(D(plan.reserved)<=D('4.965'));
 assert.ok(D(plan.reserved)<=D('5'));assert.ok(D(plan.risk)<=D('0.1885'));
 assert.ok(D(plan.reserved)+D(x.exposure)<=D('16.965'));
 x.exposure='16.965';assert.match(planEntry(x).hold,/exposure budget exhausted/);
 x.exposure='16.95';assert.ok(planEntry(x).hold,'Cannot round up to force a venue minimum');
});
test('expanded profile never relaxes per-entry loss, authenticated fees or absolute allocation limits',()=>{
 const x=input(),standard=planEntry(x);x.config.capacityProfile='expanded';const expanded=planEntry(x);
 assert.equal(expanded.risk,standard.risk,'Risk-limited entries remain the same size');
 for(const change of [v=>v.config.capacityProfile='unlimited',v=>v.config.capacityProfile=null,v=>v.config.maxOrder='5.01',v=>v.config.allocation='20.01',v=>v.config.feeVerified=false,v=>v.cash='0.01',v=>v.product.quote_min_size='10']){
  const candidate=structuredClone(x);change(candidate);assert.ok(planEntry(candidate).hold,String(change));
 }
});
test('active profile uses at most two percent modeled risk without bypassing fee, exposure or order caps',()=>{
 const x=input();x.config.allocation='18.85';x.cash='18.85';x.equity='18.85';
 x.config.capacityProfile='expanded';const expanded=planEntry(x);
 x.config.capacityProfile='active';const active=planEntry(x);
 assert.equal(active.ok,true,JSON.stringify(active));
 assert.equal(active.entryRiskFraction,'0.02');
 assert.ok(D(active.reserved)>D(expanded.reserved),'Additional risk should permit a larger entry when sizing is risk-limited');
 assert.ok(D(active.risk)<=D('0.377'));
 assert.ok(D(active.reserved)<=D('5'));
 assert.ok(D(active.reserved)<=D('5.655'));
 assert.ok(D(active.reward)*10n>=D(active.risk)*11n);
 x.exposure='16.965';assert.match(planEntry(x).hold,/exposure budget exhausted/);
 x.exposure='0';x.config.feeVerified=false;assert.match(planEntry(x).hold,/Fresh account fee verification/);
});
