// Advances the isolated paper Strategy Lab. Public data only; never reads
// credentials, never submits an order, and never touches the eleven-account
// tournament, the BTC/ETH trend mirror, or the private Coinbase worker.
// Run directly for a scheduled cycle; runLab() takes an injectable root so
// tests and dry runs never write into the repository's real state.
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {advanceLab,validateLab,labSnapshot} from '../dashboard/crypto-lab-core.mjs';
import {collectLabInputs} from './crypto-lab-feed.mjs';

export const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const labPaths=root=>({state:path.join(root,'data/crypto-lab/state.json'),snapshot:path.join(root,'dashboard/data/crypto-lab.json'),lock:path.join(root,'data/crypto-lab/.collector.lock')});

async function read(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error(`Unreadable ${path.basename(file)}; no paper book reset`,{cause:e});}}
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}

export async function runLab({root=repoRoot,collect=collectLabInputs,clock=()=>Date.now()/1000,log=console}={}){
  const p=labPaths(root);
  await mkdir(path.dirname(p.lock),{recursive:true});await mkdir(p.lock);
  try{
    const previous=await read(p.state);if(previous)validateLab(previous);
    const feed=await collect();
    // The evaluation time belongs to the instant after collection.
    const now=clock();
    if(!feed.usable){
      // Never replace a good snapshot with a cycle in which every read failed.
      log.error(JSON.stringify({published:false,reason:'Every public source failed; the last snapshot is retained unchanged',errors:feed.errors},null,2));
      return {published:false,errors:feed.errors};
    }
    const state=advanceLab(previous,feed.inputs,now);
    if(previous&&state.updatedAt===previous.updatedAt){log.log('No newer evaluation time; nothing written.');return {published:false,state};}
    await save(p.state,state);await save(p.snapshot,labSnapshot(state,{generatedAt:now,requests:feed.requests}));
    log.log(JSON.stringify({policy:state.policyId,generatedAt:now,started:!previous,
      books:state.books.map(b=>({id:b.id,equity:b.account.equity,open:b.account.positions.map(x=>x.product),closed:b.account.trades.length,benchmark:b.benchmark.equity,
        signals:b.signals.map(x=>({product:x.product,status:x.status,action:x.action,close:x.close,retained:x.retained})),decisions:b.decisions})),errors:state.errors},null,2));
    return {published:true,state};
  }finally{await rm(p.lock,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // MM_LAB_ROOT redirects a dry run; the scheduled workflow leaves it unset.
  const result=await runLab({root:process.env.MM_LAB_ROOT?path.resolve(process.env.MM_LAB_ROOT):repoRoot});
  if(!result.published&&!result.state)process.exitCode=1;
}
