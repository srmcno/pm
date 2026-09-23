// Decimal quantities use fixed 18-place integers. No floating-point arithmetic
// enters sizing; callers should preserve decimal strings from venue responses.
import {getCapacityProfile} from './capacity.mjs';
const SCALE=10n**18n;
export function D(value){
  if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw Error('Invalid or unsafe decimal number');
  if(!['string','number'].includes(typeof value))throw Error('Decimal string or number required');
  const match=String(value).match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if(!match)throw Error('Invalid decimal');
  const exponent=Number(match[4]||0),fraction=match[3]||'';
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>100||match[2].length+fraction.length>120)throw Error('Decimal out of range');
  const places=fraction.length-exponent;
  if(places>18)throw Error('Decimal exceeds 18-place precision');
  const magnitude=BigInt(match[2]+fraction)*10n**BigInt(18-places);
  return match[1]==='-'?-magnitude:magnitude;
}
export function S(value){
  if(typeof value!=='bigint')throw Error('Fixed decimal integer required');
  const sign=value<0n?'-':'',n=value<0n?-value:value,f=(n%SCALE).toString().padStart(18,'0').replace(/0+$/,'');
  return sign+(n/SCALE).toString()+(f?'.'+f:'');
}
export function mul(a,b){return a*b/SCALE;}
export function div(a,b){if(b===0n)throw Error('Division by zero');return a*SCALE/b;}
export function floorStep(amount,increment){
  if(amount<0n||increment<=0n)throw Error('Nonnegative amount and positive increment required');
  return amount/increment*increment;
}
const min=(...xs)=>xs.reduce((a,b)=>a<b?a:b);
const max=(...xs)=>xs.reduce((a,b)=>a>b?a:b);
const ceilStep=(n,step)=>{if(n<0n||step<=0n)throw Error('Invalid rounding');return (n+step-1n)/step*step;};
const upMul=(a,b)=>{if(a<0n||b<0n)throw Error('Invalid unsigned multiplication');return (a*b+SCALE-1n)/SCALE;};
const positive=(x,label)=>{const n=D(x);if(n<=0n)throw Error(`${label} must be positive`);return n;};
const nonnegative=(x,label)=>{const n=D(x);if(n<0n)throw Error(`${label} must be nonnegative`);return n;};
const CENT=D('0.01');
const booleanFlags=['trading_disabled','is_disabled','cancel_only','view_only','post_only','limit_only','auction_mode'];
function parseLevels(rows,side){
  if(!Array.isArray(rows)||!rows.length)throw Error('Missing displayed depth');
  const levels=rows.map(row=>[positive(Array.isArray(row)?row[0]:row?.price,'Book price'),positive(Array.isArray(row)?row[1]:row?.size,'Book size')]);
  levels.sort((a,b)=>a[0]===b[0]?0:(a[0]<b[0]?-1:1)*(side==='buy'?1:-1));
  return levels;
}
function fills(levels,quantity,limit=null){
  let left=quantity,principal=0n;
  for(const [price,size] of levels){if(limit!==null&&price>limit)break;const take=min(left,size);principal+=upMul(price,take);left-=take;if(!left)break;}
  return left===0n?principal:null;
}

// Risk is an estimate, not a guaranteed stop fill. Coinbase's attached spot
// bracket becomes a limit 5% below its stop trigger; gaps can still strand it.
export function planEntry({decision,product,book,cash,equity,exposure,feeRate,config,now}={}){
  try{
    if(config?.feeVerified!==true)throw Error('Fresh account fee verification required');
    const capacity=getCapacityProfile(config.capacityProfile);
    const allocation=positive(config.allocation,'Allocation'),maxOrder=positive(config.maxOrder,'Order cap');
    if(allocation>D('20')||maxOrder>D('5'))throw Error('Allocation or order exceeds hard cash cap');
    const available=nonnegative(cash,'Cash'),accountEquity=positive(equity,'Equity'),used=nonnegative(exposure,'Exposure'),rate=nonnegative(feeRate,'Fee rate');
    if(rate>D('1'))throw Error('Invalid fee rate');
    if(available>allocation||accountEquity>allocation)throw Error('Cash and equity must stay within the isolated allocation');
    if(decision?.status!=='candidate')throw Error('A current candidate decision is required');
    const productId=product?.product_id;
    if(typeof productId!=='string'||!/^([A-Z0-9][A-Z0-9.-]{0,20})-USD$/.test(productId)||product.quote_currency_id!=='USD'||product.product_type!=='SPOT'||product.status!=='online')throw Error('Only online USD spot products qualify');
    if(product.base_currency_id!==productId.slice(0,-4))throw Error('Product base identity mismatch');
    if((decision.product??decision.productId)!==productId)throw Error('Decision product mismatch');
    for(const flag of booleanFlags)if(product[flag]!==false)throw Error(`Product restriction missing or active: ${flag}`);
    if(!Number.isFinite(now)||!Number.isFinite(book?.requestAt)||!Number.isFinite(book?.receivedAt)||book.requestAt>book.receivedAt||book.receivedAt>now||now-book.requestAt>15||now-book.receivedAt>15||(book.bookAt!==undefined&&(!Number.isFinite(book.bookAt)||book.bookAt>now+5||now-book.bookAt>15)))throw Error('Fresh book within 15 seconds required');
    const exact=book.raw?.pricebook??book.pricebook??book;
    const asks=parseLevels(exact.asks,'buy'),bids=parseLevels(exact.bids,'sell'),ask=asks[0][0],bid=bids[0][0];
    if(bid>ask||div(ask-bid,bid)>D('0.0075'))throw Error('Crossed or excessive spread');
    const increment=positive(product.base_increment,'Base increment'),priceStep=positive(product.price_increment??product.quote_increment,'Price increment');
    const minSize=positive(product.base_min_size,'Base minimum'),minQuote=positive(product.quote_min_size,'Quote minimum');
    const maxSize=positive(product.base_max_size,'Base maximum'),maxQuote=positive(product.quote_max_size,'Quote maximum');
    if(minSize>maxSize||minQuote>maxQuote)throw Error('Invalid product limits');
    const signalPrice=positive(decision.features?.price,'Signal price'),atr=positive(decision.features?.atr,'ATR');
    if(ask>signalPrice+atr)throw Error('Price moved beyond the candidate setup');
    const limitPrice=floorStep(mul(ask,D('1.001')),priceStep),stop=ceilStep(positive(decision.stop,'Stop'),priceStep),target=floorStep(positive(decision.target,'Target'),priceStep);
    if(limitPrice<ask||stop>=bid||stop>=limitPrice||target<=limitPrice)throw Error('Protective levels do not fit the entry');
    const sizingEquity=min(accountEquity,allocation),budget=min(available,maxOrder,mul(sizingEquity,D(capacity.positionWeight)),max(0n,mul(sizingEquity,D(capacity.exposureWeight))-used));
    if(budget<=CENT)throw Error('Cash or exposure budget exhausted');
    const unitCost=upMul(limitPrice,SCALE+rate);
    const exitStop=floorStep(mul(stop,D('0.95')),priceStep);
    if(exitStop<=0n)throw Error('Stop limit rounds to zero');
    const stopNet=mul(mul(exitStop,D('0.999')),SCALE-rate),targetNet=mul(mul(target,D('0.999')),SCALE-rate);
    const loss=unitCost-stopNet,gain=targetNet-unitCost;
    if(loss<=0n||gain<=0n||div(gain,loss)<D('1.1'))throw Error('Reward does not clear fees and conservative stop risk');
    const riskBudget=mul(sizingEquity,D(capacity.entryRiskWeight));
    let quantity=floorStep(min(div(budget-CENT,unitCost),div(max(0n,riskBudget-2n*CENT),loss),maxSize),increment);
    // Cent rounding can invalidate the closed-form estimate. Reduce by a
    // bounded geometric step; never round quantity up to force minimum size.
    for(let attempt=0;attempt<24&&quantity>=minSize;attempt++,quantity=floorStep(mul(quantity,D('0.90')),increment)){
      const principal=upMul(quantity,limitPrice),entryFee=ceilStep(upMul(principal,rate),CENT),reserved=principal+entryFee+CENT;
      const stopPrincipal=mul(quantity,exitStop),exitFee=ceilStep(upMul(stopPrincipal,rate),CENT);
      const stopProceeds=stopPrincipal-exitFee-upMul(stopPrincipal,D('0.001'));
      const targetPrincipal=mul(quantity,target),targetFee=ceilStep(upMul(targetPrincipal,rate),CENT);
      const targetProceeds=targetPrincipal-targetFee-upMul(targetPrincipal,D('0.001'));
      const risk=reserved-stopProceeds,reward=targetProceeds-reserved;
      if(principal<minQuote||stopPrincipal<minQuote||principal>maxQuote||targetPrincipal>maxQuote)continue;
      if(reserved>budget||risk<=0n||risk>riskBudget||reward<=0n||div(reward,risk)<D('1.1'))continue;
      if(fills(asks,quantity,limitPrice)===null||fills(bids,quantity)===null)continue;
      return {ok:true,quantity:S(quantity),limitPrice:S(limitPrice),stop:S(stop),target:S(target),stopLimitPrice:S(exitStop),reserved:S(reserved),risk:S(risk),reward:S(reward),principal:S(principal),feeReserve:S(entryFee),maxOrder:S(maxOrder),productId,capacityProfile:capacity.name,entryRiskFraction:capacity.entryRiskWeight};
    }
    throw Error('No quantity fits venue minimums, displayed depth, costs and hard risk limits');
  }catch(error){return {hold:error.message};}
}

export function validatePreview(plan,response,feeRate,now){
  try{
    if(!plan?.ok||plan.hold)throw Error('Valid entry plan required');
    if(typeof response?.preview_id!=='string'||!response.preview_id.trim()||response.preview_id.length>256)throw Error('Missing preview identity');
    if(!Array.isArray(response.errs)||response.errs.length)throw Error('Preview reported errors or omitted error status');
    for(const warning of [response.warning,response.warnings])if(warning!==undefined&&warning!==null&&warning!==''&&!(Array.isArray(warning)&&warning.length===0))throw Error('Preview warning requires review');
    const fees=nonnegative(response.commission_total,'Preview commission'),total=positive(response.order_total,'Preview total'),rate=nonnegative(feeRate,'Fee rate');
    if(rate>D('1'))throw Error('Invalid fee rate');
    const quantity=positive(plan.quantity,'Planned quantity'),limit=positive(plan.limitPrice,'Planned limit'),reserved=positive(plan.reserved,'Reserved cash');
    if(response.base_size!==undefined&&D(response.base_size)!==quantity)throw Error('Preview quantity differs from plan');
    if(response.product_id!==undefined&&response.product_id!==plan.productId)throw Error('Preview product differs from plan');
    if(response.side!==undefined&&response.side!=='BUY')throw Error('Preview side differs from plan');
    if(response.est_average_filled_price!==undefined&&positive(response.est_average_filled_price,'Preview average price')>limit)throw Error('Preview average price exceeds limit');
    const quote=response.quote_size===undefined?mul(quantity,limit):positive(response.quote_size,'Preview quote size');
    if(quote>upMul(quantity,limit))throw Error('Preview quote exceeds limit notional');
    const cost=max(total,quote+fees);
    if(fees>ceilStep(upMul(upMul(quantity,limit),rate),CENT))throw Error('Preview fee exceeds verified fee allowance');
    if(cost>reserved||cost>D('5')||cost>positive(plan.maxOrder,'Order cap'))throw Error('Preview exceeds reserved cash or hard order cap');
    if(now!==undefined&&!Number.isFinite(now))throw Error('Invalid preview decision time');
    return {ok:true,previewId:response.preview_id,cost:S(cost),total:S(total),fees:S(fees),reserved:S(reserved)};
  }catch(error){return {hold:error.message};}
}
