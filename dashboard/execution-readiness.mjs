// Shared by the public readiness view and the private execution preflight.
export const EXECUTION_VERSION='2026-09-19-oklahoma-v1';
export const PLATFORMS=Object.freeze([
 {id:'coinbase',name:'Coinbase Advanced',state:'Spot candidate',detail:'Oklahoma license listed. Account approval, asset permissions and your actual fee tier must be verified. Exchange public books are research inputs, not proof of Advanced execution.',url:'https://www.coinbase.com/legal/licenses',fees:'Paper: 0.90% taker per side + 0.10% adverse slippage, plus walked spread/depth. Actual Advanced fees come from your account and preview.',feeUrl:'https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees'},
 {id:'kraken',name:'Kraken Pro',state:'Spot research',detail:'Oklahoma is not on the current excluded-state list. Individual assets and account approval still apply. US customers cannot use xStocks.',url:'https://support.kraken.com/articles/where-is-kraken-licensed-or-regulated',fees:'Ordinary base spot tier: 0.40% maker / 0.80% taker. ACH free; debit funding $0.25 + 3.75%; withdrawal route and network costs vary.',feeUrl:'https://www.kraken.com/features/fee-schedule'},
 {id:'alpaca',name:'Alpaca',state:'Broker-paper integration',detail:'US equity/ETF brokerage subject to account approval. Existing broker-paper integration has a separate ledger. The ETF study is on an accounting reconciliation hold.',url:'https://docs.alpaca.markets/docs/paper-trading',fees:'Retail equities: no ordinary commission. SEC sell 0.00206%; TAF $0.000195/share (max $9.79); CAT $0.000003/share. Daily per-type rounding applies.',feeUrl:'https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf'},
 {id:'kalshi',name:'Kalshi',state:'Conditional · paper research',detail:'Sports are not cleared for real-money promotion in Oklahoma. Non-sports products need current account and product eligibility verification.',url:'https://oklahoma.gov/oag/news/newsroom/2026/may/drummond-urges-cftc-to-recognize-state-authority-over-sports-gambling-on-prediction-market-platforms.html',fees:'General taker coefficient 0.07 × contracts × p × (1−p), with series multipliers. Maker schedules and account rounding differ. ACH free; cards up to 2%.',feeUrl:'https://kalshi.com/docs/kalshi-fee-schedule.pdf'},
 {id:'polymarket-us',name:'Polymarket US',state:'Conditional · paper research',detail:'Separate from international Polymarket. US account approval and Oklahoma product access remain unverified. Sports are research-only in this execution plan.',url:'https://docs.polymarket.us/getting-started/quickstart',fees:'Since September 17: taker coefficient 0.0695 × contracts × p × (1−p); maker rebate coefficient −0.0125. Paper uses conservative per-level fee rounding, not assumed rebates.',feeUrl:'https://docs.polymarket.us/fees'},
]);
const finite=Number.isFinite;
export function fundingHurdle({capital,entryRate,exitRate,slippageRate,fundingCost,withdrawalCost}){
 if(![capital,entryRate,exitRate,slippageRate,fundingCost,withdrawalCost].every(finite)||capital<=0||[entryRate,exitRate,slippageRate,fundingCost,withdrawalCost].some(x=>x<0)||entryRate+slippageRate>=1||exitRate+slippageRate>=1||fundingCost>=capital)throw Error('Enter valid nonnegative costs and capital greater than funding fees.');
 // One full buy/sell cycle. Spread and depth must be added to quoted prices.
 const deployed=capital-fundingCost;
 return (capital+withdrawalCost)*(1+entryRate+slippageRate)/(deployed*(1-exitRate-slippageRate))-1;
}
export function assessReadiness(account,now=Date.now()/1000){
 const trades=(account?.trades||[]).filter(t=>finite(t.pnl)&&finite(t.closedAt)&&finite(t.openedAt)&&t.closedAt<=now);
 const start=account?.benchmark?.startedAt??now;
 const rows=trades.filter(t=>t.openedAt>=start),days=Math.max(0,(now-start)/86400);
 const net=rows.reduce((s,t)=>s+t.pnl,0),mean=rows.length?net/rows.length:0;
 const sd=rows.length>1?Math.sqrt(rows.reduce((s,t)=>s+(t.pnl-mean)**2,0)/(rows.length-1)):Infinity;
 const lower=rows.length>1?mean-1.96*sd/Math.sqrt(rows.length):null;
 const stressed=rows.reduce((s,t)=>s+t.pnl-.5*((t.entryFees||0)+(t.exitFees||0))-(t.principal||0)*.001-(t.proceeds||0)*.001,0);
 const dd=account?.peak>0?Math.max(0,1-account.equity/account.peak):1;
 const benchmark=account?.benchmark;
 const gates=[
  {label:`50 closed forward trades since benchmark start (${rows.length}/50)`,pass:rows.length>=50},
  {label:`30 untouched forward days (${Math.floor(days)}/30)`,pass:days>=30},
  {label:'Positive realized results after all modeled trading costs',pass:rows.length>0&&net>0},
  {label:'Positive result with 50% higher fees and another 0.10% slippage each side',pass:rows.length>0&&stressed>0},
  {label:'Positive lower mean estimate (screening only, not proof of an edge)',pass:finite(lower)&&lower>0},
  {label:'Outperform cost-adjusted BTC holding and cash over the same forward interval',pass:!!benchmark&&benchmark.markComplete===true&&account.equity>benchmark.equity&&account.equity>benchmark.baselineEquity},
  {label:'Fresh liquidation marks and drawdown below 10%',pass:account?.markComplete===true&&finite(account.updatedAt??account.curve?.at(-1)?.at)&&(account.updatedAt??account.curve?.at(-1)?.at)<=now+5&&now-(account.updatedAt??account.curve?.at(-1)?.at)<1200&&dd<.1},
  {label:'Strategy remains eligible for new entries',pass:['experimental','established'].includes(account?.status)},
 ];
 return {eligible:gates.every(g=>g.pass),gates,trades:rows.length,days,net,stressed,lowerMean:finite(lower)?lower:null,drawdown:dd};
}
export function executionProfile(strategyId,{budget=100,maxOrder=10}={}){
 if(typeof strategyId!=='string'||! /^[a-z]+$/.test(strategyId))throw Error('Invalid strategy');
 if(!finite(budget)||budget<=0||budget>1000||!finite(maxOrder)||maxOrder<=0||maxOrder>budget)throw Error('Invalid funding limits');
 return {version:EXECUTION_VERSION,mode:'preview',liveEnabled:false,venue:'coinbase',country:'US',state:'OK',strategyId,budgetUsd:budget,maxOrderUsd:maxOrder,
  accountEligibilityConfirmed:false,accountFeeVerified:false,feeCheckedAt:null,accountTakerRate:null,fundingCostUsd:null,withdrawalCostUsd:null,
  products:['BTC-USD','ETH-USD','SOL-USD'],allowLeverage:false,allowShorting:false,notes:'Separate real allocation. Paper positions are never copied into funded holdings. Complete the private preflight before enabling orders.'};
}
