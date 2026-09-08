import test from 'node:test';
import assert from 'node:assert/strict';
import {replay,coverage} from '../scripts/backtest-opportunities.mjs';
const start=1701043200;
function fixture(){
  const hours=Array.from({length:90},(_,i)=>{const c=100+i*.3;return [start-(90-i)*3600,c-1,c+1,c-.1,c,1000];});
  const last=hours.at(-1);last[4]+=2;last[2]=last[4]+.1;last[5]=2200;
  const value=last[4];
  return {start,end:start+3600,series:{'BTC-USD':{hours,scans:Array.from({length:12},(_,i)=>[start+i*300,value-1,value+1,value,value,100])}}};
}
test('historical replay confirms on a second actual scan and pays round-trip costs',()=>{
  const data=fixture(), r=replay(data);
  assert.equal(r.trades,1);assert.equal(r.ledger[0].openedAt,start+300);
  assert.ok(r.returnPct<0);assert.ok(r.feesUsd>0);assert.equal(r.forcedExits,1);
  assert.ok(Math.abs(r.finalEquity-1000-r.ledger[0].pnl)<1e-7);
});
test('future hourly highs, closes and volumes cannot influence an earlier entry',()=>{
  const data=fixture(), original=replay(data);
  data.series['BTC-USD'].hours.push([start,.01,1e9,100,1e8,1e12]);
  assert.deepEqual(replay(data).ledger,original.ledger);
});
test('missing observations are skipped and counted, with no fabricated candles',()=>{
  const data=fixture();data.series['BTC-USD'].scans.splice(1,1);
  const r=replay(data);assert.equal(r.missingQuotes,1);
  assert.equal(coverage(data.series['BTC-USD'].scans,data.start,data.end,300).missing,1);
  // The missing scan breaks confirmation, so two later observations are needed.
  assert.equal(r.ledger[0].openedAt,start+900);
});
test('higher modeled costs reduce the value of an otherwise identical replay',()=>{
  const data=fixture(), baseline=replay(data,{feeBps:10}), stressed=replay(data,{feeBps:20});
  assert.equal(stressed.trades,baseline.trades);assert.ok(stressed.finalEquity<baseline.finalEquity);
});
test('strategy-specific replay excludes entries from the other rule',()=>{
  assert.equal(replay(fixture(),{strategies:['reclaim']}).trades,0);
  assert.equal(replay(fixture(),{strategies:['breakout']}).trades,1);
});
