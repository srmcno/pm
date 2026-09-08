import test from 'node:test';
import assert from 'node:assert/strict';
import {ageSeconds, candles, ema, atr, quoteUsable, positionPlan, analyzeMarket, evaluateToken, advancePaper} from '../dashboard/market-core.mjs';
const now = 1701000000;
function market() {
  const rows = Array.from({length:90},(_,i)=> {const c=100+i*0.3;return [now-(90-i)*3600-30,c-1,c+1,c-.1,c,1000];});
  const last = rows.at(-1);last[4]+=2;last[2]=last[4]+.1;last[5]=2200;
  return {product:'BTC-USD',status:'online',candles:rows,quote:{bid:last[4]-.01,ask:last[4]+.01,price:last[4],at:now}};
}
test('invalid/future timestamps and crossed books never qualify',()=>{
  assert.equal(ageSeconds(null,now),Infinity); assert.equal(ageSeconds(now+60,now),Infinity);
  assert.equal(quoteUsable({bid:2,ask:1,at:now},now),false);
  assert.equal(quoteUsable({bid:1,ask:1.001,at:now-31},now),false);
  assert.equal(quoteUsable({bid:1,ask:1.001,at:now},now),true);
});
test('candles exclude the forming period, deduplicate, and reject bad OHLC',()=>{
  const row=[now-4000,9,11,10,10,5];
  assert.equal(candles([row,row,[now,9,11,10,10,5],[now-8000,12,11,10,10,5]],now).length,1);
});
test('indicator reference values',()=>{
  assert.equal(ema([1,2,3,4,5],3),4);
  assert.equal(atr(Array.from({length:16},(_,i)=>({c:10,h:11,l:9}))),2);
});
test('sizing accounts for fees on both legs and never exceeds modeled capital',()=>{
  const p=positionPlan({entry:100,stop:95,target:115},{equity:1000,riskPct:1,feeBps:100,slippageBps:0});
  assert.ok(Math.abs(p.riskUsd-10)<1e-6);
  assert.ok(Math.abs(p.netR-(115*.99-101)/(101-95*.99))<1e-10);
  assert.ok(p.cashRequired<=250);
  assert.ok(p.breakEven>100);
});
test('fees eliminate a narrow trade, visible depth caps size',()=>{
  assert.equal(positionPlan({entry:100,stop:99,target:101},{feeBps:100}).eligible,false);
  const p=positionPlan({entry:100,stop:95,target:130,askSize:1});assert.ok(p.quantity<=.1);
  assert.equal(p.limitedBy,'visible ask depth');
});
test('NaN, negative capital, oversized risk, and inverted stops fail closed',()=>{
  for(const changes of [{equity:NaN},{equity:-10},{riskPct:10},{feeBps:-1}])assert.equal(positionPlan({entry:100,stop:90,target:150},changes).eligible,false);
  assert.equal(positionPlan({entry:100,stop:101,target:150}).eligible,false);
});
test('breakout signal uses the previous high and completed volume',()=>{
  const m=market(),s=analyzeMarket(m,{},now);
  assert.equal(s.strategy,'Volume breakout');assert.equal(s.status,'candidate');
  assert.ok(s.plan.riskUsd<=15);assert.ok(s.plan.cashRequired<=250);
  const before=s.id;m.candles.push([now,1,100000,100,99999,1e10]);
  assert.equal(analyzeMarket(m,{},now).id,before);
});
test('gaps, stale history, disabled products, and chasing suppress candidates',()=>{
  let m=market();m.candles.splice(50,1);assert.equal(analyzeMarket(m,{},now).status,'unavailable');
  m=market();assert.equal(analyzeMarket(m,{},now+8000).status,'stale');
  m=market();m.tradingDisabled=true;assert.equal(analyzeMarket(m,{},now).status,'unavailable');
  m=market();m.quote.ask+=10;m.quote.bid+=10;assert.notEqual(analyzeMarket(m,{},now).status,'candidate');
});
test('paper entry waits for a distinct scan, charges costs, and never duplicates',()=>{
  const m=market();let p=advancePaper(null,[m],now);assert.equal(p.positions.length,0);assert.equal(p.pending.length,1);
  m.quote.at=now+60;p=advancePaper(p,[m],now+60);assert.equal(p.positions.length,1);assert.ok(p.cash<1000);assert.ok(p.equity<1000);
  const cash=p.cash;p=advancePaper(p,[m],now+61);assert.equal(p.positions.length,1);assert.equal(p.cash,cash);
  const qty=p.positions[0].quantity,cost=p.positions[0].cost;
  m.quote.bid=p.positions[0].stop*.95;m.quote.ask=m.quote.bid+.01;m.quote.at=now+120;
  p=advancePaper(p,[m],now+120);assert.equal(p.positions.length,0);assert.equal(p.closed.length,1);
  assert.ok(p.closed[0].exit<p.closed[0].stop);assert.ok(Math.abs(p.closed[0].pnl-(qty*p.closed[0].exit*.994-cost))<1e-8);
});
test('stale data cannot open or close paper positions',()=>{
  const m=market();let p=advancePaper(null,[m],now);p=advancePaper(p,[m],now+60);assert.equal(p.positions.length,0);
});
test('token screening never equates reported liquidity with safety',()=>{
  const t=evaluateToken({chainId:'solana',dexId:'pumpswap',baseToken:{symbol:'TEST'},liquidity:{usd:200000},pairCreatedAt:(now-48*3600)*1000,txns:{h1:{buys:100,sells:80}},volume:{h1:10000},priceChange:{h1:0}},now);
  assert.equal(t.blocks.length,0);assert.equal(t.executionAllowed,false);assert.equal(t.checks.length,5);
});
test('missing token fields remain unknown rather than looking like measured zero',()=>{
  const t=evaluateToken({chainId:'solana',dexId:'pumpswap'},now);
  assert.equal(t.liquidity,null);assert.equal(t.change,null);assert.equal(t.buys,null);
  assert.equal(t.status,'incomplete');assert.ok(t.blocks.includes('Liquidity not reported'));
});
test('stale execution quotes do not erase a completed chart setup',()=>{
  const m=market();m.quote.at=now-100;
  const s=analyzeMarket(m,{},now);assert.equal(s.status,'stale');assert.equal(s.setup,'breakout');
  assert.equal(s.strategy,'Volume breakout');assert.equal(s.plan,undefined);
});
test('fast repeated scans preserve the original confirmation time',()=>{
  const m=market();let p=advancePaper(null,[m],now);
  m.quote.at=now+20;p=advancePaper(p,[m],now+20);assert.equal(p.pending[0].at,now);
  m.quote.at=now+35;p=advancePaper(p,[m],now+35);assert.equal(p.positions.length,1);
});
test('a loss realized at a historical stop blocks entries in that same cycle',()=>{
  const m=market(), other={...market(),product:'ETH-USD'};
  const p=advancePaper(null,[],now-1), s=analyzeMarket(other,{},now);
  Object.assign(p,{cash:0,equity:1280,peak:1280,dayStart:1280,
    positions:[{id:'old',product:'BTC-USD',quantity:10,entry:100,stop:100,target:150,
      openedAt:now-100*3600,cost:1000,entryFee:6,mark:128,markAt:now-1}],
    pending:[{id:s.id,at:now-60}]});
  const result=advancePaper(p,[m,other],now);
  assert.equal(result.positions.length,0);assert.equal(result.dailyHalt,true);assert.equal(result.drawdownHalt,true);
});
