import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'dist');
// Explicit public allowlist. The focused entry is the published root; the
// original workspace remains available as a separate archive/tools surface.
const files=[
 'index.html','app.css','app.mjs','app-schema.mjs','copy-core.mjs','copy-trading.mjs',
 'crypto-arbitrage-core.mjs','crypto-arbitrage.mjs','trading-ui.mjs','trading-schema.mjs',
 'data-client.mjs','prediction-core.mjs','prediction-entry.mjs',
 'focus.html','focus.css','focus.mjs','focus-model.mjs',
 'etf-schema.mjs','etf-transactions.csv','favicon.svg','favicon.png','_headers',
 'desk.html','legacy.css','archive.css','etf.html','stocks.html','arb.html','wallets.html',
 ...['predictions','etf-paper','etf-research','research-summary','desk','copy-trading',
 'copy-study','crypto-arbitrage','crypto-history','opportunities'].map(n=>`data/${n}.json`),
];
await rm(output,{recursive:true,force:true});
await mkdir(path.join(output,'data'),{recursive:true});
for(const file of files)await cp(path.join(root,'dashboard',file),path.join(output,file));
const archive=await readFile(path.join(root,'dashboard/index.html'),'utf8');
await writeFile(path.join(output,'archive-workspace.html'),archive.replace('<body>',
 '<body><div style="padding:12px 24px;display:flex;gap:20px;justify-content:space-between;border-bottom:1px solid var(--border,#dce3eb)"><a href="./">Back to main app</a><span>Advanced tools and archive</span></div>'));
await cp(path.join(root,'dashboard/focus.html'),path.join(output,'index.html'));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(output,'build-info.json'),JSON.stringify({version,commit,builtAt:new Date().toISOString()}));
console.log('Built Moffitt Money focused main app and preserved archive.');
