import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {venueSummary,ledgerRows,toCsv} from '../dashboard/focus-model.mjs';
import {newAccount} from '../dashboard/prediction-core.mjs';
const now=1789270000;
const snapshot=()=>({generatedAt:now,accounts:{kalshi:newAccount('kalshi',now)},sources:[{venue:'kalshi',status:'ok',observedAt:now}],decisions:[]});
test('no decisions is an explicit collection state, not perpetual learning',()=>{
 assert.equal(venueSummary(snapshot(),'kalshi',now).status,'No markets evaluated');
});
test('delayed data and risk stops are not described as active picking',()=>{
 let s=snapshot();s.accounts.kalshi.halted=true;
 assert.equal(venueSummary(s,'kalshi',now).status,'Risk stop');
 assert.equal(venueSummary(s,'kalshi',now+3000).status,'Collection delayed');
 s.sources[0].status='error';assert.equal(venueSummary(s,'kalshi',now).status,'Source unavailable');
});
test('warmup progress uses the candidate policy rather than global totals',()=>{
 const s=snapshot();s.decisions=[{venue:'kalshi',marketId:'x',forecast:{entryStage:'warmup',eligible:false,samples:15,binSamples:8,requirements:{cohort:20,bin:10}},plan:{status:'held',reasons:[]}}];
 const r=venueSummary(s,'kalshi',now);assert.equal(r.status,'Paper warmup');assert.match(r.detail,/15\/20/);assert.match(r.detail,/8\/10/);
});
test('pending confirmation takes priority over generic scanning',()=>{
 const s=snapshot();s.accounts.kalshi.pending.x={at:now};
 assert.equal(venueSummary(s,'kalshi',now).status,'Confirming a paper entry');
});
test('ledger combines both accounts without mutating or dropping trades',()=>{
 const s=snapshot();s.accounts.kalshi.positions=[{id:'a',openedAt:10}];s.accounts.kalshi.trades=[{id:'b',openedAt:5,closedAt:20}];
 const before=structuredClone(s);const rows=ledgerRows(s);
 assert.deepEqual(rows.map(r=>r.id),['b','a']);assert.deepEqual(s,before);
});
test('CSV preserves quoting and neutralizes spreadsheet formulas',()=>{
 const csv=toCsv([{venue:'kalshi',status:'open',question:'=1+1,"unsafe"',quantity:1,cost:.5}]);
 assert.match(csv,/"'=1\+1,""unsafe"""/);
});
test('focused entry has only overview, activity and archive navigation',async()=>{
 const html=await readFile(new URL('../dashboard/focus.html',import.meta.url),'utf8');
 assert.equal((html.match(/data-page=/g)||[]).length,3);
 assert.ok(html.includes('id="account-grid"'));assert.ok(html.includes('id="ledger"'));
 assert.ok(html.includes('archive-workspace.html#copy/paper'));
 assert.ok(!html.includes('id="wallet-list"'));
});
test('home page reserves a compact crypto tournament summary',async()=>{
 const html=await readFile(new URL('../dashboard/focus.html',import.meta.url),'utf8');
 assert.ok(html.includes('id="crypto-summary"'));
 assert.ok(html.includes('href="crypto.html"'));
});
test('crypto page discloses the tournament universe and current maker/taker cost model',async()=>{
 const html=await readFile(new URL('../dashboard/crypto.html',import.meta.url),'utf8');
 assert.ok(html.includes('id="universe-summary"'));
 assert.ok(html.includes('0.90%'));
 assert.ok(html.includes('0.50%'));
 assert.ok(html.includes('id="strategy-leaderboard"'));
});
