import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {checkRecovery,loadRecoveryState} from '../scripts/live/check-recovery.mjs';

const token='projection-v1-'+'a'.repeat(64);
const evidence={eligible:true,token,product:'ABC-USD',quantity:'0.500',protectionStatus:'OPEN'};
const env={MM_DATA_DIR:'/synthetic',MM_MODE:'live',COINBASE_KEY_NAME:'SYNTHETIC_KEY_NAME',COINBASE_PRIVATE_KEY:'SYNTHETIC_PRIVATE_KEY',COINBASE_PORTFOLIO_ID:'SYNTHETIC_PORTFOLIO'};
function directory(t){const dir=mkdtempSync(join(tmpdir(),'pm-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function database(t,mutate=()=>{}){
 const dir=directory(t),file=join(dir,'state.sqlite'),db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA user_version=1; CREATE TABLE state(id INTEGER,revision INTEGER,data TEXT); CREATE TABLE events(revision INTEGER);');
  db.prepare('INSERT INTO state VALUES(1,1,?)').run(JSON.stringify({private:'SYNTHETIC_ORDER_ID'}));db.exec('INSERT INTO events VALUES(1)');mutate(db);
 }finally{db.close();}
 return {dir,file};
}
function dependencies(overrides={}){
 return {loadState:()=>({private:'SYNTHETIC_ORDER_ID'}),createBroker:()=>({allowSubmit:false}),
  createEngine:()=>({inspectProjectionRecovery:async()=>evidence}),...overrides};
}
function assertHeld(result){assert.equal(result.eligible,false);assert.equal(result.readOnly,true);assert.equal(result.MM_RECOVER_PROJECTION_ACK,undefined);}

test('recovery database opens read-only, enforces query-only and closes without changing files',t=>{
 const {dir,file}=database(t),before=readFileSync(file),files=readdirSync(dir);let closed=false;
 class ObservedDatabase{
  constructor(filename,options){assert.equal(filename,file);assert.deepEqual(options,{readOnly:true});this.db=new DatabaseSync(filename,options);}
  exec(sql){
   assert.equal(sql,'PRAGMA query_only=ON; BEGIN');this.db.exec(sql);
   assert.equal(this.db.prepare('PRAGMA query_only').get().query_only,1);
   assert.throws(()=>this.db.exec('DELETE FROM state'),/readonly/i);
  }
  prepare(sql){assert.match(sql,/^(SELECT|PRAGMA) /);return this.db.prepare(sql);}
  close(){this.db.close();closed=true;}
 }
 assert.deepEqual(loadRecoveryState(file,{Database:ObservedDatabase}),{private:'SYNTHETIC_ORDER_ID'});
 assert.equal(closed,true);assert.deepEqual(readFileSync(file),before);assert.deepEqual(readdirSync(dir),files);
});

test('malformed schema, state and audit histories fail closed without repair',t=>{
 const mutations=[
  db=>db.exec('PRAGMA user_version=2'),db=>db.exec('DELETE FROM state'),db=>db.exec('INSERT INTO state SELECT * FROM state'),
  db=>db.exec('UPDATE state SET id=2'),db=>db.exec('UPDATE state SET revision=0'),db=>db.exec('UPDATE state SET revision=9007199254740992'),
  db=>db.exec("UPDATE state SET data='not-json'"),db=>db.exec("UPDATE state SET data='null'"),db=>db.exec("UPDATE state SET data='[]'"),
  db=>db.exec('DELETE FROM events'),db=>db.exec('UPDATE events SET revision=2'),db=>db.exec('INSERT INTO events VALUES(1)'),
 ];
 for(const mutate of mutations){const {file}=database(t,mutate),before=readFileSync(file);assert.throws(()=>loadRecoveryState(file));assert.deepEqual(readFileSync(file),before);}
 const dir=directory(t),missing=join(dir,'missing.sqlite');assert.throws(()=>loadRecoveryState(missing));assert.equal(existsSync(missing),false);
 const corrupt=join(dir,'corrupt.sqlite');writeFileSync(corrupt,'not a SQLite database');assert.throws(()=>loadRecoveryState(corrupt));assert.equal(readFileSync(corrupt,'utf8'),'not a SQLite database');
});

test('failed database inspection still closes its connection',t=>{
 const {file}=database(t,db=>db.exec('DELETE FROM events'));let closed=false;
 class ObservedDatabase{constructor(filename,options){this.db=new DatabaseSync(filename,options);}exec(sql){return this.db.exec(sql);}prepare(sql){return this.db.prepare(sql);}close(){closed=true;this.db.close();}}
 assert.throws(()=>loadRecoveryState(file,{Database:ObservedDatabase}));assert.equal(closed,true);
});

test('inspection forces preview and disabled submissions with an immutable journal and no execution calls',async()=>{
 const calls=[],state={private:{order:'SYNTHETIC_ORDER_ID'}},forbidden=name=>()=>{calls.push(name);throw Error('Forbidden call');};
 const result=await checkRecovery(env,dependencies({
  loadState:file=>{assert.equal(file,'/synthetic/execution/state.sqlite');return state;},
  createBroker:credentials=>{assert.equal(credentials.allowSubmit,false);return {allowSubmit:false,create:forbidden('create'),cancel:forbidden('cancel'),convert:forbidden('convert')};},
  createEngine:({broker,journal,config})=>{
   assert.equal(config.mode,'preview');assert.equal(broker.allowSubmit,false);assert.equal(Object.isFrozen(journal),true);
   assert.throws(()=>journal.save({}),/cannot persist/);
   journal.load().private.order='changed';assert.equal(journal.load().private.order,'SYNTHETIC_ORDER_ID');
   return {inspectProjectionRecovery:async()=>{calls.push('inspect');return evidence;},tick:forbidden('tick'),recoverProjectionHold:forbidden('recover')};
  },
 }));
 assert.equal(result.eligible,true);assert.deepEqual(calls,['inspect']);assert.equal(state.private.order,'SYNTHETIC_ORDER_ID');
});

test('successful inspection publishes only the approved summary and scoped acknowledgement',async()=>{
 const result=await checkRecovery(env,dependencies({createEngine:()=>({inspectProjectionRecovery:async()=>({...evidence,accountId:'PRIVATE_ACCOUNT',orderId:'PRIVATE_ORDER',raw:{key:'PRIVATE_KEY'},balance:'99999'})})}));
 assert.deepEqual(Object.keys(result).sort(),['event','readOnly','eligible','product','quantity','protectionStatus','MM_RECOVER_PROJECTION_ACK','message'].sort());
 assert.equal(result.MM_RECOVER_PROJECTION_ACK,token);assert.equal(result.quantity,'0.5');
 for(const secret of ['PRIVATE_ACCOUNT','PRIVATE_ORDER','PRIVATE_KEY','99999',...Object.values(env).filter(v=>v.startsWith('SYNTHETIC_'))])assert.ok(!JSON.stringify(result).includes(secret));
});

test('missing credentials and missing state stop before broker construction',async()=>{
 for(const input of [{},{MM_DATA_DIR:'/synthetic'},{...env,COINBASE_PRIVATE_KEY:''}]){
  let calls=0;assertHeld(await checkRecovery(input,dependencies({loadState:()=>{calls++;return {};},createBroker:()=>{calls++;return {};}})));assert.equal(calls,0);
 }
 let brokers=0;assertHeld(await checkRecovery(env,dependencies({loadState:()=>null,createBroker:()=>{brokers++;return {};}})));assert.equal(brokers,0);
});

test('malformed or incomplete recovery evidence never emits a token',async()=>{
 for(const result of [null,{},...[
  {eligible:false},{protectionStatus:'FILLED'},{token:'invalid'},{token:token+'\nsecret'},{product:'ABC-USDC'},
  {product:'ABC-USD\nsecret'},{quantity:'0'},{quantity:'-1'},{quantity:'NaN'},
 ].map(patch=>({...evidence,...patch}))]){
  assertHeld(await checkRecovery(env,dependencies({createEngine:()=>({inspectProjectionRecovery:async()=>result})})));
 }
});

test('private errors from loading, broker setup, engine setup and inspection are redacted',async()=>{
 for(const stage of ['loadState','createBroker','createEngine','inspect']){
  const failure=()=>{throw Error('SECRET_RESPONSE PRIVATE_ACCOUNT KEY_MATERIAL');};
  const deps=dependencies(stage==='inspect'?{createEngine:()=>({inspectProjectionRecovery:failure})}:{[stage]:failure});
  const result=await checkRecovery(env,deps);assertHeld(result);assert.ok(!JSON.stringify(result).includes('SECRET_RESPONSE'));assert.ok(!JSON.stringify(result).includes('PRIVATE_ACCOUNT'));assert.ok(!JSON.stringify(result).includes('KEY_MATERIAL'));
 }
});

function cliResponse(output){
 const lines=output.split(/\r?\n/).filter(line=>line.trim()),responses=lines.filter(line=>line.startsWith('{'));
 assert.equal(responses.length,1,'CLI must emit exactly one JSON response');
 let warning=false;
 for(const line of lines){
  if(line.startsWith('{'))continue;
  if(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/.test(line)){warning=true;continue;}
  assert.ok(warning&&(/^(?:\(Use .*--trace-warnings.*\)|\s+at .+)$/.test(line)),`Unexpected CLI output: ${line}`);
 }
 return JSON.parse(responses[0]);
}

test('CLI rejects apply arguments and fails safely without credentials, including SQLite runtime warnings',()=>{
 const cli=fileURLToPath(new URL('../scripts/live/check-recovery.mjs',import.meta.url));
 // Emit a real Node warning even on versions that no longer warn for SQLite.
 const warningModule='data:text/javascript,'+encodeURIComponent("process.emitWarning('SQLite is an experimental feature and might change at any time','ExperimentalWarning');");
 for(const runtime of [[],['--import',warningModule],['--trace-warnings','--import',warningModule]]){
  for(const args of [['--apply'],['--apply',token],['unexpected']]){
   const child=spawnSync(process.execPath,[...runtime,cli,...args],{env:{},encoding:'utf8'});
   assert.equal(child.status,1);assert.equal(child.stdout,'');const result=cliResponse(child.stderr);assertHeld(result);assert.match(result.message,/accepts no arguments/);
   assert.ok(!child.stderr.includes(token));assert.ok(!child.stderr.includes('SYNTHETIC_PRIVATE_KEY'));
  }
  const child=spawnSync(process.execPath,[...runtime,cli],{env:{},encoding:'utf8'});
  assert.equal(child.status,1);assertHeld(cliResponse(child.stdout+'\n'+child.stderr));
 }
 assert.throws(()=>cliResponse('{}\n{}\n'),/exactly one/);
 assert.throws(()=>cliResponse('{}\nPRIVATE_RESPONSE\n'),/Unexpected CLI output/);
});
