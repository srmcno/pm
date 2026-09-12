import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {replay} from './backtest.research.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data=JSON.parse(gunzipSync(await readFile(root+'/data/opportunities/backtest-inputs.json.gz')));
const original=JSON.parse(await readFile(root+'/dashboard/data/scanner-backtest.json'));
const prereg=JSON.parse(await readFile(new URL('./predeclared-variants.json',import.meta.url)));
const day=86400;
const windows=[['Full 90 days',{}],['First 30 days',{end:data.start+30*day}],['Middle 30 days',{start:data.start+30*day,end:data.start+60*day}],['Last 30 days',{start:data.start+60*day}]];
const variants=[{id:'baseline',changes:{}},...prereg.variants];
const results=[];
for(const variant of variants){
 for(const [window,span] of windows){
  const started=Date.now();
  const run=replay(data,{...span,...variant.changes});
  const result={variant:variant.id,window,...run};
  results.push(result);
  await writeFile(new URL('./results.json',import.meta.url),JSON.stringify({prereg,results},null,2)+'\n');
  console.log(JSON.stringify({...result,curve:undefined,ledger:undefined,elapsedMs:Date.now()-started}));
  if(variant.id==='baseline'){
   const name=window==='Full 90 days'?'Combined · 90 days':window;
   const expected=original.runs.find(x=>x.name===name);
   if(expected.returnPct!==run.returnPct || JSON.stringify(expected.ledger)!==JSON.stringify(run.ledger))throw new Error('Baseline does not match existing report: '+window);
  }
 }
}
