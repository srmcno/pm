import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {advanceCompetition,validateCompetition,STRATEGIES,POLICY,performance} from '../dashboard/crypto-strategies-core.mjs';
import {collectCoinbaseMarkets} from './crypto-feed.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const statePath=path.join(root,'data/crypto-strategies/state.json');
const snapshotPath=path.join(root,'dashboard/data/crypto-strategies.json');
const lock=path.join(root,'data/crypto-strategies/.collector.lock');
async function read(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error(`Unreadable ${path.basename(file)}; no account reset`,{cause:e});}}
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}
await mkdir(path.dirname(lock),{recursive:true});await mkdir(lock);
try{
  const previous=await read(statePath,null);if(previous)validateCompetition(previous);
  const old=await read(snapshotPath,null);
  const legacy=await read(path.join(root,'dashboard/data/opportunities.json'),null);
  const cached=old?.feedCache||legacy?.markets||[];
  const feed=await collectCoinbaseMarkets({cached});
  const now=Date.now()/1000;
  const state=advanceCompetition(previous,feed.markets,now);
  const legacyAccount=legacy?.paper;
  const retired=(legacyAccount?.entryPolicy?.strategies||[]).map(s=>({id:s.id,name:s.name,status:'retired',
    retiredAt:legacyAccount.retirement?.at||null,replay:{returnPct:s.returnPct,trades:s.trades,net:s.stats?.net,profitFactor:s.profitFactor},
    forward:performance((legacyAccount.closed||[]).filter(t=>t.strategy.toLowerCase()===s.name.toLowerCase())),
    reason:s.id==='reclaim'?'Retired at owner request after observed losses. Its replay sample is too small to establish persistent failure.':'Retired legacy model after negative replay and observed paper losses.',
    source:'data/opportunities/paper.json',reportAt:legacyAccount.entryPolicy?.reportAt||null}));
  const snapshot={...state,generatedAt:now,venue:'Coinbase Exchange',policy:POLICY,strategies:STRATEGIES,
    errors:feed.errors,feedCache:feed.markets,retired,
    legacyAccount:legacyAccount?{initialCapital:legacyAccount.start,cash:legacyAccount.cash,equity:legacyAccount.equity,closed:legacyAccount.closed?.length||0,open:legacyAccount.positions?.length||0}:null,
    execution:{mode:'paper',realEnabled:false,credentialsConnected:false,shorting:false},
    notes:['Independent $1,000 synthetic research bankrolls, not a reset of previous losses.','Long-only spot: falling-price signals exit positions or hold cash. No leverage or pretend spot shorting.','0.60% per-side fees and 0.10% per-side slippage are explicit model assumptions, not verified account fees.','Scheduled scans, not continuous exchange execution. All exits use observed books, not fabricated fills at missed stop prices.']};
  await save(statePath,state);await save(snapshotPath,snapshot);
  console.log(JSON.stringify({version:state.version,generatedAt:now,markets:state.markets.map(m=>({product:m.product,status:m.status})),cycle:state.cycles.at(-1),retired,errors:feed.errors},null,2));
  if(feed.errors.length===feed.markets.length)process.exitCode=1;
}finally{await rm(lock,{recursive:true,force:true});}
