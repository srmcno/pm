import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {advanceCompetition,migrateCompetition,validateCompetition,STRATEGIES,POLICY,FEE_PROFILE,performance} from '../dashboard/crypto-strategies-core.mjs';
import {collectCoinbaseMarkets} from './crypto-feed.mjs';
import {collectAndAdvance} from './crypto-cycle.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const statePath=path.join(root,'data/crypto-strategies/state.json');
const snapshotPath=path.join(root,'dashboard/data/crypto-strategies.json');
const lock=path.join(root,'data/crypto-strategies/.collector.lock');
async function read(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error(`Unreadable ${path.basename(file)}; no account reset`,{cause:e});}}
async function save(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(value)+'\n');await rename(temp,file);}
await mkdir(path.dirname(lock),{recursive:true});await mkdir(lock);
try{
  const rawPrevious=await read(statePath,null),startedAt=Date.now()/1000;
  const previous=rawPrevious?migrateCompetition(rawPrevious,startedAt):null;if(previous)validateCompetition(previous);
  const old=await read(snapshotPath,null),legacy=await read(path.join(root,'dashboard/data/opportunities.json'),null);
  const cached=old?.feedCache||legacy?.markets||[];
  const requiredProducts=previous?Object.values(previous.accounts).flatMap(a=>a.positions.map(p=>p.product)):[];
  const {feed,now,state}=await collectAndAdvance(previous,{cached,requiredProducts,maxMarkets:40,preselect:52},collectCoinbaseMarkets);
  const legacyAccount=legacy?.paper;
  const retired=(legacyAccount?.entryPolicy?.strategies||[]).map(s=>({id:s.id,name:s.name,status:'retired',retiredAt:legacyAccount.retirement?.at||null,
    replay:{returnPct:s.returnPct,trades:s.trades,net:s.stats?.net,profitFactor:s.profitFactor},forward:performance((legacyAccount.closed||[]).filter(t=>t.strategy.toLowerCase()===s.name.toLowerCase())),
    reason:s.id==='reclaim'?'Retired at owner request after observed losses. Its replay sample is too small to establish persistent failure.':'Retired legacy model after negative replay and observed paper losses.',
    source:'data/opportunities/paper.json',reportAt:legacyAccount.entryPolicy?.reportAt||null}));
  const snapshot={...state,generatedAt:now,venue:'Coinbase Exchange public books / Coinbase Advanced U.S. fee model',policy:POLICY,feeProfile:FEE_PROFILE,strategies:STRATEGIES,
    universe:feed.universe,errors:feed.errors,feedCache:feed.markets,retired,
    legacyAccount:legacyAccount?{initialCapital:legacyAccount.start,cash:legacyAccount.cash,equity:legacyAccount.equity,closed:legacyAccount.closed?.length||0,open:legacyAccount.positions?.length||0}:null,
    execution:{mode:'paper',realEnabled:false,credentialsConnected:false,shorting:false,leverage:false,transferFeesModeled:false},
    notes:[
      'Eleven independent $1,000 synthetic research bankrolls. Existing rotation/recovery ledgers were migrated without a reset.',
      'Long-only spot: falling-price signals exit positions or hold cash. No leverage, borrowing, funding rate or pretend spot shorting.',
      'Active fills use the U.S. Coinbase Advanced entry-level 0.90% taker fee announced 2026-09-16, plus actual walked spread/depth and 0.10% extra adverse slippage per side.',
      'The 0.50% maker rate is recorded for reference but not credited because these strategies do not model post-only fill probability.',
      'Network/withdrawal fees are not charged because the paper model never transfers assets on-chain.',
      'Scheduled scans, not continuous exchange execution. All exits use observed books, never fabricated fills at missed stop prices.'
    ]};
  await save(statePath,state);await save(snapshotPath,snapshot);
  console.log(JSON.stringify({version:state.version,generatedAt:now,feeProfile:FEE_PROFILE.id,universe:feed.universe,
    accounts:Object.fromEntries(Object.entries(state.accounts).map(([id,a])=>[id,{status:a.status,equity:a.equity,cash:a.cash,positions:a.positions.length,trades:a.trades.length,pending:Object.keys(a.pending).length}])),
    cycle:state.cycles.at(-1),errors:feed.errors.slice(0,12)},null,2));
  if(!state.markets.some(m=>m.status==='ready'))process.exitCode=1;
}finally{await rm(lock,{recursive:true,force:true});}
