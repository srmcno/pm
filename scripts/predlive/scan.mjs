// One preview scan against real PUBLIC market data. No credentials are read,
// no journal is opened and nothing is submitted.
// Usage: node scripts/predlive/scan.mjs [--cross-venue] [--allow-sports] [--max-events=N] [--pages=N]
import {KalshiLive} from './kalshi.mjs';
import {KalshiScanner,scanCrossVenue} from './scanner.mjs';
import {D} from '../live/risk.mjs';

const args=new Set(process.argv.slice(2));
const arg=(name,fallback)=>{const hit=process.argv.find(a=>a.startsWith(`--${name}=`));return hit?Number(hit.split('=')[1]):fallback;};
const options={allowSports:args.has('--allow-sports'),exhaustiveSeries:[],margin:'0.01',maxTradeUsd:'25'};
const kalshi=new KalshiLive({});
const scanner=new KalshiScanner({kalshi});
const started=Date.now()/1000;
const result=await scanner.scan({...options,now:Date.now()/1000},{maxPages:arg('pages',100),maxEvents:arg('max-events',40),deadline:started+600});
let opportunities=result.opportunities,errors=[...result.errors],cross=null;
if(args.has('--cross-venue')){
  try{cross=await scanCrossVenue({...options,now:Date.now()/1000});opportunities=[...opportunities,...cross.opportunities];errors.push(...cross.errors);}
  catch(error){errors.push(`cross-venue: ${error.message}`);}
}
const edge=o=>o.evaluation?.bestNetEdgePerContract;
const lockedRanked=opportunities.filter(o=>o.locked&&typeof edge(o)==='string').sort((a,b)=>D(edge(b))>D(edge(a))?1:-1);
const ranked=opportunities.filter(o=>typeof edge(o)==='string').sort((a,b)=>D(edge(b))>D(edge(a))?1:-1);
const byType={};
for(const o of opportunities){const t=byType[o.type]??={evaluated:0,lockedPositiveNetEdge:0,unlockedPositiveGap:0,executable:0,bestNetEdgePerContract:null};t.evaluated++;if(o.positive)t.lockedPositiveNetEdge++;else if(o.rawPositive)t.unlockedPositiveGap++;if(o.executable)t.executable++;
  const e=edge(o);if(typeof e==='string'&&(t.bestNetEdgePerContract===null||D(e)>D(t.bestNetEdgePerContract)))t.bestNetEdgePerContract=e;}
console.log(JSON.stringify({
  scannedAt:new Date(started*1000).toISOString(),durationSeconds:Math.round(Date.now()/1000-started),
  coverage:{...result.coverage,crossVenuePairs:cross?.coverage?.pairs??null},
  evaluated:opportunities.length,lockedPositiveNetEdge:opportunities.filter(o=>o.positive).length,unlockedPositiveGap:opportunities.filter(o=>!o.positive&&o.rawPositive).length,executable:opportunities.filter(o=>o.executable).length,byType,
  bestLockedNetEdgePerContractUsd:lockedRanked[0]?edge(lockedRanked[0]):null,
  bestLocked:lockedRanked[0]?{type:lockedRanked[0].type,key:lockedRanked[0].key,netEdgePerContract:edge(lockedRanked[0]),reasons:lockedRanked[0].reasons.slice(0,3)}:null,
  bestUnlockedGapPerContractUsd:ranked[0]?edge(ranked[0]):null,
  top:ranked.slice(0,10).map(o=>({type:o.type,key:o.key,netEdgePerContract:edge(o),netEdge:o.evaluation.bestNetEdge,quantity:o.evaluation.bestNetEdgeQuantity,
    locked:o.locked,positive:o.positive,executable:o.executable,reasons:o.reasons.slice(0,3)})),
  errors:errors.slice(0,20),
},null,1));
