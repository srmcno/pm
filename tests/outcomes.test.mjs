import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessEvidence,summarizeTrades,applyEvidence} from '../dashboard/outcomes.mjs';
import {advancePaper,analyzeMarket} from '../dashboard/market-core.mjs';
const report=JSON.parse(readFileSync(new URL('../dashboard/data/scanner-backtest.json',import.meta.url)));
test('recorded losses hold both strategies, rather than promoting a technical setup',()=>{
  const p=assessEvidence(report,report.generatedAt+1);
  assert.deepEqual(p.allowedStrategies,[]);assert.equal(p.state,'held');
  assert.ok(p.strategies.every(s=>s.status==='needs-revision'));
  assert.equal(applyEvidence({status:'candidate',setup:'breakout',reasons:[]},p).status,'evidence-held');
});
test('missing, future or mismatched evidence never opens the research gate',()=>{
  for(const r of [null,{...report,modelVersion:'wrong'},{...report,generatedAt:report.generatedAt+1000}])
    assert.deepEqual(assessEvidence(r,report.generatedAt).allowedStrategies,[]);
  const changed=structuredClone(report);changed.runs[0].settings.feeBps=0;
  assert.equal(assessEvidence(changed,report.generatedAt+1).state,'held');
});
test('observed payoff statistics include costs and handle no-trade/single-sided samples',()=>{
  assert.equal(summarizeTrades([]).expectancy,null);
  assert.equal(summarizeTrades([{pnl:2}]).empiricalBreakeven,null);
  const s=summarizeTrades([{pnl:10,entryFee:1,exitFee:1},{pnl:-20,entryFee:2,exitFee:2}]);
  assert.equal(s.net,-10);assert.equal(s.expectancy,-5);assert.equal(s.fees,6);
  assert.equal(s.beforeRecordedFees,-4);assert.ok(Math.abs(s.empiricalBreakeven-100*20/30)<1e-10);
});
test('held strategies cannot open a paper position, while existing positions still exit',()=>{
  const now=1701000000;
  const rows=Array.from({length:90},(_,i)=>{const c=100+i*.3;return[now-(90-i)*3600-30,c-1,c+1,c-.1,c,1000];});
  const last=rows.at(-1);last[4]+=2;last[2]=last[4]+.1;last[5]=2200;
  const m={product:'BTC-USD',status:'online',candles:rows,quote:{bid:last[4]-.01,ask:last[4]+.01,price:last[4],at:now}};
  assert.equal(analyzeMarket(m,{},now).status,'candidate');
  let p=advancePaper(null,[m],now,{strategies:[]});
  assert.equal(p.pending.length,0);assert.equal(p.positions.length,0);
  p=advancePaper(null,[m],now);m.quote.at=now+60;p=advancePaper(p,[m],now+60);
  assert.equal(p.positions.length,1);
  m.quote.bid=p.positions[0].stop*.9;m.quote.ask=m.quote.bid+.01;m.quote.at=now+120;
  p=advancePaper(p,[m],now+120,{strategies:[]});
  assert.equal(p.positions.length,0);assert.equal(p.closed.length,1);
});

test('malformed optional evidence is held without throwing',()=>{
  const broken=[{...report,runs:[null]}, {...report,quality:{'BTC-USD':null}}];
  const ledger=structuredClone(report);ledger.runs.find(r=>r.settings.strategies?.length===1).ledger=null;broken.push(ledger);
  for(const candidate of broken)assert.equal(assessEvidence(candidate,report.generatedAt+1).state,'held');
  assert.equal(summarizeTrades([null,{}, {pnl:NaN}]).trades,0);
});
test('supporting settings and chronological windows must match before an entry is eligible',()=>{
  const positive=structuredClone(report);
  for(const run of positive.runs){
    run.ledger=Array.from({length:30},(_,i)=>({id:'sample-'+i,pnl:i<20?5:-2,entryFee:.1,exitFee:.1,openedAt:run.start+300,closedAt:run.start+600}));
    run.trades=30;run.returnPct=8;run.finalEquity=1080;run.profitFactor=5;run.feesUsd=6;
  }
  assert.deepEqual(assessEvidence(positive,positive.generatedAt+1).allowedStrategies,['breakout','reclaim']);
  const costMismatch=structuredClone(positive);costMismatch.runs.find(r=>r.name==='Higher costs').settings.feeBps=0;
  assert.equal(assessEvidence(costMismatch,positive.generatedAt+1).state,'held');
  const overlap=structuredClone(positive);overlap.runs.find(r=>r.name==='Last 30 days').start=positive.start;
  assert.equal(assessEvidence(overlap,positive.generatedAt+1).state,'held');
  const hourly=structuredClone(positive);for(const q of Object.values(hourly.quality))q.hourly.pct=0;
  assert.equal(assessEvidence(hourly,positive.generatedAt+1).state,'held');
});
