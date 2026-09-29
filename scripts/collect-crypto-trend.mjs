// Advances the isolated BTC/ETH daily trend paper mirror. Public data only;
// never reads credentials, never submits an order, never touches the
// eleven-account tournament state.
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {advanceTrendBook,validateTrendBook,trendSnapshot} from '../dashboard/crypto-trend-core.mjs';
import {collectTrendInputs} from './crypto-trend-feed.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const statePath=path.join(root,'data/crypto-trend/state.json');
const snapshotPath=path.join(root,'dashboard/data/crypto-trend.json');
const lock=path.join(root,'data/crypto-trend/.collector.lock');
async function read(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error(`Unreadable ${path.basename(file)}; no paper book reset`,{cause:e});}}
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}
await mkdir(path.dirname(lock),{recursive:true});await mkdir(lock);
try{
  const previous=await read(statePath);if(previous)validateTrendBook(previous);
  const feed=await collectTrendInputs();
  // The evaluation time belongs to the instant after collection.
  const now=Date.now()/1000;
  if(!feed.usable){
    // Never replace a good snapshot with a cycle in which every read failed.
    console.error(JSON.stringify({published:false,reason:'Every public source failed; the last snapshot is retained unchanged',errors:feed.errors},null,2));
    process.exitCode=1;
  }else{
    const state=advanceTrendBook(previous,feed.inputs,now);
    if(previous&&state.updatedAt===previous.updatedAt)console.log('No newer evaluation time; nothing written.');
    else{await save(statePath,state);await save(snapshotPath,trendSnapshot(state,{generatedAt:now,requests:feed.requests}));}
    console.log(JSON.stringify({policy:state.policyId,generatedAt:now,equity:state.account.equity,cash:state.account.cash,
      positions:state.account.positions.map(p=>({product:p.product,quantity:p.quantity,cost:p.cost,markValue:p.markValue})),trades:state.account.trades.length,
      benchmark:state.benchmark?.equity??null,signals:state.signals.map(x=>({product:x.product,status:x.status,action:x.action,close:x.close,sma:x.sma,retained:x.retained})),
      decisions:state.decisions,errors:state.errors},null,2));
  }
}finally{await rm(lock,{recursive:true,force:true});}
