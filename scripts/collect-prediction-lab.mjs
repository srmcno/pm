// Advances the isolated paper Prediction Lab. Public data only; it never reads a
// credential, never places or previews an order, and writes ONLY data/prediction-lab/
// and dashboard/data/prediction-lab.json. The two existing $100 prediction accounts,
// their state file and their snapshot are opened read-only as an input.
// runLab() takes injectable roots and feeds so tests and dry runs never touch the
// repository's real state. MM_PREDLAB_ROOT redirects the write root for a dry run.
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {VENUES} from '../dashboard/prediction-core.mjs';
import {advanceLab,ensureBooks,labSnapshot,planRefresh,planResolution,settlementNeeds,sourceStateFor,validateLabState} from '../dashboard/prediction-lab-core.mjs';
import {createFeed} from './prediction-lab-feed.mjs';

export const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const labPaths=root=>({state:path.join(root,'data/prediction-lab/state.json'),snapshot:path.join(root,'dashboard/data/prediction-lab.json'),lock:path.join(root,'data/prediction-lab/.collector.lock')});
const sha256=text=>createHash('sha256').update(text).digest('hex');
const finite=Number.isFinite;

async function read(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error(`Unreadable ${path.basename(file)}; no paper book reset`,{cause:e});}}
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}

// Read-only view of the existing collector's outputs. A missing or unreadable input is an explicit state, never a reset.
async function readSource(sourceRoot){
  const out={snapshot:null,error:null,observations:[],settlements:{},stateError:null};
  try{
    const s=JSON.parse(await readFile(path.join(sourceRoot,'dashboard/data/predictions.json'),'utf8'));
    if(!Array.isArray(s.markets)||!finite(s.generatedAt))throw new Error('unexpected snapshot shape');
    out.snapshot=s;
  }catch(e){out.error=e.code==='ENOENT'?'snapshot file not found':e.message;}
  try{
    const s=JSON.parse(await readFile(path.join(sourceRoot,'data/predictions/state.json'),'utf8'));
    out.observations=Array.isArray(s.observations)?s.observations:[];out.settlements=s.settlements&&typeof s.settlements==='object'?s.settlements:{};
  }catch(e){out.stateError=e.code==='ENOENT'?'existing prediction state not found':e.message;}
  return out;
}
async function pool(items,size,work){let i=0;await Promise.all(Array.from({length:size},async()=>{while(i<items.length)await work(items[i++]);}));}

export async function runLab({root=repoRoot,sourceRoot=root,feed=createFeed(),clock=()=>Date.now()/1000,log=console,refreshSeconds=60,resolveLimit=30}={}){
  const p=labPaths(root);
  await mkdir(path.dirname(p.lock),{recursive:true});await mkdir(p.lock);
  try{
    const previous=await read(p.state);if(previous)validateLabState(previous);
    const t0=clock(),src=await readSource(sourceRoot),errors=[];
    if(src.stateError)errors.push({stage:'observations',message:`Existing calibration history unavailable (${src.stateError}); the shadow policy has no evidence to trade on.`});
    const sources=Object.fromEntries((src.snapshot?.sources||[]).map(s=>[s.venue,s]));
    const base={snapshotAt:src.snapshot?.generatedAt,snapshotError:src.error,sources};
    // Settlements: the existing collector's verified records first (read-only), then the public checks.
    const working=ensureBooks(previous,t0).state,settlements={},checked={};
    for(const need of settlementNeeds(working,t0)){const s=src.settlements[need.id];if(s)settlements[need.id]=s;}
    const toResolve=planResolution(working,t0,{limit:resolveLimit,skip:new Set(Object.keys(settlements))});
    await pool(toResolve,3,async need=>{
      try{const s=await feed.resolve(need.venue,need.venueId);if(s)settlements[need.id]=s;}
      catch(e){errors.push({venue:need.venue,stage:'settlement',message:`${need.id}: ${e.message}`});}
      checked[need.id]=clock();
    });
    // Refresh open positions first, then rule candidates, inside a fixed time budget.
    const plan=planRefresh(previous,src.snapshot?.markets||[],src.observations,t0,base);
    const fresh=new Map(),refreshFailures={},deadline=t0+refreshSeconds;
    await pool(plan.jobs,4,async job=>{
      if(clock()>deadline){refreshFailures[job.ref.id]='Refresh time budget reached; retried next run.';return;}
      try{fresh.set(job.ref.id,await feed.refresh(job.ref));}
      catch(e){refreshFailures[job.ref.id]=e.message;}
    });
    for(const [id,message] of Object.entries(refreshFailures))errors.push({venue:id.split(':')[0],stage:'refresh',message:`${id}: ${message}`});
    // The evaluation time belongs to the instant after every book was retrieved.
    const now=clock();
    const inputs={...base,markets:[...fresh.values()],snapshotMarkets:src.snapshot?.markets||[],observations:src.observations,settlements,checked,refreshFailures,errors,hash:sha256};
    const result=advanceLab(previous,inputs,now);
    const sourceRows=VENUES.map(venue=>({venue,...sourceStateFor(venue,inputs,now),retrieved:[...fresh.values()].filter(m=>m.venue===venue).length,
      refreshFailed:Object.keys(refreshFailures).filter(id=>id.startsWith(venue+':')).length}));
    await save(p.state,result.state);
    await save(p.snapshot,labSnapshot(result.state,{generatedAt:now,sources:sourceRows,errors:result.errors}));
    const summary={generatedAt:now,started:!previous,snapshotAgeSeconds:finite(base.snapshotAt)?Math.round(now-base.snapshotAt):null,sources:sourceRows,
      plan:{refreshJobs:plan.jobs.length,retrieved:fresh.size,failed:Object.keys(refreshFailures).length,screened:plan.screened,notes:plan.notes},settlementChecks:toResolve.length,
      books:result.receipt.books.map(b=>({book:b.bookId,venue:b.venue,status:b.status,eligible:b.eligible,opened:b.opened?.map(o=>({market:o.marketId,side:o.side,qty:o.quantity,cost:o.cost})),settled:b.settled?.length,open:b.open,equity:b.equity,message:b.message})),
      errors:result.errors.slice(0,8)};
    log.log(JSON.stringify(summary,null,2));
    return {published:true,state:result.state,summary,allSourcesFailed:sourceRows.every(s=>s.status==='error')};
  }finally{await rm(p.lock,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.env.MM_PREDLAB_ROOT?path.resolve(process.env.MM_PREDLAB_ROOT):repoRoot;
  const sourceRoot=process.env.MM_PREDLAB_SOURCE_ROOT?path.resolve(process.env.MM_PREDLAB_SOURCE_ROOT):root;
  const result=await runLab({root,sourceRoot});
  if(result.allSourcesFailed)process.exitCode=1;
}
