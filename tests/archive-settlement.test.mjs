import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {collectCopyStudy,copyStudySnapshot} from '../scripts/collect-copy-study.mjs';
test('archived study makes no activity reads or entries and preserves unresolved positions',async()=>{
 const state=JSON.parse(await readFile(new URL('../data/copy-forward/state.json',import.meta.url),'utf8')),calls=[];
 const next=await collectCopyStudy(state,async(url)=>{calls.push(url);throw Error('fixture source outage');},{settlementOnly:true});
 assert.ok(calls.every(url=>!url.includes('/activity')));assert.equal(next.candidates.length,0);assert.equal(next.cash,state.cash);assert.equal(next.positions.length,state.positions.length);assert.deepEqual(next.closed,state.closed);assert.equal(copyStudySnapshot(next).status,'settlement-only');assert.equal(next.realEnabled,false);
});
