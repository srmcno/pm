import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configuration} from './config.mjs';
import {CoinbaseLive} from './coinbase.mjs';
import {Engine} from './engine.mjs';
import {D,S} from './risk.mjs';

// Do not construct Journal here: its lifetime lock and writable connection
// belong exclusively to the worker. Read one consistent existing snapshot.
export function loadRecoveryState(databasePath,{Database=DatabaseSync}={}){
 let db;
 try{
  db=new Database(databasePath,{readOnly:true});
  db.exec('PRAGMA query_only=ON; BEGIN');
  if(db.prepare('PRAGMA user_version').get().user_version!==1||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Invalid journal');
  const rows=db.prepare('SELECT id, revision, data FROM state').all();
  const audit=db.prepare('SELECT COUNT(*) AS count, MAX(revision) AS revision FROM events').get();
  if(rows.length!==1||rows[0].id!==1||!Number.isSafeInteger(rows[0].revision)||rows[0].revision<1||rows[0].revision!==audit.count||rows[0].revision!==audit.revision)throw Error('Invalid history');
  const state=JSON.parse(rows[0].data);
  if(!state||typeof state!=='object'||Array.isArray(state))throw Error('Invalid state');
  return state;
 }finally{db?.close();}
}

// Dependencies permit synthetic tests without broker access or filesystem writes.
// No tick, recovery application, order submission, cancellation or conversion.
export async function checkRecovery(env=process.env,dependencies={}){
 const base={event:'projection_recovery_check',readOnly:true,eligible:false};
 try{
  const config=configuration({...env,MM_MODE:'preview'});
  if(!config.credentials)throw Error('Credentials required');
  const state=await (dependencies.loadState||loadRecoveryState)(path.join(config.dataDir,'execution','state.sqlite'));
  if(!state)throw Error('Existing state required');
  const journal=Object.freeze({load:()=>structuredClone(state),save:()=>{throw Error('Recovery checker cannot persist state');}});
  const broker=await (dependencies.createBroker||(credentials=>new CoinbaseLive(credentials)))({...config.credentials,allowSubmit:false});
  const engine=await (dependencies.createEngine||(options=>new Engine(options)))({broker,journal,config:{...config.engine,mode:'preview'}});
  const result=await engine.inspectProjectionRecovery();
  if(result?.eligible!==true||result.protectionStatus!=='OPEN'||typeof result.token!=='string'||!/^projection-v1-[a-f0-9]{64}$/.test(result.token)||typeof result.product!=='string'||!/^[A-Z0-9][A-Z0-9.-]{0,20}-USD$/.test(result.product)||D(result.quantity)<=0n)throw Error('Invalid recovery evidence');
  return {...base,eligible:true,product:result.product,quantity:S(D(result.quantity)),protectionStatus:'OPEN',MM_RECOVER_PROJECTION_ACK:result.token,
   message:'Inspection only; no state or orders changed. The operator may set this acknowledgement and redeploy. Recovery rechecks fresh evidence before saving.'};
 }catch{
  return {...base,message:'Recovery eligibility could not be verified. State and orders are unchanged. Check private configuration, preserved journal and current broker protection; no acknowledgement issued.'};
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.error(JSON.stringify({event:'projection_recovery_check',readOnly:true,eligible:false,message:'This checker accepts no arguments and cannot apply recovery.'}));process.exitCode=1;}
 else{const result=await checkRecovery();console.log(JSON.stringify(result));if(!result.eligible)process.exitCode=1;}
}
