import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'dist');
const files=[
 'index.html','app.css','app.mjs','app-schema.mjs','copy-core.mjs','copy-trading.mjs',
 'crypto-arbitrage-core.mjs','crypto-arbitrage.mjs','trading-ui.mjs','trading-schema.mjs',
 'data-client.mjs','prediction-core.mjs','prediction-entry.mjs',
 'focus.html','focus.css','focus.mjs','focus-model.mjs','deco.css','site-health.mjs','readiness.html','readiness-ui.mjs','execution-readiness.mjs',
 'crypto.html','crypto-strategies-core.mjs','crypto-strategies-ui.mjs','crypto-strategies.css','execution-estimate.mjs',
 'etf-schema.mjs','etf-transactions.csv','favicon.svg','favicon.png','_headers',
 'desk.html','legacy.css','archive.css','etf.html','stocks.html','arb.html','wallets.html',
 ...['predictions','etf-paper','etf-research','research-summary','desk','copy-trading',
 'copy-study','crypto-arbitrage','crypto-history','opportunities'].map(n=>`data/${n}.json`),
];
await rm(output,{recursive:true,force:true});
await mkdir(path.join(output,'data'),{recursive:true});
for(const file of files)await cp(path.join(root,'dashboard',file),path.join(output,file));
// A source deployment may precede the first scheduled strategy cycle. Do not
// fabricate funded accounts or make that normal rollout a build failure.
try{await cp(path.join(root,'dashboard/data/crypto-strategies.json'),path.join(output,'data/crypto-strategies.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const archive=await readFile(path.join(root,'dashboard/index.html'),'utf8');
await writeFile(path.join(output,'archive-workspace.html'),archive.replace('<body>',
 '<body><div style="padding:12px 24px;display:flex;gap:20px;justify-content:space-between;border-bottom:1px solid var(--border,#dce3eb)"><a href="./">Back to main app</a><span>Advanced tools and archive</span></div>'));
await cp(path.join(root,'dashboard/focus.html'),path.join(output,'index.html'));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
// Interface identity excludes collector snapshots. Frequent data commits must
// not reload an open dashboard, but code changes must invalidate module caches.
const assets=files.filter(file=>/\.(html|css|mjs|svg|png)$/.test(file));
const hash=createHash('sha256').update(version);
for(const file of assets)hash.update(file).update(await readFile(path.join(root,'dashboard',file)));
const interfaceRevision=hash.digest('hex').slice(0,20);
for(const file of [...assets,'archive-workspace.html']){
 if(!/\.(html|mjs)$/.test(file))continue;
 let source=await readFile(path.join(output,file),'utf8');
 if(file.endsWith('.html'))source=source.replace('</head>',`<meta name="mm-release" content="${interfaceRevision}"></head>`)
  .replace(/((?:src|href)=["'])([a-zA-Z0-9./_-]+\.(?:mjs|css))(?:\?[^"']*)?(["'])/g,`$1$2?v=${interfaceRevision}$3`);
 else source=source.replace(/(from\s*["'])(\.\/[a-zA-Z0-9_-]+\.mjs)(?:\?[^"']*)?(["'])/g,`$1$2?v=${interfaceRevision}$3`);
 await writeFile(path.join(output,file),source);
}
await writeFile(path.join(output,'build-info.json'),JSON.stringify({version,interfaceRevision,commit,builtAt:new Date().toISOString()}));
console.log('Built Moffitt Money prediction, crypto, activity and archive pages.');
