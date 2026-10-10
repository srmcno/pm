import test from 'node:test';
import assert from 'node:assert/strict';
import * as venues from '../scripts/predictions/venues.mjs';

test('Kalshi fee changes are reused across collection cycles while fresh',async()=>{
  assert.equal(typeof venues.kalshiFeeChanges,'function');
  const cache={},changes=[{scheduled_ts:'2026-10-01T00:00:00Z',fee_multiplier_override:1}];
  let calls=0;
  const fetcher=async()=>{calls++;return {event_fee_changes:changes,cursor:null};};
  const first=await venues.kalshiFeeChanges('EVENT',cache,{now:1000,fetcher,ttl:3600});
  const second=await venues.kalshiFeeChanges('EVENT',cache,{now:1600,fetcher,ttl:3600});
  assert.deepEqual(first,changes);
  assert.deepEqual(second,changes);
  assert.equal(calls,1);
  assert.deepEqual(cache.EVENT,{checkedAt:1000,changes});
});

test('Kalshi fee changes refresh after the cache lifetime',async()=>{
  assert.equal(typeof venues.kalshiFeeChanges,'function');
  const cache={EVENT:{checkedAt:1000,changes:[]}};
  let calls=0;
  await venues.kalshiFeeChanges('EVENT',cache,{now:4601,ttl:3600,fetcher:async()=>{calls++;return {event_fee_changes:[],cursor:null};}});
  assert.equal(calls,1);
  assert.equal(cache.EVENT.checkedAt,4601);
});

test('incomplete Kalshi fee data is never cached',async()=>{
  assert.equal(typeof venues.kalshiFeeChanges,'function');
  const cache={};
  await assert.rejects(venues.kalshiFeeChanges('EVENT',cache,{now:1000,fetcher:async()=>({event_fee_changes:[],cursor:'next'})}),/incomplete/i);
  assert.equal(cache.EVENT,undefined);
});
