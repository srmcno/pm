import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {advanceTrendBook,validateTrendBook,trendSnapshot,validTrendSnapshot,initialTrendBook,TREND_BOOK} from '../dashboard/crypto-trend-core.mjs';
import {trendPanel,trendOverview,trendActivityRows,TREND_TITLE} from '../dashboard/crypto-trend-ui.mjs';
import {collectTrendInputs} from '../scripts/crypto-trend-feed.mjs';
import {TREND_POLICY} from '../dashboard/trend-core.mjs';

// Synthetic fixtures only. These are tests, not trading-performance evidence.
const DAY=86400,T0=1790640000,now=T0+600;
const round=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
const sum=(xs,k)=>xs.reduce((n,x)=>n+(x[k]||0),0);
// Completed daily bars whose last bar closes at `end`; closes listed oldest first.
function bars(closes,end,partial=null){
  const rows=closes.map((c,i)=>{const time=end-(closes.length-i)*DAY,open=i?closes[i-1]:c;return [time,Math.min(open,c)*.99,Math.max(open,c)*1.01,open,c,1000];});
  if(partial)rows.push([end,partial.low,partial.high,closes.at(-1),partial.close,10]);
  return rows.reverse(); // Coinbase returns newest first.
}
const flat=(n=199)=>Array(n).fill(100);
const book=(price,t)=>({bids:[[round(price-.05),1000],[round(price-.1),1000]],asks:[[round(price+.05),1000],[round(price+.1),1000]],requestAt:t-1,receivedAt:t});
function inputs(t,{btc=[...flat(),110],eth=[...flat(),110],end=T0,btcPrice=110,ethPrice=110,btcPartial=null,ethPartial=null,override={}}={}){
  const row=(closes,price,partial)=>({candles:bars(closes,end,partial),candlesRequestedAt:t-3,candlesReceivedAt:t-2,candlesError:null,book:book(price,t),bookError:null});
  return {'BTC-USD':{...row(btc,btcPrice,btcPartial),...override['BTC-USD']},'ETH-USD':{...row(eth,ethPrice,ethPartial),...override['ETH-USD']}};
}
function assertLedger(s){
  const a=s.account,all=[...a.positions,...a.trades];
  assert.ok(Math.abs(a.cash-(1000-sum(all,'cost')+sum(a.trades,'proceeds')))<1e-4,'cash identity');
  assert.ok(Math.abs(a.equity-(a.cash+sum(a.positions,'markValue')))<1e-4,'equity identity');
  assert.ok(Math.abs(a.realizedPnl-sum(a.trades,'pnl'))<1e-4,'realized identity');
  assert.ok(Math.abs(a.fees-(sum(all,'entryFees')+sum(a.trades,'exitFees')))<1e-4,'fee identity');
  assert.doesNotThrow(()=>validateTrendBook(s));
}
const entered=()=>advanceTrendBook(null,inputs(now),now);

test('policy mirrors the worker rules and keeps real execution locked',()=>{
  const s=initialTrendBook(now);
  assert.equal(s.mode,'paper');assert.equal(s.realEnabled,false);assert.equal(s.initialCapital,1000);assert.equal(s.policyId,TREND_POLICY.id);
  assert.deepEqual(TREND_POLICY.products,['BTC-USD','ETH-USD']);
  assert.equal(TREND_BOOK.allocation,.49);assert.equal(TREND_BOOK.makerRate,.005);assert.equal(TREND_BOOK.takerRate,.009);assert.equal(TREND_BOOK.slippageRate,.001);assert.equal(TREND_BOOK.stopFillFraction,.95);
});

test('entry buys 49% of equity per coin at the best bid as maker and keeps source times',()=>{
  const input=inputs(now),s=advanceTrendBook(null,input,now);
  assert.equal(s.startedAt,now);assert.equal(s.account.positions.length,2);assert.equal(s.account.trades.length,0);
  const btc=s.account.positions.find(p=>p.product==='BTC-USD');
  assert.equal(btc.entryPrice,109.95);assert.equal(btc.entryLiquidity,'maker');assert.equal(btc.entrySlippage,0);
  assert.equal(btc.quantity,Math.floor(490/(109.95*1.005)*1e8)/1e8);
  assert.equal(btc.entryFees,round(btc.principal*.005));assert.ok(btc.cost<=490&&btc.cost>489.99);
  assert.equal(btc.stop,round(110*.8));assert.equal(btc.target,round(110*1.6));
  assert.equal(btc.signalId,`${TREND_POLICY.id}:BTC-USD:${T0-DAY}`);
  // Both entries size from the same pre-entry equity, so together they stay under 100%.
  assert.ok(s.account.cash>15&&s.account.cash<21);
  const signal=s.signals[0];
  assert.equal(signal.action,'enter');assert.equal(signal.fetchedAt,input['BTC-USD'].candlesReceivedAt);assert.equal(signal.barTime,T0-DAY);assert.equal(signal.barClosedAt,T0);
  assert.ok(signal.close>signal.upper&&signal.upper>signal.sma&&signal.sma>signal.lower);
  assert.equal(s.sources['BTC-USD'].book.receivedAt,now);assert.equal(s.sources['BTC-USD'].candles.fetchedAt,now-2);
  // Equity is marked at liquidation value after taker exit costs.
  assert.ok(s.account.equity<1000);assertLedger(s);
});

test('same-start BTC buy-and-hold benchmark uses the same entry and exit costs',()=>{
  const s=entered(),b=s.benchmark;
  assert.equal(b.startedAt,s.startedAt);assert.equal(b.entryPrice,109.95);
  assert.equal(b.quantity,Math.floor(1000/(109.95*1.005)*1e8)/1e8);
  assert.ok(Math.abs(b.cash-(1000-b.cost))<1e-6);
  const principal=round(b.quantity*109.95),expected=round(b.cash+principal-round(principal*.009)-round(principal*.001));
  assert.ok(Math.abs(b.equity-expected)<1e-5);
});

test('holding across later cycles never duplicates entries, and repeated ticks are idempotent',()=>{
  const s=entered(),before=structuredClone(s);
  const s2=advanceTrendBook(s,inputs(now+300,{btcPrice:111}),now+300);
  assert.deepEqual(s,before,'input state is not mutated');
  assert.equal(s2.account.positions.length,2);assert.equal(s2.account.trades.length,0);assert.equal(s2.account.cash,s.account.cash);
  assert.equal(s2.signals[0].action,'hold');assert.equal(s2.decisions.find(d=>d.product==='BTC-USD').status,'holding');
  assert.ok(s2.account.positions[0].markValue>s.account.positions[0].markValue);
  assert.deepEqual(advanceTrendBook(s2,inputs(now+300),now+300),s2);
  assert.deepEqual(advanceTrendBook(s2,inputs(now+600),now+200),s2);
  let t=s2;for(let i=2;i<12;i++)t=advanceTrendBook(t,inputs(now+300*i),now+300*i);
  assert.equal(t.account.positions.length,2);assert.equal(new Set(t.account.positions.map(p=>p.product)).size,2);assertLedger(t);
});

test('a completed close below the lower band exits by walking bids with taker fee and slippage',()=>{
  const s=entered(),next=T0+DAY+600;
  const s2=advanceTrendBook(s,inputs(next,{btc:[...flat(198),110,90],eth:[...flat(198),110,111],end:T0+DAY,btcPrice:90,ethPrice:111}),next);
  assert.equal(s2.account.positions.length,1);assert.equal(s2.account.trades.length,1);
  const t=s2.account.trades[0],q=t.quantity;
  assert.equal(t.product,'BTC-USD');assert.equal(t.exitLiquidity,'taker');assert.match(t.exitReason,/Trend exit/);
  assert.equal(t.exitPrincipal,round(q*89.95));assert.equal(t.exitFees,round(t.exitPrincipal*.009));assert.equal(t.exitSlippage,round(t.exitPrincipal*.001));
  assert.equal(t.proceeds,round(t.exitPrincipal-t.exitFees-t.exitSlippage));assert.equal(t.pnl,round(t.proceeds-t.cost));assert.ok(t.pnl<0);
  assert.equal(t.exitEvidence.kind,'trend');assert.equal(t.exitEvidence.barTime,T0);
  assert.equal(s2.signals.find(x=>x.product==='ETH-USD').action,'hold');
  assertLedger(s2);
});

test('the modeled native stop fills no better than 95% of the trigger, from daily lows or the book',()=>{
  const s=entered(),q=s.account.positions[0].quantity,stop=round(110*.8);
  // Daily low of the in-progress bar crosses the stop; the book has recovered.
  const low=advanceTrendBook(s,inputs(now+300,{btcPartial:{low:85,high:111,close:100},btcPrice:100}),now+300);
  const t=low.account.trades[0];
  assert.equal(t.exitEvidence.source,'daily low');assert.equal(t.exitEvidence.barTime,T0);assert.equal(t.exitPrice,stop*.95);
  assert.equal(t.exitPrincipal,round(q*stop*.95));assert.equal(t.exitFees,round(t.exitPrincipal*.009));assert.match(t.exitReason,/native stop/);
  assertLedger(low);
  // A book gapping through the stop limit uses the worse observed bids.
  const gap=advanceTrendBook(s,inputs(now+300,{btcPrice:70}),now+300).account.trades[0];
  assert.equal(gap.exitEvidence.source,'order book');assert.equal(gap.exitPrincipal,round(q*69.95));
  // A native stop needs no fresh book: it rests at the exchange.
  const blind=advanceTrendBook(s,inputs(now+300,{btcPartial:{low:80,high:111,close:100},override:{'BTC-USD':{book:null,bookError:'HTTP 503'}}}),now+300);
  assert.equal(blind.account.trades[0].exitPrice,stop*.95);assertLedger(blind);
  // No re-entry on the bar that produced the stopped-out entry.
  const after=advanceTrendBook(low,inputs(now+600),now+600);
  assert.equal(after.account.positions.filter(p=>p.product==='BTC-USD').length,0);assert.equal(after.account.trades.length,1);
  assert.match(after.decisions.find(d=>d.product==='BTC-USD').reason,/already used|no new completed daily bar/);
  // A new bar that closed after the exit may enter again.
  const nextDay=T0+DAY+600,again=advanceTrendBook(after,inputs(nextDay,{btc:[...flat(198),110,112],eth:[...flat(198),110,111],end:T0+DAY,btcPrice:112}),nextDay);
  assert.equal(again.account.positions.filter(p=>p.product==='BTC-USD').length,1);assertLedger(again);
});

test('take-profit counts only highs from bars that began after the entry',()=>{
  const s=entered(),target=round(110*1.6);
  const same=advanceTrendBook(s,inputs(now+300,{btcPartial:{low:109,high:180,close:111},btcPrice:111}),now+300);
  assert.equal(same.account.trades.length,0,'the entry-day bar began before the entry');
  const next=T0+DAY+600,later=advanceTrendBook(same,inputs(next,{btc:[...flat(198),110,150],eth:[...flat(198),110,111],end:T0+DAY,btcPartial:{low:149,high:180,close:170},btcPrice:170}),next);
  const t=later.account.trades[0];
  assert.equal(t.exitEvidence.kind,'target');assert.equal(t.exitPrice,target);assert.equal(t.exitFees,round(round(t.quantity*target)*.009));assert.ok(t.pnl>0);
  assertLedger(later);
});

test('a stop wins when stop and target evidence appear together',()=>{
  const s=entered(),next=T0+DAY+600;
  const r=advanceTrendBook(s,inputs(next,{btc:[...flat(198),110,120],eth:[...flat(198),110,111],end:T0+DAY,btcPartial:{low:80,high:190,close:120},btcPrice:120}),next);
  assert.equal(r.account.trades[0].exitEvidence.kind,'stop');
});

test('source errors keep the newer good reading with its original times and never trade on it',()=>{
  const s=entered(),t=now+300;
  const r=advanceTrendBook(s,inputs(t,{btcPrice:70,override:{'BTC-USD':{candles:null,candlesError:'Public market data HTTP 503'},'ETH-USD':{book:null,bookError:'Public market data HTTP 502'}}}),t);
  const btc=r.signals.find(x=>x.product==='BTC-USD');
  assert.equal(btc.retained,true);assert.equal(btc.fetchedAt,s.signals[0].fetchedAt);assert.equal(btc.evaluatedAt,now);assert.equal(btc.error,'Public market data HTTP 503');
  assert.equal(r.sources['BTC-USD'].candles.status,'error');assert.equal(r.sources['BTC-USD'].candles.fetchedAt,s.sources['BTC-USD'].candles.fetchedAt);
  assert.equal(r.sources['ETH-USD'].book.status,'error');assert.equal(r.sources['ETH-USD'].book.receivedAt,now,'last good book time kept');
  const eth=r.account.positions.find(p=>p.product==='ETH-USD');
  assert.equal(eth.markComplete,false);assert.equal(eth.markValue,s.account.positions.find(p=>p.product==='ETH-USD').markValue);assert.equal(r.account.markComplete,false);
  assert.deepEqual(r.errors.map(e=>`${e.product}:${e.stage}`).sort(),['BTC-USD:candles','ETH-USD:book']);
  // The BTC book at 70 is still observed: the native stop is a book fact, not a signal.
  assert.equal(r.account.trades.length,1);assert.equal(r.account.trades[0].exitEvidence.source,'order book');
  assertLedger(r);
  // Starting flat with a failed read enters nothing on that product.
  const fresh=advanceTrendBook(null,inputs(now,{override:{'BTC-USD':{candles:null,candlesError:'timeout'}}}),now);
  assert.deepEqual(fresh.account.positions.map(p=>p.product),['ETH-USD']);
  assert.equal(fresh.signals[0].status,'unavailable');assert.equal(fresh.signals[0].retained,false);
  // A stale latest bar is refused rather than traded.
  const stale=advanceTrendBook(null,inputs(now+3*DAY),now+3*DAY);
  assert.equal(stale.account.positions.length,0);assert.match(stale.signals[0].error,/stale/);
});

test('entries wait while an open position lacks a fresh mark',()=>{
  const base=advanceTrendBook(null,inputs(now,{override:{'BTC-USD':{candles:null,candlesError:'timeout'}}}),now);
  const r=advanceTrendBook(base,inputs(now+300,{override:{'ETH-USD':{book:null,bookError:'HTTP 500'}}}),now+300);
  assert.equal(r.account.positions.length,1);assert.match(r.decisions.find(d=>d.product==='BTC-USD').reason,/fresh mark/);
});

test('invalid or incompatible state is refused rather than reset',()=>{
  const s=entered();
  assert.throws(()=>advanceTrendBook({...s,account:{...s.account,cash:s.account.cash+1}},inputs(now+300),now+300),/refusing to reset/);
  assert.throws(()=>advanceTrendBook({...s,policyId:'other'},inputs(now+300),now+300),/migration/);
  assert.throws(()=>advanceTrendBook({...s,realEnabled:true},inputs(now+300),now+300),/refusing to reset/);
  const dup=structuredClone(s);dup.account.positions.push({...dup.account.positions[0],id:'x'});
  assert.throws(()=>validateTrendBook(dup),/refusing to reset/);
});

test('bounded equity history keeps hourly and daily points',()=>{
  let s=entered();for(let i=1;i<=30;i++)s=advanceTrendBook(s,inputs(now+i*300),now+i*300);
  assert.equal(s.cycles.length,31);assert.equal(s.curve.length,3);assert.equal(s.daily.length,1);assert.equal(s.daily[0].at,now+9000);
  assert.ok(s.curve.every(p=>Number.isFinite(p.benchmark)));
});

test('snapshots are validated and never look newer than their evaluation or live',()=>{
  const s=entered(),snap=trendSnapshot(s,{generatedAt:now,requests:4});
  assert.equal(validTrendSnapshot(snap,now),true);assert.equal(snap.execution.realEnabled,false);assert.equal(snap.execution.liveWorkerResultsPublished,false);
  assert.equal(validTrendSnapshot({...snap,generatedAt:now+3600},now),false);
  assert.equal(validTrendSnapshot({...snap,realEnabled:true},now),false);
  assert.throws(()=>trendSnapshot(s,{generatedAt:now-1}));
});

test('public collection is GET-only, reads history before books and reports failures explicitly',async()=>{
  let time=now;const calls=[];
  const ok=await collectTrendInputs({pace:0,clock:()=>time++,fetcher:async(url,options)=>{calls.push({url,options});
    return {ok:true,json:async()=>url.includes('/book')?{bids:[['109.9','2',1],['109.95','1',1]],asks:[['110.05','1',1]],sequence:7}:bars([...flat(),110],T0)};}});
  assert.equal(ok.errors.length,0);assert.equal(ok.usable,2);assert.ok(calls.every(c=>c.options.method==='GET'&&!c.options.headers.Authorization));
  assert.deepEqual(calls.map(c=>c.url.includes('/candles')?'candles':'book'),['candles','candles','book','book']);
  assert.match(calls[0].url,/\/products\/BTC-USD\/candles\?granularity=86400&start=\d{4}-\d\d-\d\dT00:00:00Z&end=/);
  assert.match(calls[2].url,/\/products\/BTC-USD\/book\?level=2$/);
  const b=ok.inputs['BTC-USD'].book;assert.deepEqual(b.bids[0],[109.95,1]);assert.ok(b.receivedAt>b.requestAt);
  assert.ok(ok.inputs['BTC-USD'].candlesReceivedAt>ok.inputs['BTC-USD'].candlesRequestedAt);
  const failed=await collectTrendInputs({pace:0,fetcher:async()=>({ok:false,status:503})});
  assert.equal(failed.usable,0);assert.equal(failed.errors.length,4);assert.ok(failed.errors.every(e=>e.message==='Public market data HTTP 503'));
  const crossed=await collectTrendInputs({pace:0,fetcher:async url=>({ok:true,json:async()=>url.includes('/book')?{bids:[['111','1']],asks:[['110','1']]}:[]})});
  assert.deepEqual(crossed.errors.map(e=>e.stage),['candles','candles','book','book']);
});

test('UI shows paper-only labels, delayed data and retained readings without inventing results',()=>{
  const s=entered(),snap=trendSnapshot(s,{generatedAt:now});
  const html=trendPanel(snap,{now:now+60});
  assert.match(html,/BTC-USD/);assert.match(html,/ETH-USD/);assert.match(html,/Enter above/);assert.match(html,/Exit below/);assert.match(html,/BTC buy-and-hold/);
  assert.match(html,/not continuous quotes/);assert.doesNotMatch(html,/Collection delayed/);
  assert.match(trendPanel(snap,{now:now+3600}),/Collection delayed/);
  const retained=trendSnapshot(advanceTrendBook(s,inputs(now+300,{override:{'BTC-USD':{candles:null,candlesError:'HTTP 503'}}}),now+300),{generatedAt:now+300});
  assert.match(trendPanel(retained,{now:now+360}),/Retained/);
  const line=trendOverview(snap,{now:now+60});
  assert.match(line,/private Coinbase worker/);assert.match(line,/Paper mirror only/);assert.match(line,/100-day SMA/);
  const missing=trendPanel(undefined,{error:'HTTP 404'});assert.match(missing,/not published yet/);assert.doesNotMatch(missing,/\$[\d,]+\.\d\d/,'no invented balances');
  assert.deepEqual(trendActivityRows(snap).map(r=>[r.account,r.state]),[['trend-mirror','open'],['trend-mirror','open']]);
  assert.equal(TREND_TITLE,'Live bot strategy: BTC/ETH daily trend (paper mirror)');
});

test('pages disclose the paper mirror, private live results and the labeled historical study',async()=>{
  const crypto=await readFile(new URL('../dashboard/crypto.html',import.meta.url),'utf8');
  for(const text of [TREND_TITLE,'id="trend-mirror"','Historical study, not live results','+118%','−36%','+99%','−53%','70–95%','results are private and are not shown'])assert.ok(crypto.includes(text),text);
  const focus=await readFile(new URL('../dashboard/focus.html',import.meta.url),'utf8');
  assert.ok(focus.includes(TREND_TITLE));assert.ok(focus.includes('id="trend-summary"'));assert.ok(focus.includes('href="crypto.html#trend"'));
});

test('build publishes the browser modules and the workflow keeps the mirror separate',async()=>{
  const build=await readFile(new URL('../scripts/build-site.mjs',import.meta.url),'utf8');
  for(const file of ['trend-core.mjs','crypto-trend-core.mjs','crypto-trend-ui.mjs'])assert.ok(build.includes(`'${file}'`),file);
  assert.ok(build.includes("'crypto-trend'"));
  const workflow=await readFile(new URL('../.github/workflows/opportunities.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes('node scripts/collect-crypto-trend.mjs'));assert.ok(workflow.includes('data/crypto-trend/state.json'));assert.ok(workflow.includes('dashboard/data/crypto-trend.json'));
  const collector=await readFile(new URL('../scripts/collect-crypto-trend.mjs',import.meta.url),'utf8');
  assert.ok(!collector.includes('crypto-strategies/state.json'));assert.ok(!/scripts\/live|POST|Authorization/.test(collector));
});
