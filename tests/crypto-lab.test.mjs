import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {advanceLab,validateLab,labSnapshot,validLabSnapshot,initialLab,labSignal,supertrendSeries,supertrend,donchianLevels,smaLevels,labBars,
  LAB_BOOK,LAB_DEFS,LAB_PRODUCTS,LAB_POLICY_ID} from '../dashboard/crypto-lab-core.mjs';
import {labPanel,labReturns,LAB_LABEL,LAB_TITLE} from '../dashboard/crypto-lab-ui.mjs';
import {collectLabInputs,candleWindows} from '../scripts/crypto-lab-feed.mjs';
import {runLab,labPaths} from '../scripts/collect-crypto-lab.mjs';
import {trendSignal,TREND_POLICY} from '../dashboard/trend-core.mjs';

// Synthetic fixtures only. These are tests, not trading-performance evidence.
const DAY=86400,T0=1790640000,now=T0+600;
const round=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
const sum=(xs,k)=>xs.reduce((n,x)=>n+(x[k]||0),0);
const flat=(n,v=100)=>Array(n).fill(v);
// Completed daily bars whose last bar closes at `end`; closes listed oldest first.
function bars(closes,end,partial=null){
  const rows=closes.map((c,i)=>{const time=end-(closes.length-i)*DAY,open=i?closes[i-1]:c;return [time,Math.min(open,c)*.99,Math.max(open,c)*1.01,open,c,1000];});
  if(partial)rows.push([end,partial.low,partial.high,closes.at(-1),partial.close,10]);
  return rows.reverse(); // Coinbase returns newest first.
}
const book=(price,t)=>({bids:[[round(price-.05),1000],[round(price-.1),1000]],asks:[[round(price+.05),1000],[round(price+.1),1000]],requestAt:t-1,receivedAt:t});
const up=[...flat(449),110],quiet=flat(450);
function inputs(t,{btc=up,eth=up,sol=quiet,end=T0,prices={},override={}}={}){
  const row=(closes,price)=>({candles:bars(closes,end),candlesRequestedAt:t-3,candlesReceivedAt:t-2,candlesError:null,book:book(price,t),bookError:null});
  const out={'BTC-USD':row(btc,prices.btc??110),'ETH-USD':row(eth,prices.eth??110),'SOL-USD':row(sol,prices.sol??100)};
  for(const [k,v] of Object.entries(override))out[k]={...out[k],...v};
  return out;
}
const byId=(s,id)=>s.books.find(b=>b.id===id);
function assertLedger(s){
  for(const b of s.books){
    const a=b.account,all=[...a.positions,...a.trades];
    assert.ok(Math.abs(a.cash-(1000-sum(all,'cost')+sum(a.trades,'proceeds')))<1e-4,`${b.id} cash identity`);
    assert.ok(Math.abs(a.equity-(a.cash+sum(a.positions,'markValue')))<1e-4,`${b.id} equity identity`);
    assert.ok(Math.abs(a.realizedPnl-sum(a.trades,'pnl'))<1e-4,`${b.id} realized identity`);
    assert.ok(Math.abs(a.fees-(sum(all,'entryFees')+sum(a.trades,'exitFees')))<1e-4,`${b.id} fee identity`);
  }
  assert.doesNotThrow(()=>validateLab(s));
}
const started=()=>advanceLab(null,inputs(now),now);
const held=(s,id)=>byId(s,id).account.positions.map(p=>p.product);

test('lab defines five isolated $1,000 paper books over BTC, ETH and SOL and keeps real execution locked',()=>{
  const s=initialLab(now);
  assert.deepEqual(LAB_PRODUCTS,['BTC-USD','ETH-USD','SOL-USD']);
  assert.deepEqual(LAB_DEFS.map(d=>d.id),['sma200-5','donchian-100-50','supertrend-10-3','sma100-2','hold-3']);
  assert.equal(s.mode,'paper');assert.equal(s.realEnabled,false);assert.equal(s.policyId,LAB_POLICY_ID);assert.equal(s.updatedAt,0);
  assert.ok(s.books.every(b=>b.account.cash===1000&&b.account.equity===1000&&b.account.positions.length===0&&b.account.trades.length===0&&b.startedAt===now&&b.signalId===b.id));
  assert.equal(LAB_BOOK.makerRate,.005);assert.equal(LAB_BOOK.takerRate,.009);assert.equal(LAB_BOOK.slippageRate,.001);assert.equal(LAB_BOOK.allocation,1/3);
  assert.notEqual(LAB_POLICY_ID,TREND_POLICY.id,'the lab has its own policy id, separate from the live rule');
});

test('SMA books enter above the upper band, hold inside it and exit below the lower band',()=>{
  const sig=(id,closes,heldNow)=>labSignal({bookId:id,product:'BTC-USD',candles:bars(closes,T0),held:heldNow,now});
  // SMA200 of 199x100 + 110 = 100.05; bands are 5%.
  const a=sig('sma200-5',up,false);
  assert.equal(a.status,'ready');assert.equal(a.action,'enter');assert.equal(a.state,'long');
  assert.ok(Math.abs(a.indicator-100.05)<1e-9);assert.ok(Math.abs(a.enterLevel-100.05*1.05)<1e-9);assert.ok(Math.abs(a.exitLevel-100.05*.95)<1e-9);
  assert.equal(a.barTime,T0-DAY);assert.equal(a.barClosedAt,T0);assert.equal(a.signalId,`${LAB_POLICY_ID}:sma200-5:BTC-USD:${T0-DAY}`);
  assert.equal(sig('sma200-5',[...flat(449),104],false).action,'wait','+4% is inside the entry band');
  assert.equal(sig('sma200-5',[...flat(449),104],true).action,'hold');
  assert.equal(sig('sma200-5',[...flat(449),96],true).action,'hold','-4% is inside the exit band');
  assert.equal(sig('sma200-5',[...flat(449),94],true).action,'exit');
  assert.equal(sig('sma200-5',[...flat(449),94],false).action,'wait');
  // The control uses the live rule's 100-day average and 2% band.
  const c=sig('sma100-2',[...flat(449),103],false);
  assert.equal(c.action,'enter');assert.ok(Math.abs(c.indicator-100.03)<1e-9);
  assert.equal(sig('sma100-2',[...flat(449),101],false).action,'wait');
  assert.equal(sig('sma100-2',[...flat(449),97],true).action,'exit');
});

test('the sma100-2 control matches the live worker signal on the same bars',()=>{
  for(const last of [130,110,103,101.5,100,98.5,97,90])for(const heldNow of [false,true])for(const product of ['BTC-USD','ETH-USD']){
    const candles=bars([...flat(449),last],T0),live=trendSignal({product,candles,held:heldNow,now}),lab=labSignal({bookId:'sma100-2',product,candles,held:heldNow,now});
    assert.equal(lab.action,live.action,`${last} held=${heldNow}`);assert.equal(lab.state,live.state);
    assert.equal(lab.indicator,live.sma);assert.equal(lab.enterLevel,live.upper);assert.equal(lab.exitLevel,live.lower);assert.equal(lab.barTime,live.barTime);
  }
});

test('Donchian enters above the previous 100 highs and exits below the previous 50 lows, excluding the current bar',()=>{
  const custom=Array.from({length:121},(_,i)=>({time:i*DAY,high:i,low:1000-i,open:500,close:500}));
  const lv=donchianLevels(custom,{entryDays:100,exitDays:50});
  assert.equal(lv.high,119);assert.equal(lv.low,881,'previous 50 bars are indices 70..119');
  assert.equal(donchianLevels(custom.slice(-100),{entryDays:100,exitDays:50}),null);
  const sig=(closes,heldNow)=>labSignal({bookId:'donchian-100-50',product:'ETH-USD',candles:bars(closes,T0),held:heldNow,now});
  // Flat bars have highs of 101 and lows of 99.
  const enter=sig([...flat(449),110],false);
  assert.equal(enter.action,'enter');assert.equal(enter.enterLevel,101);assert.equal(enter.exitLevel,99);assert.equal(enter.indicator,null);
  assert.equal(sig([...flat(449),101],false).action,'wait','equal to the 100-day high is not a breakout');
  assert.equal(sig([...flat(449),100],true).action,'hold');
  assert.equal(sig([...flat(449),98],true).action,'exit');
  // A breakout bar does not raise its own bar's channel.
  assert.equal(sig([...flat(448),110,111],false).action,'wait','111 does not clear the previous bar high of 111.1');
  assert.equal(sig([...flat(448),110,112],false).action,'enter');
  assert.equal(sig([...flat(448),110,112],false).enterLevel,111.1,'the previous bar high (open 100, close 110 gives 111.1) is the 100-day high');
});

test('Supertrend follows the standard band ratchet (hand-computed example)',()=>{
  const b=[[10,8,9],[11,9,10.5],[12,10,11.5],[14,11,13.5],[15,13,14],[14,9,10]].map(([high,low,close],i)=>({time:i*DAY,high,low,open:close,close}));
  const rows=supertrendSeries(b,{atrDays:2,multiplier:1});
  assert.deepEqual(rows.map(r=>r.index),[2,3,4,5]);
  const pick=r=>[r.trend,r.upper,r.lower,r.atr,r.line];
  assert.deepEqual(pick(rows[0]),['down',13,9,2,13]);
  assert.deepEqual(pick(rows[1]),['up',13,10,2.5,10]);
  assert.deepEqual(pick(rows[2]),['up',16.5,11.5,2.5,11.5]);
  assert.deepEqual(pick(rows[3]),['down',15,11.5,3.5,15]);
  assert.deepEqual(supertrend(b,{atrDays:2,multiplier:1}),rows.at(-1));
  assert.equal(supertrend(b.slice(0,2),{atrDays:2,multiplier:1}),null);
});

test('Supertrend is deterministic, ratchets while up, and ignores warm-up origin on a long series',()=>{
  let seed=7;const rand=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;
  let price=100;const series=Array.from({length:450},(_,i)=>{const open=price;price=Math.max(1,price*(1+(rand()-.5)*.08));return {time:T0-(450-i)*DAY,open,close:price,high:Math.max(open,price)*1.01,low:Math.min(open,price)*.99};});
  const full=supertrendSeries(series,{atrDays:10,multiplier:3}),again=supertrendSeries(series,{atrDays:10,multiplier:3});
  assert.deepEqual(full,again);
  for(let i=1;i<full.length;i++){
    if(full[i].trend==='up'&&full[i-1].trend==='up')assert.ok(full[i].lower>=full[i-1].lower-1e-12,'lower band never falls while the trend stays up');
    if(full[i].trend==='down'&&full[i-1].trend==='down')assert.ok(full[i].upper<=full[i-1].upper+1e-12,'upper band never rises while the trend stays down');
  }
  assert.equal(supertrend(series.slice(-300),{atrDays:10,multiplier:3}).trend,full.at(-1).trend,'a 300-bar warm-up reaches the same state as 450 bars');
  const jump=labSignal({bookId:'supertrend-10-3',product:'BTC-USD',candles:bars(up,T0),held:false,now});
  assert.equal(jump.action,'enter');assert.equal(jump.trend,'up');assert.ok(jump.indicator<jump.close&&jump.enterLevel>jump.exitLevel);
  assert.equal(labSignal({bookId:'supertrend-10-3',product:'BTC-USD',candles:bars(quiet,T0),held:false,now}).action,'wait');
  assert.equal(labSignal({bookId:'supertrend-10-3',product:'BTC-USD',candles:bars([...flat(448),110,90],T0),held:true,now}).action,'exit');
});

test('hold-3 needs no candles and buys once',()=>{
  const s=labSignal({bookId:'hold-3',product:'SOL-USD',candles:[],held:false,now});
  assert.equal(s.status,'ready');assert.equal(s.action,'enter');assert.equal(s.close,null);assert.match(s.signalId,/hold-3:SOL-USD:initial$/);
  assert.equal(labSignal({bookId:'hold-3',product:'SOL-USD',candles:bars(quiet,T0),held:true,now}).action,'hold');
  assert.equal(labSignal({bookId:'hold-3',product:'SOL-USD',candles:bars(quiet,T0),held:true,now}).close,100);
});

test('signals refuse short, gapped, stale or unknown data instead of guessing',()=>{
  const sig=(id,closes,at=now,product='BTC-USD')=>labSignal({bookId:id,product,candles:bars(closes,T0),held:false,now:at});
  assert.equal(sig('sma200-5',flat(150)).status,'unavailable');assert.match(sig('sma200-5',flat(150)).reason,/Insufficient/);
  assert.equal(sig('sma100-2',flat(150)).status,'ready');assert.equal(sig('donchian-100-50',flat(150)).status,'ready');
  assert.equal(sig('supertrend-10-3',flat(200)).status,'unavailable','warm-up needs 250 completed bars');
  assert.match(sig('sma100-2',up,T0+3*DAY).reason,/stale/);
  const gapped=bars(up,T0).filter(r=>r[0]!==T0-30*DAY);
  assert.match(labSignal({bookId:'sma100-2',product:'BTC-USD',candles:gapped,held:false,now}).reason,/gap/);
  assert.equal(sig('sma100-2',up,now,'DOGE-USD').status,'unavailable');
  assert.equal(labSignal({bookId:'nope',product:'BTC-USD',candles:bars(up,T0),now}).status,'unavailable');
  assert.throws(()=>labBars(bars(flat(150),T0),now,201),/Insufficient/);
  assert.equal(labBars(bars(up,T0),now,201).length,450,'all completed contiguous bars are returned');
  // The partial bar of the current day never feeds a signal.
  const withPartial=bars(quiet,T0,{low:1,high:500,close:400});
  assert.equal(labSignal({bookId:'sma100-2',product:'BTC-USD',candles:withPartial,held:false,now}).action,'wait');
  assert.equal(smaLevels(bars(quiet,T0).map(r=>({close:r[4]})),{days:500,band:.02}),null);
});

test('first run starts every book prospectively: initial entries in equal thirds, maker fee, same-start benchmark',()=>{
  const input=inputs(now),s=advanceLab(null,input,now);
  assert.equal(s.startedAt,now);assert.equal(s.updatedAt,now);
  for(const id of ['sma200-5','donchian-100-50','supertrend-10-3','sma100-2'])assert.deepEqual(held(s,id),['BTC-USD','ETH-USD'],id);
  assert.deepEqual(held(s,'hold-3'),['BTC-USD','ETH-USD','SOL-USD']);
  const btc=byId(s,'sma200-5').account.positions.find(p=>p.product==='BTC-USD');
  assert.equal(btc.entryPrice,109.95);assert.equal(btc.entryLiquidity,'maker');assert.equal(btc.entrySlippage,0);assert.equal(btc.entryKind,'initial');
  assert.equal(btc.quantity,Math.floor(1000/3/(109.95*1.005)*1e8)/1e8);assert.equal(btc.entryFees,round(btc.principal*.005));
  assert.ok(btc.cost<=1000/3&&btc.cost>333.3,'one third of book equity');
  assert.match(btc.entryReasons[0],/^Initial entry/);assert.equal(btc.signalId,`${LAB_POLICY_ID}:sma200-5:BTC-USD:${T0-DAY}`);
  assert.equal(btc.bookId,'sma200-5');assert.equal(btc.signalBarTime,T0-DAY);
  // Books never share cash or positions.
  assert.equal(new Set(s.books.map(b=>b.account.positions[0].id)).size,5);
  const sol=byId(s,'sma200-5').signals.find(x=>x.product==='SOL-USD');
  assert.equal(sol.action,'wait');assert.equal(sol.close,100);assert.equal(sol.fetchedAt,now-2,'original candle fetch time is kept');assert.equal(sol.barTime,T0-DAY);
  // The benchmark starts at the same moment with the same costs, and hold-3 is that benchmark.
  for(const b of s.books){assert.equal(b.benchmark.startedAt,now);assert.equal(b.benchmark.legs['SOL-USD'].entryPrice,99.95);}
  const hold=byId(s,'hold-3');
  assert.equal(hold.account.equity,hold.benchmark.equity);assert.equal(hold.account.cash,hold.benchmark.cash);
  assert.ok(byId(s,'sma200-5').account.equity<1000,'liquidation marks include exit costs');
  assert.equal(s.sources['SOL-USD'].book.receivedAt,now);assert.equal(s.sources['SOL-USD'].candles.fetchedAt,now-2);
  assertLedger(s);
});

test('repeated cycles neither duplicate entries nor mutate their input, and are idempotent',()=>{
  const s=started(),before=structuredClone(s);
  const s2=advanceLab(s,inputs(now+300,{prices:{btc:111}}),now+300);
  assert.deepEqual(s,before,'input state is not mutated');
  assert.equal(byId(s2,'sma200-5').account.positions.length,2);assert.equal(byId(s2,'sma200-5').account.trades.length,0);
  assert.equal(byId(s2,'sma200-5').signals[0].action,'hold');assert.equal(byId(s2,'sma200-5').decisions.find(d=>d.product==='BTC-USD').status,'holding');
  assert.ok(byId(s2,'sma200-5').account.positions[0].markValue>byId(s,'sma200-5').account.positions[0].markValue);
  assert.deepEqual(advanceLab(s2,inputs(now+300),now+300),s2);
  assert.deepEqual(advanceLab(s2,inputs(now+600),now+200),s2);
  let t=s2;for(let i=2;i<14;i++)t=advanceLab(t,inputs(now+300*i),now+300*i);
  for(const b of t.books)assert.equal(new Set(b.account.positions.map(p=>p.product)).size,b.account.positions.length);
  assert.equal(byId(t,'hold-3').account.positions.length,3);assert.equal(byId(t,'hold-3').account.trades.length,0);
  assertLedger(t);
});

test('a completed close below the exit level sells by walking bids with taker fee and slippage; no same-bar re-entry',()=>{
  const s=started(),next=T0+DAY+600;
  const drop=inputs(next,{btc:[...flat(448),110,90],eth:[...flat(448),110,111],end:T0+DAY,prices:{btc:90,eth:111}});
  const s2=advanceLab(s,drop,next);
  for(const id of ['sma200-5','donchian-100-50','supertrend-10-3','sma100-2']){
    const b=byId(s2,id);assert.deepEqual(b.account.positions.map(p=>p.product),['ETH-USD'],id);assert.equal(b.account.trades.length,1,id);
    const t=b.account.trades[0],q=t.quantity;
    assert.equal(t.product,'BTC-USD');assert.equal(t.exitLiquidity,'taker');assert.match(t.exitReason,/^(SMA|Donchian|Supertrend)/);
    assert.equal(t.exitPrincipal,round(q*89.95));assert.equal(t.exitFees,round(t.exitPrincipal*.009));assert.equal(t.exitSlippage,round(t.exitPrincipal*.001));
    assert.equal(t.proceeds,round(t.exitPrincipal-t.exitFees-t.exitSlippage));assert.equal(t.pnl,round(t.proceeds-t.cost));assert.ok(t.pnl<0);
    assert.equal(t.exitEvidence.kind,'signal');assert.equal(t.exitEvidence.barTime,T0);
  }
  assert.equal(byId(s2,'hold-3').account.trades.length,0,'the benchmark never sells');
  assertLedger(s2);
  // Re-reading the same completed bar never re-enters, even if a bar that closed before the exit still says long.
  const same=advanceLab(s2,drop,next+300);
  assert.equal(byId(same,'sma200-5').account.positions.filter(p=>p.product==='BTC-USD').length,0);
  const stale=advanceLab(s2,inputs(next+300,{end:T0}),next+300);
  for(const id of ['sma200-5','donchian-100-50','supertrend-10-3','sma100-2']){
    const b=byId(stale,id);assert.equal(b.signals[0].action,'enter');assert.equal(b.account.positions.filter(p=>p.product==='BTC-USD').length,0,id);
    assert.match(b.decisions.find(d=>d.product==='BTC-USD').reason,/already used|no new completed daily bar/);
  }
  // A new completed bar that closes above the entry level enters again, as a bar-close entry.
  const day3=T0+2*DAY+600,again=advanceLab(same,inputs(day3,{btc:[...flat(447),110,90,115],eth:[...flat(447),110,111,112],end:T0+2*DAY,prices:{btc:115,eth:112}}),day3);
  const re=byId(again,'sma200-5').account.positions.find(p=>p.product==='BTC-USD');
  assert.ok(re);assert.equal(re.entryKind,'bar-close');assert.match(re.entryReasons[0],/^Bar-close entry/);assert.equal(re.signalBarTime,T0+DAY);
  assertLedger(again);
});

test('one entry per product per completed bar: an entry signal already used is never repeated',()=>{
  // Enter, exit and then see the entry bar's signal again: the used signal id blocks it even without a new exit time.
  const s=started();
  const exited=advanceLab(s,inputs(T0+DAY+600,{btc:[...flat(448),110,90],eth:[...flat(448),110,111],end:T0+DAY,prices:{btc:90}}),T0+DAY+600);
  const b=byId(exited,'sma100-2');assert.equal(b.account.trades.length,1);
  const replay=advanceLab(exited,inputs(T0+DAY+900,{end:T0}),T0+DAY+900);
  assert.equal(byId(replay,'sma100-2').account.positions.some(p=>p.product==='BTC-USD'),false);
  assert.equal(new Set(byId(replay,'hold-3').account.positions.map(p=>p.id)).size,3);
});

test('source errors keep the newer good reading with original times and never trade on it',()=>{
  const s=started(),t=now+300;
  const r=advanceLab(s,inputs(t,{prices:{btc:70},override:{'BTC-USD':{candles:null,candlesError:'Public market data HTTP 503'},'ETH-USD':{book:null,bookError:'Public market data HTTP 502'}}}),t);
  for(const id of ['sma200-5','donchian-100-50','supertrend-10-3','sma100-2']){
    const b=byId(r,id),sig=b.signals.find(x=>x.product==='BTC-USD'),prior=byId(s,id).signals.find(x=>x.product==='BTC-USD');
    assert.equal(sig.retained,true,id);assert.equal(sig.fetchedAt,prior.fetchedAt);assert.equal(sig.barTime,prior.barTime);assert.equal(sig.evaluatedAt,now);assert.equal(sig.error,'Public market data HTTP 503');
    assert.equal(b.account.trades.length,0,'a crash observed only in the book never turns a retained signal into a trade');
    assert.equal(b.account.positions.find(p=>p.product==='ETH-USD').markComplete,false);assert.equal(b.account.markComplete,false);
    assert.equal(b.account.positions.find(p=>p.product==='ETH-USD').markValue,byId(s,id).account.positions.find(p=>p.product==='ETH-USD').markValue,'last good mark retained');
  }
  assert.equal(r.sources['BTC-USD'].candles.status,'error');assert.equal(r.sources['BTC-USD'].candles.fetchedAt,s.sources['BTC-USD'].candles.fetchedAt);
  assert.equal(r.sources['ETH-USD'].book.status,'error');assert.equal(r.sources['ETH-USD'].book.receivedAt,now,'last good book time kept');
  assert.deepEqual(r.errors.map(e=>`${e.product}:${e.stage}`).sort(),['BTC-USD:candles','ETH-USD:book']);
  assert.deepEqual(held(r,'hold-3'),['BTC-USD','ETH-USD','SOL-USD'],'the benchmark keeps its positions');
  // Starting flat with a failed read enters nothing on that product; hold-3 needs only a fresh book.
  const fresh=advanceLab(null,inputs(now,{override:{'BTC-USD':{candles:null,candlesError:'timeout'}}}),now);
  assert.deepEqual(held(fresh,'sma200-5'),['ETH-USD']);assert.equal(byId(fresh,'sma200-5').signals[0].status,'unavailable');assert.equal(byId(fresh,'sma200-5').signals[0].retained,false);
  assert.equal(held(fresh,'hold-3').length,3);
  // A failed book blocks an entry that the signal wants; hold-3 waits for a usable book too.
  const nobook=advanceLab(null,inputs(now,{override:{'ETH-USD':{book:null,bookError:'HTTP 500'}}}),now);
  assert.deepEqual(held(nobook,'sma100-2'),['BTC-USD']);assert.deepEqual(held(nobook,'hold-3'),['BTC-USD','SOL-USD']);
  assert.match(byId(nobook,'sma100-2').decisions.find(d=>d.product==='ETH-USD').reason,/no usable public order book/);
  assert.equal(byId(nobook,'hold-3').benchmark.legs['ETH-USD'],null);
  const later=advanceLab(nobook,inputs(now+300),now+300);
  assert.deepEqual(held(later,'hold-3').sort(),['BTC-USD','ETH-USD','SOL-USD']);assert.equal(byId(later,'hold-3').benchmark.legs['ETH-USD'].startedAt,now+300,'late benchmark leg keeps its own start time');
  assertLedger(later);
  // A stale latest bar is refused rather than traded.
  const stale=advanceLab(null,inputs(now+3*DAY),now+3*DAY);
  assert.equal(held(stale,'sma100-2').length,0);assert.match(byId(stale,'sma100-2').signals[0].error,/stale/);assert.equal(held(stale,'hold-3').length,3);
  // Too little SOL history leaves only the books that can compute.
  const shortSol=advanceLab(null,inputs(now,{sol:[...flat(149),110]}),now);
  assert.deepEqual(held(shortSol,'sma100-2'),['BTC-USD','ETH-USD','SOL-USD']);assert.deepEqual(held(shortSol,'sma200-5'),['BTC-USD','ETH-USD']);
  assert.match(byId(shortSol,'sma200-5').signals[2].error,/Insufficient/);assert.ok(shortSol.errors.some(e=>e.stage==='signal'&&e.bookId==='sma200-5'&&e.product==='SOL-USD'));
});

test('entries wait while an open position lacks a fresh mark',()=>{
  const base=advanceLab(null,inputs(now,{override:{'BTC-USD':{candles:null,candlesError:'timeout'}}}),now);
  const r=advanceLab(base,inputs(now+300,{override:{'ETH-USD':{book:null,bookError:'HTTP 500'}}}),now+300);
  assert.match(byId(r,'sma100-2').decisions.find(d=>d.product==='BTC-USD').reason,/fresh mark/);
  assert.equal(byId(r,'sma100-2').account.positions.length,1);
});

test('invalid or incompatible state is refused rather than reset',()=>{
  const s=started(),tamper=fn=>{const c=structuredClone(s);fn(c);return c;};
  assert.throws(()=>advanceLab(tamper(c=>{c.books[0].account.cash+=1;}),inputs(now+300),now+300),/refusing to reset/);
  assert.throws(()=>advanceLab({...s,policyId:'other'},inputs(now+300),now+300),/migration/);
  assert.throws(()=>advanceLab({...s,realEnabled:true},inputs(now+300),now+300),/refusing to reset/);
  assert.throws(()=>validateLab(tamper(c=>{c.books[0].params.days=150;})),/parameters/);
  assert.throws(()=>validateLab(tamper(c=>{c.books.pop();})),/refusing to reset/);
  assert.throws(()=>validateLab(tamper(c=>{const a=c.books[0].account;a.positions.push({...a.positions[0],id:'x'});})),/refusing to reset/);
  assert.throws(()=>validateLab(tamper(c=>{c.books[4].benchmark.cash+=5;})),/benchmark/);
  assert.throws(()=>validateLab(tamper(c=>{c.books[1].account.trades.push({});})),/refusing to reset/);
  assert.throws(()=>validateLab(null),/refusing to reset/);
});

test('bounded history keeps hourly points, daily points and the last 288 cycle receipts',()=>{
  let s=started();for(let i=1;i<=30;i++)s=advanceLab(s,inputs(now+i*300),now+i*300);
  for(const b of s.books){assert.equal(b.curve.length,3);assert.equal(b.daily.length,1);assert.equal(b.daily[0].at,now+9000);assert.ok(b.curve.every(p=>Number.isFinite(p.benchmark)&&Number.isFinite(p.equity)));}
  assert.equal(s.cycles.length,31);
  for(let i=31;i<=310;i++)s=advanceLab(s,inputs(now+i*300),now+i*300);
  assert.equal(s.cycles.length,288);assert.equal(s.cycles.at(-1).at,now+310*300);assertLedger(s);
});

test('max drawdown and returns come from marked equity and never from a stale mark',()=>{
  let s=started();
  const down=advanceLab(s,inputs(now+300,{prices:{btc:90,eth:90}}),now+300);
  const b=byId(down,'sma200-5');assert.ok(b.account.maxDrawdown<0);
  assert.equal(b.account.peak,Math.max(1000,byId(s,'sma200-5').account.peak));
  const r=labReturns(b);assert.equal(r.ret,b.account.equity/1000-1);assert.equal(r.entries,2);assert.ok(r.delta<0||r.delta>=0);
  const stale=advanceLab(down,inputs(now+600,{prices:{btc:60},override:{'BTC-USD':{book:null,bookError:'x'}}}),now+600);
  assert.equal(byId(stale,'sma200-5').account.maxDrawdown,b.account.maxDrawdown,'incomplete marks do not move the drawdown');
});

test('snapshots are validated and never look newer than their evaluation or live',()=>{
  const s=started(),snap=labSnapshot(s,{generatedAt:now,requests:9});
  assert.equal(validLabSnapshot(snap,now),true);assert.equal(snap.execution.realEnabled,false);assert.equal(snap.execution.credentialsConnected,false);
  assert.equal(snap.lab.books.length,5);assert.equal(validLabSnapshot({...snap,generatedAt:now+3600},now),false);
  assert.equal(validLabSnapshot({...snap,realEnabled:true},now),false);assert.equal(validLabSnapshot({...snap,execution:{realEnabled:true}},now),false);
  assert.throws(()=>labSnapshot(s,{generatedAt:now-1}));
  const text=JSON.stringify(snap);assert.ok(!/password|secret|apikey|api_key|privateKey/i.test(text),'no credential-shaped fields');
});

// ---- public collection ----
function fakeFeed(time){
  const calls=[];
  const dayClose=t=>t>=T0+10*DAY?110:100;
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/book'))return {ok:true,json:async()=>({bids:[['109.9','2',1],['109.95','1',1]],asks:[['110.05','1',1]],sequence:7})};
    const m=url.match(/start=([^&]+)&end=([^&]+)/),start=Date.parse(m[1])/1000,end=Date.parse(m[2])/1000,rows=[];
    for(let t=Math.ceil(start/DAY)*DAY;t<=end;t+=DAY){const c=t<T0-DAY?100:110,o=100;rows.push([t,Math.min(o,c)*.99,Math.max(o,c)*1.01,o,c,10]);}
    return {ok:true,json:async()=>rows.reverse()};
  };
  return {calls,fetcher,clock:()=>time++};
}

test('candle windows are day-aligned, contiguous and never exceed 300 candles',()=>{
  const end=T0+7*3600,w=candleWindows(end);
  assert.equal(w.length,2);assert.equal(w[0][1],end);
  for(const [a,b] of w){assert.equal(a%DAY,0);assert.ok((b-a)/DAY+1<=300);}
  assert.equal(w[1][1]+1,w[0][0],'windows do not overlap or leave a gap');
  assert.ok(end-w[1][0]>=420*DAY&&end-w[1][0]<421*DAY);
  assert.ok(candleWindows(end,1000).every(([a,b])=>(b-a)/DAY+1<=300));
});

test('public collection is GET-only, chunks history, reads candles before books and reports failures explicitly',async()=>{
  const {calls,fetcher,clock}=fakeFeed(now);
  const ok=await collectLabInputs({pace:0,fetcher,clock});
  assert.equal(ok.errors.length,0);assert.equal(ok.usable,3);assert.equal(ok.requests,9);
  assert.ok(calls.every(c=>c.options.method==='GET'&&!c.options.headers.Authorization&&!c.options.body));
  assert.deepEqual(calls.map(c=>c.url.includes('/candles')?'candles':'book'),['candles','candles','candles','candles','candles','candles','book','book','book']);
  const spans=calls.filter(c=>c.url.includes('/candles')).map(c=>{const m=c.url.match(/start=([^&]+)&end=([^&]+)/);return (Date.parse(m[2])-Date.parse(m[1]))/1000/DAY+1;});
  assert.ok(spans.every(n=>n<=300),`${spans}`);
  assert.match(calls[0].url,/\/products\/BTC-USD\/candles\?granularity=86400&start=\d{4}-\d\d-\d\dT00:00:00Z&end=/);
  assert.match(calls[6].url,/\/products\/BTC-USD\/book\?level=2$/);assert.match(calls[2].url,/\/products\/ETH-USD\//);assert.match(calls[4].url,/\/products\/SOL-USD\//);
  const btc=ok.inputs['BTC-USD'];
  assert.ok(btc.candles.length>=420&&btc.candles.length<=422);assert.deepEqual(btc.book.bids[0],[109.95,1]);assert.ok(btc.candlesReceivedAt>btc.candlesRequestedAt);assert.ok(btc.book.receivedAt>btc.book.requestAt);
  // The chunked history feeds the lab without gaps: every signal is ready.
  const s=advanceLab(null,ok.inputs,now+100);
  assert.ok(byId(s,'sma200-5').signals.every(x=>x.status==='ready'),JSON.stringify(byId(s,'sma200-5').signals.map(x=>x.reason)));
  assert.ok(byId(s,'supertrend-10-3').signals.every(x=>x.status==='ready'));
  const failed=await collectLabInputs({pace:0,fetcher:async()=>({ok:false,status:503})});
  assert.equal(failed.usable,0);assert.equal(failed.errors.length,6);assert.ok(failed.errors.every(e=>e.message==='Public market data HTTP 503'));
  const crossed=await collectLabInputs({pace:0,fetcher:async url=>({ok:true,json:async()=>url.includes('/book')?{bids:[['111','1']],asks:[['110','1']]}:[]})});
  assert.deepEqual(crossed.errors.map(e=>e.stage),['candles','candles','candles','book','book','book']);
  // One failed window fails the product's history, never a truncated series.
  let n=0;const partial=await collectLabInputs({pace:0,clock:()=>now,fetcher:async url=>{n++;if(n===2)return {ok:false,status:429};return fakeFeed(now).fetcher(url,{});}});
  assert.equal(partial.inputs['BTC-USD'].candles,null);assert.equal(partial.inputs['BTC-USD'].candlesError,'Public market data HTTP 429');assert.ok(partial.inputs['ETH-USD'].candles);
});

// ---- collector: injectable root, isolation ----
async function tempRoot(){return mkdtemp(path.join(tmpdir(),'lab-'));}
const feedFrom=(t,over={})=>async()=>({inputs:inputs(t,over),errors:[],requests:9,usable:3});

test('collector writes only lab files under its root, is atomic and idempotent, and leaves the trend mirror untouched',async()=>{
  const root=await tempRoot(),logs=[],log={log:m=>logs.push(m),error:m=>logs.push(m)};
  try{
    await mkdir(path.join(root,'data/crypto-trend'),{recursive:true});await mkdir(path.join(root,'dashboard/data'),{recursive:true});
    const sentinelState='{"sentinel":"trend state"}\n',sentinelSnap='{"sentinel":"trend snapshot"}\n';
    await writeFile(path.join(root,'data/crypto-trend/state.json'),sentinelState);await writeFile(path.join(root,'dashboard/data/crypto-trend.json'),sentinelSnap);
    const p=labPaths(root);
    let t=now;
    const first=await runLab({root,collect:feedFrom(t),clock:()=>t,log});
    assert.equal(first.published,true);
    const state=JSON.parse(await readFile(p.state,'utf8')),snap=JSON.parse(await readFile(p.snapshot,'utf8'));
    assert.equal(state.startedAt,now);assert.equal(state.books.length,5);assert.equal(validLabSnapshot(snap,now),true);assert.equal(snap.generatedAt,now);
    await assert.rejects(stat(p.lock),/ENOENT/,'lock released');
    // A second scheduled cycle advances the same books; the same evaluation time writes nothing.
    t=now+300;
    const second=await runLab({root,collect:feedFrom(t,{prices:{btc:111}}),clock:()=>t,log});
    assert.equal(second.published,true);
    const state2=JSON.parse(await readFile(p.state,'utf8'));assert.equal(state2.startedAt,now);assert.equal(state2.updatedAt,now+300);assert.equal(state2.cycles.length,2);
    const bytes=await readFile(p.state,'utf8');
    const third=await runLab({root,collect:feedFrom(t),clock:()=>t,log});
    assert.equal(third.published,false);assert.equal(await readFile(p.state,'utf8'),bytes);
    // Every source failing keeps the last snapshot byte-for-byte.
    const snapBytes=await readFile(p.snapshot,'utf8');
    const failed=await runLab({root,collect:async()=>({inputs:{},errors:[{product:'BTC-USD',stage:'candles',message:'HTTP 503'}],requests:9,usable:0}),clock:()=>now+900,log});
    assert.equal(failed.published,false);assert.equal(await readFile(p.snapshot,'utf8'),snapBytes);assert.equal(await readFile(p.state,'utf8'),bytes);
    // Invalid state is refused, not reset, and the lock is released.
    await writeFile(p.state,JSON.stringify({...state2,books:[]}));
    await assert.rejects(runLab({root,collect:feedFrom(now+1200),clock:()=>now+1200,log}),/refusing to reset/);
    await assert.rejects(stat(p.lock),/ENOENT/);
    await writeFile(p.state,'{broken');
    await assert.rejects(runLab({root,collect:feedFrom(now+1200),clock:()=>now+1200,log}),/no paper book reset/);
    // A held lock is respected and never removed by a second runner.
    await mkdir(p.lock);
    await assert.rejects(runLab({root,collect:feedFrom(now+1500),clock:()=>now+1500,log}),/EEXIST/);
    assert.ok((await stat(p.lock)).isDirectory());
    // The trend mirror's files were never read or written.
    assert.equal(await readFile(path.join(root,'data/crypto-trend/state.json'),'utf8'),sentinelState);
    assert.equal(await readFile(path.join(root,'dashboard/data/crypto-trend.json'),'utf8'),sentinelSnap);
  }finally{await rm(root,{recursive:true,force:true});}
});

// ---- UI ----
test('UI shows paper-only labels, delayed data and retained readings without inventing results',()=>{
  const s=started(),snap=labSnapshot(s,{generatedAt:now});
  const html=labPanel(snap,{now:now+60});
  for(const text of ['SMA200 ±5%','Donchian 100/50','Supertrend 10×3','SMA100 ±2% (live rule, control)','Hold BTC/ETH/SOL (benchmark)','vs hold-3','Max drawdown','Fees paid','BTC','ETH','SOL','enter above','exit below','not continuous quotes','of forward data','Benchmark'])assert.ok(html.includes(text),text);
  assert.equal((html.match(/class="account-card lab-card"/g)||[]).length,5);
  assert.doesNotMatch(html,/Collection delayed/);assert.match(labPanel(snap,{now:now+3600}),/Collection delayed/);
  const retained=labSnapshot(advanceLab(s,inputs(now+300,{override:{'BTC-USD':{candles:null,candlesError:'HTTP 503'}}}),now+300),{generatedAt:now+300});
  const rh=labPanel(retained,{now:now+360});
  assert.match(rh,/Retained/);assert.match(rh,/Latest read failed \(HTTP 503\)/);assert.match(rh,/no paper trade is made on it/);assert.match(rh,/public-source issue/);
  const missing=labPanel(undefined,{error:'HTTP 404 <b>x</b>'});
  assert.match(missing,/not published yet/);assert.doesNotMatch(missing,/\$[\d,]+\.\d\d/,'no invented balances');assert.match(missing,/&lt;b&gt;/);
  assert.equal(LAB_LABEL,'Paper experiments. Not the live bot. Results so far are short-window and not evidence of an edge.');assert.equal(LAB_TITLE,'Strategy Lab');
  assert.doesNotMatch(html,/proven|guaranteed|will earn/i);
});

test('the page discloses the labels and the static historical backtest table',async()=>{
  const crypto=await readFile(new URL('../dashboard/crypto.html',import.meta.url),'utf8');
  for(const text of [LAB_TITLE,'id="lab-books"',LAB_LABEL,'Historical backtest summary (Feb 2024 to Sep 2026, BTC/ETH/SOL, live-bot fee model, not live results)',
    'SMA100 ±2% (live rule)','0.51','12.5%','−71.9%','Supertrend 10×3','0.48','15.7%','−48.5%','SMA150 ±2%','0.41','8.4%','−61.3%','Donchian 100/50','0.38','7.9%','−56.8%','SMA200 ±5%','0.36','6.5%','−59.3%','Hold','0.45','7.6%','−76.3%',
    'swing widely with small parameter changes','SOL lost money under the live rule','crypto-lab.css','crypto-lab-ui.mjs'])assert.ok(crypto.includes(text),text);
  assert.ok(crypto.includes('id="trend-mirror"'),'the existing trend mirror section remains');
});

test('build publishes the lab modules and the workflow keeps the lab separate and optional',async()=>{
  const build=await readFile(new URL('../scripts/build-site.mjs',import.meta.url),'utf8');
  for(const file of ['crypto-lab-core.mjs','crypto-lab-ui.mjs','crypto-lab.css'])assert.ok(build.includes(`'${file}'`),file);
  assert.ok(build.includes("'crypto-lab'"));
  const workflow=await readFile(new URL('../.github/workflows/opportunities.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes('node scripts/collect-crypto-lab.mjs'));assert.ok(workflow.includes('data/crypto-lab/state.json'));assert.ok(workflow.includes('dashboard/data/crypto-lab.json'));
  assert.match(workflow,/for file in dashboard\/data\/crypto-lab\.json data\/crypto-lab\/state\.json; do\s+if \[ -f "\$file" \]; then git add "\$file"; fi/);
  for(const name of ['collect-crypto-lab.mjs','crypto-lab-feed.mjs']){
    const source=await readFile(new URL(`../scripts/${name}`,import.meta.url),'utf8');
    assert.ok(!/crypto-trend\/state|crypto-trend\.json|crypto-strategies\/state|scripts\/live|coinbase-live/.test(source),`${name} touches no other ledger`);
    assert.ok(!/['"`]POST['"`]|Authorization|CB-ACCESS|process\.env\.(?!MM_LAB_ROOT)/.test(source),`${name} has no order or credential path`);
  }
  const core=await readFile(new URL('../dashboard/crypto-lab-core.mjs',import.meta.url),'utf8');
  assert.ok(!/crypto-trend-core|scripts\/live|fetch\(/.test(core),'the core is pure and separate from the mirror');
});
