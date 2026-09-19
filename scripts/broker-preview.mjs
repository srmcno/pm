import {readFile} from 'node:fs/promises';
import {CoinbasePreview} from './execution/coinbase.mjs';
import {EXECUTION_VERSION,assessReadiness} from '../dashboard/execution-readiness.mjs';
import {STRATEGIES,validCompetitionSnapshot} from '../dashboard/crypto-strategies-core.mjs';
export function validateProfile(p){
 if(p?.version!==EXECUTION_VERSION||p.venue!=='coinbase'||p.country!=='US'||p.state!=='OK'||p.mode!=='preview'||p.liveEnabled!==false||p.allowLeverage!==false||p.allowShorting!==false||!STRATEGIES.some(s=>s.id===p.strategyId)||![p.budgetUsd,p.maxOrderUsd].every(Number.isFinite)||p.maxOrderUsd<=0||p.maxOrderUsd>p.budgetUsd||p.budgetUsd>1000||!Array.isArray(p.products)||!p.products.length||p.products.some(x=>!['BTC-USD','ETH-USD','SOL-USD'].includes(x)))throw Error('Invalid or armed setup profile. Only bounded USD spot previews are supported.');return p;
}
async function main(){
 const filename=process.argv[2];if(!filename||process.argv.includes('--help')){console.log('Usage: node scripts/broker-preview.mjs <downloaded-profile.json> [--connect]\nDefault: offline evidence and setup check. --connect reads account fees and previews one bounded spot order; it never submits. Supply COINBASE_KEY_NAME and COINBASE_PRIVATE_KEY through a private environment, never this website.');return;}
 const p=validateProfile(JSON.parse(await readFile(filename,'utf8')));
 const s=JSON.parse(await readFile(new URL('../dashboard/data/crypto-strategies.json',import.meta.url),'utf8'));if(!validCompetitionSnapshot(s))throw Error('Saved strategy snapshot is invalid.');
 const readiness=assessReadiness(s.accounts[p.strategyId]);
 const report={mode:'preview',orderSubmitted:false,strategy:p.strategyId,evidence:readiness,credentialsPresent:!!process.env.COINBASE_KEY_NAME&&!!process.env.COINBASE_PRIVATE_KEY,
  remaining:['Account and asset eligibility confirmation','Funding and withdrawal route costs','Broker-paper execution and recovery verification','Private persistent real execution service with order/position reconciliation and exits']};
 if(process.argv.includes('--connect')){const broker=new CoinbasePreview({keyName:process.env.COINBASE_KEY_NAME,privateKey:process.env.COINBASE_PRIVATE_KEY});report.fees=await broker.fees();report.preview=await broker.preview(p.products[0],p.maxOrderUsd,report.fees.takerRate);}
 console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])main().catch(e=>{console.error(e.message);process.exitCode=1;});
