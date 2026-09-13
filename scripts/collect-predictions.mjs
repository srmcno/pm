import {rmSync} from 'node:fs';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {VENUES,PREDICTION_VERSION,POLICY,newAccount,validateAccount,forecast,planBet,advanceAccount,observe,numeric,timestamp} from '../dashboard/prediction-core.mjs';
import {BASE,get,discoverPolymarket,discoverKalshi,normalizePolymarket,normalizeKalshi,resolvedPolymarket,resolvedKalshi} from './predictions/venues.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const statePath=path.join(root,'data/predictions/state.json'),snapshotPath=path.join(root,'dashboard/data/predictions.json');
const lock=path.join(root,'data/predictions/.collector.lock');
await mkdir(path.dirname(lock),{recursive:true});
try{await mkdir(lock);}catch{throw new Error('Another collector holds the prediction state lock.');}
process.on('exit',()=>rmSync(lock,{recursive:true,force:true}));
process.on('SIGTERM',()=>process.exit(143));
process.on('SIGINT',()=>process.exit(130));
async function read(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error(`Unreadable state, refusing to reset: ${file}`,{cause:e});}}
async function save(file,data){await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.'+process.pid+'.tmp',JSON.stringify(data)+'\n');await rename(file+'.'+process.pid+'.tmp',file);}
const start=Date.now()/1000;
const state=await read(statePath,{schemaVersion:1,version:PREDICTION_VERSION,accounts:Object.fromEntries(VENUES.map(v=>[v,newAccount(v,start)])),observations:[],settlements:{}});
if(state.schemaVersion!==1||state.version!==PREDICTION_VERSION||!Array.isArray(state.observations)||!state.settlements)throw new Error('Invalid prediction state; refusing to reset.');
VENUES.forEach(v=>validateAccount(state.accounts?.[v],v));
const old=await read(snapshotPath,{markets:[],sources:[]}),markets=[],sources=[],errors=[],refreshers=new Map();
const enc=encodeURIComponent,events=new Map(),series=new Map(),overrides=new Map();
async function cached(map,key,url){if(!map.has(key))map.set(key,get(url));return map.get(key);}
// Label availability is the time this collector first verifies final payout.
// It never backdates a newly learned label into an earlier training window.
const unresolved=state.observations.filter(o=>o.resolvedAt===null);
const positions=Object.values(state.accounts).flatMap(a=>a.positions).map(p=>({id:p.marketId,marketId:p.marketId,venue:p.marketId.split(':')[0],venueId:p.marketId.slice(p.marketId.indexOf(':')+1),at:p.openedAt}));
const toResolve=[...new Map([...positions,...unresolved].filter(o=>!state.settlements[o.marketId]).map(o=>[o.marketId,o])).values()]
  .sort((a,b)=>(state.resolutionChecks?.[a.marketId]||0)-(state.resolutionChecks?.[b.marketId]||0)).slice(0,30);
state.resolutionChecks||={};
for(let i=0;i<toResolve.length;i+=3)await Promise.all(toResolve.slice(i,i+3).map(async o=>{
  try{const s=await(o.venue==='polymarket'?resolvedPolymarket(o.venueId):resolvedKalshi(o.venueId));if(s)state.settlements[o.marketId]=s;}
  catch(e){errors.push({venue:o.venue,source:'settlement',message:e.message});}
  state.resolutionChecks[o.marketId]=Date.now()/1000;
}));
for(const o of state.observations){const s=state.settlements[o.marketId];if(s&&o.resolvedAt===null){o.resolvedAt=s.observedAt;o.payout=s.yesPayout;o.resolutionSource=s.source;}}
for(const venue of VENUES){
  const source={venue,checkedAt:Date.now()/1000,observedAt:null,status:'error',error:null,sampled:0,discovered:0,scope:'Bounded public sample, not the entire exchange'};
  try{
    const discovery=await(venue==='polymarket'?discoverPolymarket():discoverKalshi());source.discovered=discovery.rows.length;source.pages=discovery.pages;
    const now=Date.now()/1000;
    const score=r=>{const raw=r.raw,at=venue==='polymarket'?timestamp((raw.sportsMarketTypeV2!=='SPORTS_MARKET_TYPE_FUTURE'&&raw.gameStartTime)||raw.endDate):Math.min(timestamp(raw.close_time)??Infinity,timestamp(raw.expected_expiration_time)??Infinity),h=(at-now)/3600;
      const bid=numeric(raw.bestBidQuote?.value??raw.yes_bid_dollars),ask=numeric(raw.bestAskQuote?.value??raw.yes_ask_dollars);
      const mainGame=venue==='polymarket'?raw.sportsMarketTypeV2==='SPORTS_MARKET_TYPE_MONEYLINE':/^KX(NFL|MLB|NCAAF|NBA|NHL)GAME-/.test(raw.event_ticker||'');
      return (h>=6&&h<=720?100:0)+(bid>0&&ask<1&&ask>=bid?10:0)+(mainGame?30:0)+Math.log1p(numeric(raw.volume_24h_fp)||0);
    };
    const chosen=[],seen=new Set();
    for(const r of discovery.rows.sort((a,b)=>score(b)-score(a))){
      const key=venue==='polymarket'?r.event?.id:r.raw.event_ticker;
      if(!key||seen.has(key))continue;seen.add(key);chosen.push(r);if(chosen.length>=36)break;
    }
    // Positions have priority over discovery and are refreshed even if they leave the sample.
    for(const p of state.accounts[venue].positions){
      const id=p.marketId.slice(p.marketId.indexOf(':')+1);
      if(chosen.some(r=>(r.raw.slug||r.raw.ticker)===id))continue;
      if(venue==='polymarket'){
        const d=await get(`${BASE.polymarket}/market/slug/${enc(id)}`),prior=old.markets.find(m=>m.id===p.marketId);
        chosen.unshift({raw:d.market,event:{id:prior?.eventId?.replace(/^pm:/,''),slug:prior?.eventSlug,seriesId:prior?.seriesId}});
      }else chosen.unshift({raw:(await get(`${BASE.kalshi}/markets/${enc(id)}`)).market});
    }
    const collected=[];
    for(let i=0;i<chosen.length&&Date.now()/1000-start<480;i+=4)await Promise.all(chosen.slice(i,i+4).map(async ({raw,event})=>{
      try{
        let m;
        if(venue==='polymarket'){
          const book=await get(`${BASE.polymarket}/markets/${enc(raw.slug)}/book`);
          m=normalizePolymarket(raw,event,book,Date.now()/1000);m.eventSlug=event?.slug||null;
        }else{
          const ev=(await cached(events,raw.event_ticker,`${BASE.kalshi}/events/${enc(raw.event_ticker)}`)).event;
          const ser=(await cached(series,ev.series_ticker,`${BASE.kalshi}/series/${enc(ev.series_ticker)}`)).series;
          let changes=null;
          try{const d=await cached(overrides,raw.event_ticker,`${BASE.kalshi}/events/fee_changes?event_ticker=${enc(raw.event_ticker)}&limit=1000`);if(Array.isArray(d.event_fee_changes)&&!d.cursor)changes=d.event_fee_changes;}catch(e){errors.push({venue,source:'fees',message:e.message});}
          const book=await get(`${BASE.kalshi}/markets/${enc(raw.ticker)}/orderbook?depth=10`);
          m=normalizeKalshi(raw,ev,ser,changes,book,Date.now()/1000);
        }
        collected.push(m);
        // Record when THIS book is received, before unrelated slow requests age it out.
        state.observations=observe([m],state.observations,m.observedAt);
        refreshers.set(m.id,async()=>{
          if(venue==='polymarket'){
            const fresh=(await get(`${BASE.polymarket}/market/slug/${enc(raw.slug)}`)).market;
            return normalizePolymarket(fresh,event,await get(`${BASE.polymarket}/markets/${enc(raw.slug)}/book`),Date.now()/1000);
          }
          const fresh=(await get(`${BASE.kalshi}/markets/${enc(raw.ticker)}`)).market;
          const ev=(await get(`${BASE.kalshi}/events/${enc(raw.event_ticker)}`)).event;
          const ser=(await get(`${BASE.kalshi}/series/${enc(ev.series_ticker)}`)).series;
          const fees=await get(`${BASE.kalshi}/events/fee_changes?event_ticker=${enc(raw.event_ticker)}&limit=1000`);
          const book=await get(`${BASE.kalshi}/markets/${enc(raw.ticker)}/orderbook?depth=10`);
          return normalizeKalshi(fresh,ev,ser,!fees.cursor?fees.event_fee_changes:null,book,Date.now()/1000);
        });
      }catch(e){errors.push({venue,source:raw.slug||raw.ticker,message:e.message});}
    }));
    if(!collected.length)throw new Error('No executable books could be read.');
    const failedIds=new Set(chosen.map(({raw})=>`${venue}:${raw.slug||raw.ticker}`));
    collected.forEach(m=>failedIds.delete(m.id));
    markets.push(...old.markets.filter(m=>failedIds.has(m.id)).map(m=>({...m,sourceError:'Book refresh failed; retaining original timestamps'})));
    markets.push(...collected);source.observedAt=Math.max(...collected.map(m=>m.observedAt));source.sampled=collected.length;
    source.status=collected.length<chosen.length?'partial':'ok';
    source.error=collected.length<chosen.length?`${chosen.length-collected.length} sampled books could not refresh`:null;
  }catch(e){source.error=e.message;markets.push(...old.markets.filter(m=>m.venue===venue));source.observedAt=old.sources?.find(s=>s.venue===venue)?.observedAt||null;}
  sources.push(source);console.log(`${venue}: ${source.status}, ${source.sampled} books, ${source.discovered} contracts discovered`);
}
// Re-read any prospective entry and every open position immediately before
// advancing the books. Old scan-time eligibility never becomes a current fill.
const needsFresh=markets.filter(m=>{
  if(state.accounts[m.venue].positions.some(p=>p.marketId===m.id))return true;
  const f=forecast(m,state.observations,Date.now()/1000);
  return ['yes','no'].some(side=>planBet(m,side,f,state.accounts[m.venue],m.observedAt).status==='candidate');
});
for(const m of needsFresh){try{const refresh=refreshers.get(m.id);if(refresh)markets[markets.indexOf(m)]=await refresh();}catch(e){m.sourceError='Entry/mark refresh failed';errors.push({venue:m.venue,source:m.id,message:e.message});}}
const now=Date.now()/1000,decisions=[];
for(const m of markets){const f=forecast(m,state.observations,now);for(const side of ['yes','no'])decisions.push({marketId:m.id,venue:m.venue,side,forecast:f,plan:planBet(m,side,f,state.accounts[m.venue],now)});}
for(const venue of VENUES)state.accounts[venue]=advanceAccount(state.accounts[venue],markets,decisions,state.settlements,now);
state.observations=observe(markets,state.observations,now).map(o=>{
  if(o.rules){o.rulesHash=createHash('sha256').update(o.rules).digest('hex');delete o.rules;}return o;
});
state.updatedAt=now;
const studies=Object.fromEntries(VENUES.map(v=>{const rows=state.observations.filter(o=>o.venue===v&&o.version===PREDICTION_VERSION),closed=rows.filter(o=>o.resolvedAt!==null),binary=closed.filter(o=>[0,1].includes(o.payout)),predicted=binary.filter(o=>Number.isFinite(o.prediction));
  return [v,{observations:rows.length,resolved:closed.length,binary:binary.length,forecasts:predicted.length,
    brier:predicted.length?predicted.reduce((n,o)=>n+(o.prediction-o.payout)**2,0)/predicted.length:null,
    baselineBrier:predicted.length?predicted.reduce((n,o)=>n+(o.baseline-o.payout)**2,0)/predicted.length:null}];}));
const snapshot={schemaVersion:1,version:PREDICTION_VERSION,generatedAt:now,mode:'paper',policy:POLICY,sources,markets,accounts:state.accounts,studies,decisions,errors,
  execution:{mode:'paper',realEnabled:false,credentialsConnected:false,adapterStatus:'Order-intent boundary prepared; authenticated execution is not connected'}};
await save(statePath,state);await save(snapshotPath,snapshot);
console.log(JSON.stringify({generatedAt:now,sources,accounts:Object.fromEntries(VENUES.map(v=>[v,{cash:state.accounts[v].cash,positions:state.accounts[v].positions.length}])),studies,errors:errors.slice(0,4)},null,2));
if(sources.every(s=>s.status==='error'))process.exitCode=1;
