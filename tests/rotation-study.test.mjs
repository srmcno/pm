import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceStudy,validateStudy} from '../scripts/rotation-study.mjs';
import {executionEstimate} from '../dashboard/execution-estimate.mjs';
import {collectCoinbaseMarkets} from '../scripts/crypto-feed.mjs';
const now=1789840800;
function market(product,i=0,time=now){const candles=Array.from({length:100},(_,n)=>{const c=100+n*.1;return [now-(100-n)*3600,c-1.1,c+1.1,c-.05,c,1000];});return {product,status:'online',candles,increment:.000001,minSize:.000001,minNotional:10,quoteVolume24h:1e6-i*1000,depthUsd:100000,spreadBps:2,book:{bids:[[109.89,1000]],asks:[[109.91,1000]],receivedAt:time,requestAt:time-1}};}
const markets=Array.from({length:100},(_,i)=>market(i===0?'BTC-USD':`C${i}-USD`,i));
test('fresh comparison starts separate equal accounts and expands only coverage',()=>{
 const s=advanceStudy(null,markets,now);assert.equal(s.realEnabled,false);assert.equal(s.accounts.control.equity,1000);assert.equal(s.accounts.expanded.equity,1000);
 assert.equal(s.coverage.control.ready,40);assert.equal(s.coverage.expanded.ready,100);assert.equal(s.accounts.control.trades.length,0);assert.equal(s.startedAt,now);
 const next=advanceStudy(s,markets.map((m,i)=>market(m.product,i,now+300)),now+300);
 assert.ok(next.accounts.control.positions.length>0);assert.ok(next.accounts.expanded.positions.length>0);
 for(const a of Object.values(next.accounts))for(const p of a.positions)assert.equal(p.entryFeeRate,.009);
 assert.equal(s.accounts.control.positions.length,0);assert.deepEqual(advanceStudy(next,markets,now+300),next);
 assert.ok(next.accounts.control.benchmark);validateStudy(next);
});
test('required study holdings survive a ranking demotion; invalid evidence cannot reset',()=>{
 let s=advanceStudy(null,markets,now);s=advanceStudy(s,markets.map((m,i)=>market(m.product,i,now+300)),now+300);
 const held=s.accounts.control.positions[0].product;
 const changed=markets.map((m,i)=>({...market(m.product,i,now+600),quoteVolume24h:m.product===held?0:1e8-i}));
 const n=advanceStudy(s,changed,now+600);assert.ok(n.coverage.control.products.includes(held));
 const bad=structuredClone(n);bad.accounts.control.cash+=1;assert.throws(()=>advanceStudy(bad,changed,now+900));
 delete bad.accounts.control;assert.throws(()=>validateStudy(bad));
});
test('missing books retain holdings and record a monitoring gap without inventing fills',()=>{
 let s=advanceStudy(null,markets,now);s=advanceStudy(s,markets.map((m,i)=>market(m.product,i,now+300)),now+300);
 const n=advanceStudy(s,[],now+1500);assert.equal(n.accounts.control.cash,s.accounts.control.cash);assert.equal(n.accounts.control.markComplete,false);assert.equal(n.accounts.control.executionAudit.gapCount,1);assert.equal(n.accounts.control.trades.length,0);
});
test('legacy fees are normalized only in a labeled same-fill sensitivity calculation',()=>{
 const a={trades:[{principal:100,entryFees:.6,proceeds:108.79,exitFees:.99,exitSlippage:.22}]};
 const copy=structuredClone(a),r=executionEstimate(a);assert.ok(Math.abs(r.gross-10)<1e-8);assert.ok(Math.abs(r.net-7.9)<1e-8);assert.equal(r.legacyFeeLegs,1);assert.deepEqual(a,copy);
 const stress=executionEstimate(a,{feeRate:.012,slippageRate:.003});assert.ok(Math.abs(stress.net-6.85)<1e-8);
});
test('expanded adapter finishes all candle work before fresh books and retains disabled holdings stale',async()=>{
 const products=Array.from({length:134},(_,i)=>({id:i===0?'BTC-USD':`C${i}-USD`,base_currency:i===0?'BTC':`C${i}`,quote_currency:'USD',status:'online',base_increment:'.000001'}));
 products[133].post_only=true;const calls=[];let tick=now;
 const r=await collectCoinbaseMarkets({cached:[market('REMOVED-USD')],requiredProducts:['REMOVED-USD'],pace:0,clock:()=>tick+=.01,fetcher:async url=>{calls.push(url);return {ok:true,json:async()=>{
 if(url.endsWith('/products'))return products;if(url.endsWith('/stats'))return {volume:'1000',last:'100'};
 if(url.includes('/candles'))return market().candles;
 return {bids:[['109.89','1000']],asks:[['109.91','1000']]};}};}});
 assert.equal(r.universe.discovered,133);assert.ok(r.markets.length>=100);assert.equal(r.cache.length,130);
 assert.ok(!calls.some(u=>u.includes('/C133-USD/')));assert.ok(r.markets.find(m=>m.product==='REMOVED-USD').sourceError);
 assert.ok(calls.findIndex(u=>u.includes('/book'))>calls.findLastIndex(u=>u.includes('/candles')));
 assert.ok(r.universe.maxBookAgeSeconds<90);
});
test('an hour captured while forming must be refetched after it completes',async()=>{
 const hour=Math.floor(now/3600)*3600,prior=market('BTC-USD');prior.candlesRequestedAt=hour+10;prior.candles.push([hour,40,100,90,50,100]);let candleRequests=0;
 const r=await collectCoinbaseMarkets({cached:[prior],products:['BTC-USD'],pace:0,clock:()=>hour+3605,fetcher:async url=>({ok:true,json:async()=>{
 if(url.includes('/candles')){candleRequests++;return [...market().candles,[hour,40,125,90,120,500],[hour+3600,110,130,120,121,10]];}
 if(url.endsWith('/book?level=2'))return {bids:[['119.99','100']],asks:[['120.01','100']]};
 if(url.endsWith('/stats'))return {volume:'100',last:'120'};
 return {id:'BTC-USD',base_currency:'BTC',quote_currency:'USD',status:'online',base_increment:'.000001'};
 }})});
 assert.equal(candleRequests,1);assert.equal(r.markets[0].candles.find(b=>b[0]===hour)[4],120);assert.ok(!r.markets[0].candles.some(b=>b[0]===hour+3600));
});
test('malformed optional comparison cannot displace a valid public snapshot',async()=>{
 const {initialCompetition,validCompetitionSnapshot}=await import('../dashboard/crypto-strategies-core.mjs');
 const s={...initialCompetition(now),generatedAt:now,errors:[],rotationStudy:{accounts:{control:{}}}};
 assert.equal(validCompetitionSnapshot(s,now),false);
});
test('promotion evidence from a previous universe does not count for the expansion',async()=>{
 const {assessReadiness}=await import('../dashboard/execution-readiness.mjs');
 const a={policyStartedAt:now-86400,benchmark:{startedAt:now-40*86400,markComplete:true,equity:1000,baselineEquity:1000},trades:Array.from({length:60},()=>({openedAt:now-20*86400,closedAt:now-10*86400,pnl:2})),equity:1120,peak:1120,markComplete:true,updatedAt:now,status:'established'};
 const r=assessReadiness(a,now);assert.equal(r.days,1);assert.equal(r.trades,0);assert.equal(r.eligible,false);assert.equal(r.gates[5].pass,false);
});
