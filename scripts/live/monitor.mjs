import {evaluateUniverse} from '../../dashboard/crypto-strategies-core.mjs';
import {D,S,planEntry,validatePreview} from './risk.mjs';

const canonical=id=>typeof id==='string'&&/^[A-Z0-9][A-Z0-9.-]{0,20}-USD$/.test(id);
const portfolio=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
const min=(a,b)=>a<b?a:b;
function currentBook(book,id,now){
  if((book?.product??book?.pricebook?.product_id)!==id)throw Error('Book identity');
  for(const time of [book.requestAt,book.receivedAt])if(!Number.isFinite(time)||time>now||now-time>15)throw Error('Book freshness');
  // Coinbase's server can be slightly ahead of the runner clock. Preserve the
  // source timestamp and tolerate at most five seconds; never relax receipt age.
  if(!Number.isFinite(book.bookAt)||book.bookAt>now+5||now-book.bookAt>15)throw Error('Book server timestamp');
  if(book.requestAt>book.receivedAt)throw Error('Book chronology');
  return book;
}
function accountCash(raw,expected,allocation){
  if(!Array.isArray(raw?.accounts)||raw.has_next!==false||(raw.cursor!==undefined&&raw.cursor!==''))throw Error('Incomplete accounts');
  const seen=new Set();let dollars=0n;
  for(const account of raw.accounts){
    if(!portfolio(account?.uuid)||seen.has(account.uuid)||account.retail_portfolio_id!==expected)throw Error('Account identity');
    seen.add(account.uuid);
    if(typeof account.currency!=='string'||account.available_balance?.currency!==account.currency)throw Error('Account currency');
    const available=D(account.available_balance.value);if(available<0n)throw Error('Account amount');
    if(account.currency==='USD'){
      if(account.active!==true||account.ready!==true)throw Error('USD account unavailable');
      dollars+=available;
    }
  }
  return min(dollars,D(allocation));
}
function freshFee(fees,now){
  if(!Number.isFinite(fees?.checkedAt)||fees.checkedAt>now||now-fees.checkedAt>15)throw Error('Fee freshness');
  const rate=D(fees.raw?.fee_tier?.taker_fee_rate??fees.takerRate);
  if(rate<0n||rate>=D('0.1'))throw Error('Fee rate');
  if(fees.takerRate!==undefined&&D(fees.takerRate)!==rate)throw Error('Fee mismatch');
  return S(rate);
}

// This module has no create/cancel/convert path. Public diagnostics deliberately
// exclude balances, identifiers, preview IDs, raw broker responses and errors.
export async function monitorCycle({feed,broker=null,clock=()=>Date.now()/1000,now=clock(),allocation='20'}={}){
  // `now` labels the report's start; freshness uses the same wall-clock epoch as
  // broker timestamps. Rebasing elapsed time onto a caller's earlier `now` can
  // falsely put a just-received fee timestamp in the future. Tests inject clock.
  const result={mode:'preview-only',generatedAt:Number.isFinite(now)?now:null,realEnabled:false,status:'market_monitoring',credentialStatus:'needs_credentials',feeStatus:'modeled-unverified',
    coverage:{selected:0,ready:0,rotationCandidates:0,previewed:0},candidates:[],
    note:'Order previews do not execute trades. Paper results are not real-money profit or loss.'};
  if(!Number.isFinite(now)||now<=0||!Array.isArray(feed?.markets)||feed.markets.length>1000){result.status='held';result.hold='Market feed unavailable or malformed.';return result;}
  try{if(D(allocation)<D('5')||D(allocation)>D('20'))throw Error();}catch{result.status='held';result.hold='Allocation is outside the supported bounds.';return result;}
  let view;
  try{view=evaluateUniverse(feed.markets,clock());}catch{result.status='held';result.hold='Market feed could not be evaluated.';return result;}
  const eligible=view.decisions.filter(d=>d.strategyId==='rotation'&&d.status==='candidate'&&canonical(d.product));
  result.coverage={...result.coverage,selected:view.markets.length,ready:view.markets.filter(m=>m.status==='ready').length,rotationCandidates:eligible.length};
  result.candidates=eligible.slice(0,3).map(d=>({product:d.product,status:'needs_credentials',reason:'Authenticated fee and order-preview checks have not run.'}));
  if(!broker)return result;
  let expected,feeRate,cash,feeReceipt;
  try{
    const permissions=await broker.permissions();
    if(permissions?.can_view!==true||!portfolio(permissions.portfolio_uuid))throw Error('View permission');
    expected=permissions.portfolio_uuid;
    const configured=broker.portfolioId??broker.credentials?.portfolioId;
    if(configured!==undefined&&(!portfolio(configured)||configured!==expected))throw Error('Configured portfolio mismatch');
    // The adapter checks its private configured portfolio in permissions();
    // every returned account is independently matched to that same binding.
    const fees=await broker.fees();feeReceipt=fees;feeRate=freshFee(fees,clock());
    cash=accountCash(await broker.accounts(),expected,allocation);
    feeRate=freshFee(fees,clock());
    result.credentialStatus='view_verified';result.feeStatus='account_verified';result.status='preview_monitoring';
  }catch{
    result.status='held';result.credentialStatus='verification_held';result.hold='Account access, portfolio binding, available USD or fresh fees could not be verified.';
    result.candidates=result.candidates.map(c=>({...c,status:'held',reason:'Authenticated preflight is incomplete.'}));return result;
  }
  if(cash<=0n){result.status='held';result.hold='An available USD allocation is required for previews; assets are never converted.';result.candidates=result.candidates.map(c=>({...c,status:'held',reason:'USD funding check did not pass.'}));return result;}
  for(const row of result.candidates){
    let stage='market';
    try{
      const cached=feed.markets.find(m=>m.product===row.product),btc=feed.markets.find(m=>m.product==='BTC-USD');
      if(!cached||!btc)throw Error('Missing cached history');
      const product=await broker.product(row.product);
      if(product?.product_id!==row.product)throw Error('Product identity');
      const candidateBook=await broker.book(row.product),btcBook=row.product==='BTC-USD'?candidateBook:await broker.book('BTC-USD');
      const decisionAt=clock();currentBook(candidateBook,row.product,decisionAt);currentBook(btcBook,'BTC-USD',decisionAt);
      const refreshed=feed.markets.map(m=>m.product===row.product?{...m,sourceError:undefined,status:product.status,tradingDisabled:product.trading_disabled,
        increment:Number(product.base_increment),minSize:Number(product.base_min_size),minNotional:Number(product.quote_min_size),book:candidateBook}:
        m.product==='BTC-USD'?{...m,sourceError:undefined,book:btcBook}:m);
      const decision=evaluateUniverse(refreshed,decisionAt).decisions.find(d=>d.strategyId==='rotation'&&d.product===row.product);
      if(decision?.status!=='candidate'){row.status='held';row.reason='The rotation signal no longer qualifies against fresh authenticated books.';continue;}
      stage='risk';
      feeRate=freshFee(feeReceipt,clock());
      const plan=planEntry({decision,product,book:candidateBook,cash:S(cash),equity:allocation,exposure:'0',feeRate,
        config:{allocation,maxOrder:'5',feeVerified:true},now:decisionAt});
      if(plan.hold){row.status='held';row.reason=plan.hold;continue;}
      const body={product_id:row.product,side:'BUY',retail_portfolio_id:expected,
        order_configuration:{sor_limit_ioc:{base_size:plan.quantity,limit_price:plan.limitPrice}},
        attached_order_configuration:{trigger_bracket_gtc:{limit_price:plan.target,stop_trigger_price:plan.stop}}};
      stage='preview';
      const response=await broker.preview(body);result.coverage.previewed++;
      const checked=validatePreview(plan,response,feeRate,clock());
      if(checked.hold){row.status='held';row.reason=checked.hold;continue;}
      // A slow preview cannot certify a now-stale executable book.
      currentBook(candidateBook,row.product,clock());currentBook(btcBook,'BTC-USD',clock());
      row.status='preview_passed';row.reason='Hypothetical capped entry and attached bracket passed preview checks. No order was submitted.';
    }catch{
      row.status='held';row.reason=stage==='preview'?'Order preview could not be verified; no order was submitted.':stage==='risk'?'Risk sizing could not be verified.':'Fresh authenticated market data could not be verified.';
    }
  }
  result.generatedAt=clock();return result;
}
