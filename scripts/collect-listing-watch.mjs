// Listing Watch collector. Reads three public Coinbase sources and a few 1-minute
// candle ranges, then records what Coinbase does when it lists or delists assets.
// Public GET requests only: no credentials, no account, no order path, no paper
// trade. State and snapshot are written atomically; an invalid saved state is
// refused rather than reset. Fetcher, clock and root are injectable for tests.
import {readFile,writeFile,mkdir,rename,rm,stat} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {
  initialListingWatch,validateListingWatch,applyExchange,applyBrokerage,applyIncidents,recordSourceFailure,
  planCandleRequests,applyCandleResults,candleUrl,liveBases,refreshWatchlist,listingWatchSnapshot,SOURCES,LIMITS,
} from '../dashboard/listing-watch-core.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const listingWatchPaths=root=>({
  state:path.join(root,'data/listing-watch/state.json'),
  snapshot:path.join(root,'dashboard/data/listing-watch.json'),
  lock:path.join(root,'data/listing-watch/.collector.lock'),
});
const short=(s,n=200)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
const STALE_LOCK_SECONDS=1200;

async function readJson(file){
  try{return JSON.parse(await readFile(file,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw Error(`Unreadable ${path.basename(file)}; nothing was reset`,{cause:e});}
}
async function save(file,value){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  try{await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}
  catch(e){await rm(temp,{force:true});throw e;}
}
async function acquire(lock,clock){
  await mkdir(path.dirname(lock),{recursive:true});
  for(let attempt=0;attempt<2;attempt+=1){
    try{await mkdir(lock);return;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      // A crashed run must not block collection forever; a live one is never taken over.
      const age=clock()-(await stat(lock).catch(()=>({mtimeMs:Date.now()}))).mtimeMs/1000;
      if(attempt||age<STALE_LOCK_SECONDS)throw Error('Another Listing Watch collection holds the lock');
      await rm(lock,{recursive:true,force:true});
    }
  }
}

// One paced GET at a time. Never sends credentials; the only headers are a user agent and Accept.
export function publicGetter({fetcher=fetch,pace=250,timeout=20000,calls=[]}={}){
  let next=0;
  return async function get(url){
    const at=Math.max(Date.now(),next);next=at+pace;
    if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    const options={method:'GET',headers:{'User-Agent':'MoffittMoney/7.1 public paper research',Accept:'application/json'},signal:AbortSignal.timeout(timeout)};
    calls.push({url,method:options.method});
    const response=await fetcher(url,options);
    if(!response.ok)throw Error(`Public data HTTP ${response.status}`);
    try{return await response.json();}catch(e){throw Error(`Unreadable response: ${short(e.message,120)}`);}
  };
}

const EXTRACT={
  exchange:body=>{
    if(!Array.isArray(body))throw Error(`Exchange product list was not a list${body?.message?`: ${short(body.message,120)}`:''}`);
    return body;
  },
  brokerage:body=>{
    if(!Array.isArray(body?.products))throw Error('Advanced Trade response had no products list');
    // A partial read would look like mass delisting, so a paginated answer is an explicit error.
    if(body.pagination?.has_next===true)throw Error('Advanced Trade listing feed is paginated; refusing a partial read');
    return body.products;
  },
  status:body=>{
    if(!Array.isArray(body?.incidents))throw Error('Status feed had no incidents list');
    return body.incidents;
  },
};
const APPLY={exchange:applyExchange,brokerage:applyBrokerage,status:applyIncidents};

// Network plus pure accounting; no file I/O. Sources fail independently.
export async function collectListingWatch(previous,{fetcher=fetch,clock=()=>Date.now()/1000,pace=250,timeout=20000,maxCandleRequests=LIMITS.candleRequestsPerRun}={}){
  const calls=[],get=publicGetter({fetcher,pace,timeout,calls});
  const started=clock();
  if(previous&&started<previous.updatedAt)throw Error('The system clock is earlier than the saved observation; nothing was written');
  let state=previous?structuredClone(previous):initialListingWatch(started);
  const known=liveBases(state),report={};
  for(const key of ['exchange','brokerage','status']){
    try{
      const body=await get(SOURCES[key].url),at=clock();
      const result=APPLY[key](state,EXTRACT[key](body),at,{knownBases:known});
      state=result.state;report[key]={ok:true,...result.stats};
    }catch(error){
      state=recordSourceFailure(state,key,error.message,clock());
      report[key]={ok:false,error:short(error.message,240)};
    }
  }
  const usable=['exchange','brokerage','status'].some(k=>report[k].ok);
  // Bounded, incremental 1-minute candle reads for launches this collector observed.
  const plan=planCandleRequests(state,clock(),maxCandleRequests),results=[];
  for(const request of plan){
    try{results.push({...request,rows:await get(candleUrl(request))});}
    catch(error){results.push({...request,rows:null,error:short(error.message,200)});}
  }
  const candles=applyCandleResults(state,results,clock());
  state=candles.state;report.candles={...candles.stats,ok:!results.length||candles.stats.succeeded>0,planned:plan.map(({id,start,end})=>({id,start,end}))};
  const generatedAt=Math.max(clock(),state.updatedAt);
  state=refreshWatchlist(state,generatedAt);
  return {usable,state,report,requests:calls.length,calls,generatedAt,
    snapshot:usable?listingWatchSnapshot(state,{generatedAt,requests:calls.length}):null};
}

export async function runListingWatch({root=defaultRoot,fetcher=fetch,clock=()=>Date.now()/1000,pace=250,timeout=20000,maxCandleRequests}={}){
  const p=listingWatchPaths(root);
  await acquire(p.lock,clock);
  try{
    const saved=await readJson(p.state);
    if(saved)validateListingWatch(saved);
    const run=await collectListingWatch(saved,{fetcher,clock,pace,timeout,maxCandleRequests});
    if(!run.usable){
      // Never replace a good snapshot with a cycle in which every source failed.
      return {...run,published:false,exitCode:1,
        reason:'Every public source failed; the last state and snapshot are retained unchanged'};
    }
    // State first: a crash between the two leaves a snapshot that is merely one run behind.
    await save(p.state,run.state);
    await save(p.snapshot,run.snapshot);
    return {...run,published:true,exitCode:0};
  }finally{await rm(p.lock,{recursive:true,force:true});}
}

export function summarize(run){
  const r=run.report,s=run.state;
  return {published:run.published,generatedAt:run.generatedAt,requests:run.requests,reason:run.reason,
    sources:Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v.ok?{ok:true,...(k==='candles'?{requests:v.requests,rows:v.rows,rejected:v.rejected,planned:v.planned}:{count:v.count??v.incidents,skipped:v.skipped,baseline:v.baseline,newProducts:v.newProducts,changed:v.changed?.length,newEvents:v.newEvents,byClass:v.byClass})}:{ok:false,error:v.error}])),
    products:{exchange:Object.keys(s.exchange.products).length,brokerage:Object.keys(s.brokerage.products).length},
    launches:s.counters.launches,transitions:s.counters.transitions,events:s.events.length,
    watchlist:s.watchlist.map(w=>({incident:w.incident,status:w.status,effectiveDate:w.effectiveDate})),
    recentTransitions:s.transitions.slice(0,10)};
}

// CLI: node scripts/collect-listing-watch.mjs [--root <dir>]
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const at=process.argv.indexOf('--root'),root=at>0?path.resolve(process.argv[at+1]):defaultRoot;
  try{
    const run=await runListingWatch({root});
    console.log(JSON.stringify(summarize(run),null,2));
    if(run.exitCode)console.error(run.reason);
    process.exitCode=run.exitCode;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
