import {levels,numeric,timestamp,round} from './prediction-core.mjs';
const e=encodeURIComponent;
const complement=rows=>levels(rows.map(([p,q])=>[round(1-p),q]));
function sides(yesBids,yesAsks,noBids,noAsks) {
  const side=(bids,asks)=>{const b=levels(bids).at(-1);return {bid:b?.[0]??null,bidSize:b?.[1]??null,asks:levels(asks).slice(0,8)};};
  return {yes:side(yesBids,yesAsks),no:side(noBids,noAsks)};
}
export function normalizePolymarket(raw,event,book,observedAt) {
  const b=book?.marketData||{},bid=levels((b.bids||[]).map(l=>[l.px?.value,l.qty])),ask=levels((b.offers||[]).map(l=>[l.px?.value,l.qty]));
  const long=raw.marketSides?.find(s=>s.long===true),league=long?.team?.league;
  // Explicit event ID groups sibling outcomes. A documented league + market type
  // defines the study population where a series object is not supplied.
  const series=event?.series?.[0]?.id||event?.seriesId|| (league&&raw.sportsMarketTypeV2?`${league}:${raw.sportsMarketTypeV2}`:null);
  const gameTypes=['MONEYLINE','SPREAD','TOTAL','PROP','DRAWABLE_OUTCOME'].map(s=>'SPORTS_MARKET_TYPE_'+s);
  const marketPath=league&&gameTypes.includes(raw.sportsMarketTypeV2)?`sports/${e(league)}`:'event';
  const gameCutoff=league&&gameTypes.includes(raw.sportsMarketTypeV2)?timestamp(raw.gameStartTime||event?.startTime):null;
  const url=event?.slug?`https://polymarket.us/${marketPath}/${e(event.slug)}?marketSlug=${e(raw.slug)}`:'https://polymarket.us/search';
  return {id:`polymarket:${raw.slug}`,venue:'polymarket',venueId:raw.slug,eventId:event?.id?`pm:${event.id}`:null,
    seriesId:series?String(series):null,question:raw.title&&raw.title!==raw.question?`${raw.question}: ${raw.title}`:raw.question,
    category:raw.category||event?.category||'Other',rules:raw.description||'',url,
    closeAt:gameCutoff??timestamp(raw.endDate),expiryAt:timestamp(raw.endDate),cutoffKind:gameCutoff?'game start':'contract expiry',observedAt,quoteAt:timestamp(b.transactTime),quoteTimeKind:'venue book timestamp',
    status:raw.closed===false&&raw.status==='MARKET_STATUS_OPEN'&&b.state==='MARKET_STATE_OPEN'?'open':'closed',
    feeRate:numeric(raw.feeCoefficient),feeSource:'Live market feeCoefficient; conservative cent rounding',
    minQuantity:numeric(raw.minimumTradeQty)||1,sides:sides(bid,ask,complement(ask),complement(bid))};
}
export function effectiveKalshiFee(series,changes,at) {
  const rows=(changes||[]).filter(c=>timestamp(c.scheduled_ts)<=at).sort((a,b)=>timestamp(a.scheduled_ts)-timestamp(b.scheduled_ts));
  const change=rows.at(-1),type=change?.fee_type_override??series.fee_type,mult=numeric(change?.fee_multiplier_override??series.fee_multiplier);
  return ['quadratic','quadratic_with_maker_fees','quadratic_with_combo_maker_fees'].includes(type)&&mult!==null&&mult>=0?round(.07*mult):null;
}
export function normalizeKalshi(raw,event,series,changes,book,observedAt) {
  const b=book?.orderbook_fp||{},yb=levels(b.yes_dollars),nb=levels(b.no_dollars);
  return {id:`kalshi:${raw.ticker}`,venue:'kalshi',venueId:raw.ticker,eventId:raw.event_ticker,
    seriesId:event?.series_ticker||null,question:`${raw.title}${raw.yes_sub_title?' · '+raw.yes_sub_title:''}`,
    category:event?.category||'Other',rules:[raw.rules_primary,raw.rules_secondary].filter(Boolean).join('\n'),
    url:`https://kalshi.com/markets/${e((event?.series_ticker||'').toLowerCase())}/${e((raw.event_ticker||'').toLowerCase())}`,
    rulesUrl:series?.contract_terms_url||null,closeAt:Math.min(timestamp(raw.close_time)??Infinity,timestamp(raw.expected_expiration_time)??Infinity),expiryAt:timestamp(raw.close_time),cutoffKind:'expected expiry or earlier close',observedAt,quoteAt:observedAt,
    quoteTimeKind:'public book retrieved; venue timestamp not provided',
    status:raw.status==='active'&&numeric(raw.notional_value_dollars)===1&&raw.market_type==='binary'?'open':'closed',
    feeRate:changes?effectiveKalshiFee(series||{},changes,observedAt):null,
    feeSource:'Current series plus effective event override; conservative non-direct-member rounding',
    minQuantity:1,sides:sides(yb,complement(nb),nb,complement(yb))};
}
