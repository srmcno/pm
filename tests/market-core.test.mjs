import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_VERSION,ageSeconds, candles, ema, atr, quoteUsable, positionPlan, analyzeMarket, evaluateToken, advancePaper} from '../dashboard/market-core.mjs';
const now = 1701000000;
function market() {
  const rows = Array.from({length:90},(_,i)=> {const c=100+i*0.3;return [now-(90-i)*3600-30,c-1,c+1,c-.1,c,1000];});
  const trigger = rows.at(-2);trigger[4]+=2;trigger[2]=trigger[4]+.1;trigger[5]=2200;
  const last=rows.at(-1);last.splice(1,5,127.8,128.7,128.45,128.6,1000);
  return {product:'BTC-USD',status:'online',candles:rows,quote:{bid:last[4]-.01,ask:last[4]+.01,price:last[4],at:now}};
}
function reclaimMarket(){
  const m=market();
  m.candles.at(-3).splice(1,5,122,126.2,126,122.8,1000);
  m.candles.at(-2).splice(1,5,122.7,124.7,122.9,124.6,1300);
  m.candles.at(-1).splice(1,5,123.4,125.1,124.7,125,1000);
  m.quote={bid:124.99,ask:125.01,price:125,at:now};return m;
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
test('breakout uses trigger volume followed by a separate completed-hour confirmation',()=>{
  const m=market(),s=analyzeMarket(m,{},now);
  assert.equal(s.strategy,'Volume breakout');assert.equal(s.status,'candidate');
  assert.equal(s.relativeVolume,2.2);assert.equal(s.confirmationAt-s.triggerAt,3600);
  assert.equal(s.trigger,Math.max(...m.candles.slice(-22,-2).map(r=>r[2])));
  assert.ok(s.plan.riskUsd<=15);assert.ok(s.plan.cashRequired<=250);
  const before=s.id;m.candles.push([now,1,100000,100,99999,1e10]);
  assert.equal(analyzeMarket(m,{},now).id,before);
});
test('neither repeated scans nor a forming confirmation candle can complete an hourly trigger',()=>{
  for(const create of [market,reclaimMarket]){
    const m=create(),confirmationEnd=m.candles.at(-1)[0]+3600;
    const early=confirmationEnd-60;m.quote.at=early;
    assert.notEqual(analyzeMarket(m,{},early).status,'candidate');
    let p=advancePaper(null,[m],early);m.quote.at=early+30;
    p=advancePaper(p,[m],early+30);assert.equal(p.positions.length,0);assert.equal(p.pending.length,0);
    m.quote.at=confirmationEnd;
    assert.equal(analyzeMarket(m,{},confirmationEnd).status,'candidate');
  }
});
test('reclaim confirmation must close stronger and preserve the trigger low',()=>{
  const m=reclaimMarket(),s=analyzeMarket(m,{},now);
  assert.equal(s.setup,'reclaim');assert.equal(s.status,'candidate');assert.equal(s.relativeVolume,1.3);
  const failedLow=structuredClone(m);failedLow.candles.at(-1)[1]=m.candles.at(-2)[1]-.01;
  assert.notEqual(analyzeMarket(failedLow,{},now).status,'candidate');
  for(const create of [market,reclaimMarket]){
    const weak=create();weak.candles.at(-1)[4]=weak.candles.at(-2)[4];
    assert.notEqual(analyzeMarket(weak,{},now).status,'candidate');
    const lowVolume=create();lowVolume.candles.at(-2)[5]=1000;lowVolume.candles.at(-1)[5]=100000;
    assert.notEqual(analyzeMarket(lowVolume,{},now).status,'candidate');
  }
});
test('relative EMA ordering cannot substitute for either required rising slope',()=>{
  const cases=[
    {tail:[120,120,123,123.5],declining:20},
    {tail:[110,110,110,110,110,115,128,128.5],declining:50}
  ];
  for(const {tail,declining} of cases){
    const closes=Array.from({length:90},(_,i)=>100+i*.3);closes.splice(-tail.length,tail.length,...tail);
    const t=closes.slice(0,-1),m=market();
    m.candles=closes.map((c,i)=>[now-(90-i)*3600-30,c-1,c+1,c-.1,c,i===88?1500:1000]);
    m.quote={bid:closes.at(-1)-.01,ask:closes.at(-1)+.01,at:now};
    assert.ok(ema(t,20)>ema(t,50));assert.ok(t.at(-1)>ema(t,50));
    const rising20=ema(t,20)>ema(t.slice(0,-3),20),rising50=ema(t,50)>ema(t.slice(0,-6),50);
    assert.equal(rising20,declining!==20);assert.equal(rising50,declining!==50);
    const s=analyzeMarket(m,{},now);assert.equal(s.risingTrend,false);assert.notEqual(s.status,'candidate');
  }
});
test('live bid must support the completed setup and stops stay anchored to the trigger',()=>{
  for(const create of [market,reclaimMarket]){
    const m=create(),s=analyzeMarket(m,{},now),trigger=m.candles.at(-2);
    const historicalAtr=atr(candles(m.candles.slice(0,-1),now));
    const stop=Math.min(trigger[4]-2*historicalAtr,trigger[1]-.1*historicalAtr);
    assert.equal(s.stop,stop);assert.equal(s.target,trigger[4]+3*(trigger[4]-stop));
    const level=s.setup==='breakout'?s.trigger:s.ema20;
    m.quote={bid:level-.01,ask:level+.01,at:now};
    const lost=analyzeMarket(m,{},now);assert.notEqual(lost.status,'candidate');
    assert.match(lost.reasons[0],/current bid has lost/);
    const chased=create();chased.quote={bid:trigger[4]+historicalAtr,ask:trigger[4]+historicalAtr+.01,at:now};
    assert.match(analyzeMarket(chased,{},now).reasons[0],/do not chase/);
  }
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
test('legacy pending signals cannot confirm a revised model entry',()=>{
  const m=market(),s=analyzeMarket(m,{},now),p=advancePaper(null,[],now-60);
  const legacyId=`${m.product}:${m.candles.at(-2)[0]}:breakout`;
  p.pending=[{id:legacyId,at:now-60}];
  const next=advancePaper(p,[m],now);
  assert.equal(next.positions.length,0);assert.equal(next.pending[0].id,s.id);
  assert.ok(s.id.startsWith(MODEL_VERSION+':'));assert.equal(next.pending[0].at,now);
  assert.equal(p.pending[0].id,legacyId);
  m.quote.at=now+60;const opened=advancePaper(next,[m],now+60);
  assert.equal(opened.positions.length,1);assert.equal(opened.positions[0].modelVersion,MODEL_VERSION);
});
test('legacy positions retain original stops, targets and 48-hour exits with unchanged costs',()=>{
  for(const [bid,heldHours,reason] of [[94,1,'Stop / adverse gap'],[115,1,'Target observed'],[100,48,'48-hour time exit']]){
    const p=advancePaper(null,[],now-72*3600),m=market();
    Object.assign(p,{cash:899.4,equity:998.8,positions:[{id:'legacy-v2',product:'BTC-USD',strategy:'Volume breakout',
      quantity:1,entry:100,stop:95,target:115,openedAt:now-heldHours*3600,cost:100.6,entryFee:.6,mark:100,markAt:now-60}]});
    const before=structuredClone(p);m.quote={bid,ask:bid+.01,at:now};
    const next=advancePaper(p,[m],now,{strategies:[]});
    assert.deepEqual(p,before);assert.equal(next.positions.length,0);assert.equal(next.closed.length,1);
    const closed=next.closed[0];assert.equal(closed.id,'legacy-v2');assert.equal(closed.reason,reason);
    assert.equal(closed.stop,95);assert.equal(closed.target,115);assert.equal(closed.openedAt,before.positions[0].openedAt);
    assert.equal(closed.exit,bid*.999);assert.ok(Math.abs(closed.pnl-(bid*.999*.994-100.6))<1e-9);
    assert.ok(Math.abs(next.cash-(899.4+bid*.999*.994))<1e-9);
  }
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
