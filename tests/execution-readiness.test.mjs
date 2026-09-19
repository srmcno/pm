import test from 'node:test';import assert from 'node:assert/strict';
import {fundingHurdle,assessReadiness,executionProfile} from '../dashboard/execution-readiness.mjs';
test('round-trip hurdle independently reconciles capital and external costs',()=>{
 const r=fundingHurdle({capital:100,entryRate:.009,exitRate:.009,slippageRate:.001,fundingCost:0,withdrawalCost:0});assert.ok(Math.abs(r-1.01/.99+1)<1e-12);
 const x=fundingHurdle({capital:100,entryRate:.009,exitRate:.009,slippageRate:.001,fundingCost:2,withdrawalCost:4});assert.ok(Math.abs(98/1.01*(1+x)*.99-4-100)<1e-9);
 assert.throws(()=>fundingHurdle({capital:100,entryRate:.9,exitRate:1,slippageRate:0,fundingCost:0,withdrawalCost:0}));
});
test('setup export is always disarmed and rejects invalid allocation limits',()=>{const p=executionProfile('rotation');assert.equal(p.liveEnabled,false);assert.equal(p.mode,'preview');assert.equal(p.state,'OK');assert.throws(()=>executionProfile('rotation',{budget:100,maxOrder:200}));});
test('cash-only and tiny winning samples never qualify for funded promotion',()=>{
 assert.equal(assessReadiness(null).eligible,false);
 const r=assessReadiness({status:'established',startedAt:1,cash:1100,equity:1100,peak:1100,markComplete:true,trades:[{pnl:100,openedAt:100,closedAt:200}],curve:[{at:1000000}]},1000000);
 assert.equal(r.eligible,false);assert.equal(r.gates.find(g=>g.label.startsWith('50')).pass,false);
});
