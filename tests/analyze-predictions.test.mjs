// Read-only prediction analysis on small synthetic fixtures (not market evidence).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PREDICTION_VERSION} from '../dashboard/prediction-core.mjs';
import {labelled,calibration,walkForward,tradeAudit,analyze,formatReport} from '../scripts/analyze-predictions.mjs';

const obs=(i,o={})=>({id:'kalshi:m'+i,marketId:'kalshi:m'+i,venue:'kalshi',eventId:'e'+i,cohort:'kalshi:S:1-3d',bin:7,at:1000+i*100,baseline:.75,
  version:PREDICTION_VERSION,resolvedAt:1000+i*100+50,payout:1,...o});
test('labels come from observations, fall back to official settlements, and exclude fractional or old-version rows',()=>{
  const state={observations:[obs(1),obs(2,{resolvedAt:null,payout:null}),obs(3,{payout:.5}),obs(4,{version:'old'}),obs(5,{resolvedAt:null,payout:null})],
    settlements:{'kalshi:m2':{yesPayout:0,observedAt:1500}}};
  const {rows,stats}=labelled(state,'kalshi');
  assert.deepEqual(rows.map(r=>[r.eventId,r.payout]),[['e1',1],['e2',0]]);
  assert.deepEqual([stats.observations,stats.fromSettlement,stats.fractional,stats.unlabeled],[4,1,1,1]);
});
test('calibration bands use the earliest observation per event and fold the favored side',()=>{
  const rows=[obs(1,{baseline:.75,payout:1}),obs(2,{baseline:.72,payout:0}),obs(3,{baseline:.25,payout:0}),obs(1,{at:5000,baseline:.15,payout:1})];
  const c=calibration(rows);
  assert.equal(c.events,3);
  const yes70=c.yes.find(b=>b.label==='70-80%');assert.equal(yes70.n,2);assert.equal(yes70.frequency,.5);
  const fav=c.favorite.find(b=>b.label==='75-80%');assert.equal(fav.n,2,'0.75 YES and 0.25 YES (NO favored at 0.75) fold together');assert.equal(fav.frequency,1);
});
test('walk-forward uses only outcomes resolved before each observation and reports the Brier difference to the midpoint',()=>{
  const rows=Array.from({length:40},(_,i)=>obs(i,{payout:i%4?1:0}));
  const w=walkForward(rows,{minCohort:20,minBin:10,prior:10});
  assert.equal(w.scored,20,'the first 20 observations lack 20 earlier resolved events');
  const first=rows[20],prior=rows.slice(0,20),wins=prior.reduce((n,o)=>n+o.payout,0);
  const est=(wins+10*.75)/(20+10);
  assert.ok(w.brierEstimate>0&&w.brierMidpoint>0);
  assert.ok(Math.abs(walkForward(rows.slice(0,21),{minCohort:20,minBin:10,prior:10}).brierEstimate-(est-first.payout)**2)<1e-12);
  const future=rows.map(o=>({...o,resolvedAt:o.at+1e6}));
  assert.equal(walkForward(future).scored,0,'labels learned later are never used');
});
test('trade audit compares claimed model edge, midpoint-expected wins and realized results',()=>{
  const t=(pnl,payout,side='yes')=>({side,quantity:2,cost:1.2,payout,pnl,forecast:{probability:.8,baseline:.6}});
  const a=tradeAudit({trades:[t(.8,2),t(-1.2,0),t(-1.2,0,'no')]});
  assert.equal(a.n,3);assert.equal(a.wins,1);assert.ok(Math.abs(a.expectedWinsAtMidpoint-(.6+.6+.4))<1e-9);
  assert.ok(Math.abs(a.claimedEdgePerContract-((.8-.6)*2+(.2-.6))/3)<1e-9);assert.ok(Math.abs(a.withoutBestTrade+2.4)<1e-9);
});
test('the CLI reads a state file without modifying it and prints a compact report',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'analyze-predictions-')),file=path.join(dir,'state.json');
  const state={updatedAt:2000,version:PREDICTION_VERSION,observations:Array.from({length:30},(_,i)=>obs(i)),settlements:{},accounts:{kalshi:{trades:[]},polymarket:{trades:[]}}};
  const text=JSON.stringify(state);await writeFile(file,text);
  const out=execFileSync(process.execPath,[new URL('../scripts/analyze-predictions.mjs',import.meta.url).pathname,file],{encoding:'utf8'});
  assert.match(out,/== kalshi ==/);assert.match(out,/Walk-forward/);assert.match(out,/Descriptive only/);
  assert.equal(await readFile(file,'utf8'),text);
  assert.equal(formatReport(analyze(state)),out.trimEnd());
  await rm(dir,{recursive:true,force:true});
});
