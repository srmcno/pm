// Public, unauthenticated, read-only venue reads for the Prediction Lab.
// GET requests only: no order endpoint, no credential and no signed request exists here.
// Book normalization and settlement checks are the existing collector's functions.
import {BASE,get,normalizePolymarket,normalizeKalshi,resolvedPolymarket,resolvedKalshi} from './predictions/venues.mjs';
const enc=encodeURIComponent;
export function createFeed({fetcher=fetch,clock=()=>Date.now()/1000}={}){
  const events=new Map(),series=new Map(),fees=new Map(),milestones=new Map();
  const cached=(map,key,url)=>{if(!map.has(key))map.set(key,get(url,fetcher));return map.get(key);};
  async function milestone(raw){
    if(!/^KX(?:NFL|MLB|NBA|NHL|NCAAF)GAME-/.test(raw.event_ticker||''))return null;
    const d=await cached(milestones,raw.event_ticker,`${BASE.kalshi}/milestones?limit=10&related_event_ticker=${enc(raw.event_ticker)}`);
    const rows=(d.milestones||[]).filter(m=>m.details?.main_game_event_ticker===raw.event_ticker);
    return !d.cursor&&rows.length===1?rows[0]:null;
  }
  return {
    // Retrieve one current book. observedAt is the time this call finished reading it.
    async refresh(ref){
      if(ref.venue==='polymarket'){
        const raw=(await get(`${BASE.polymarket}/market/slug/${enc(ref.venueId)}`,fetcher)).market;
        const book=await get(`${BASE.polymarket}/markets/${enc(ref.venueId)}/book`,fetcher);
        const event={id:ref.eventId?.replace(/^pm:/,''),slug:ref.eventSlug,seriesId:ref.seriesId};
        const m=normalizePolymarket(raw,event,book,clock());m.eventSlug=ref.eventSlug||null;return m;
      }
      if(ref.venue==='kalshi'){
        const raw=(await get(`${BASE.kalshi}/markets/${enc(ref.venueId)}`,fetcher)).market;
        const ev=(await cached(events,raw.event_ticker,`${BASE.kalshi}/events/${enc(raw.event_ticker)}`)).event;
        const ser=(await cached(series,ev.series_ticker,`${BASE.kalshi}/series/${enc(ev.series_ticker)}`)).series;
        let changes=null;
        try{const d=await cached(fees,raw.event_ticker,`${BASE.kalshi}/events/fee_changes?event_ticker=${enc(raw.event_ticker)}&limit=1000`);if(Array.isArray(d.event_fee_changes)&&!d.cursor)changes=d.event_fee_changes;}catch{}
        const book=await get(`${BASE.kalshi}/markets/${enc(raw.ticker)}/orderbook?depth=10`,fetcher);
        return normalizeKalshi(raw,ev,ser,changes,book,clock(),await milestone(raw));
      }
      throw new Error(`Unknown venue ${ref.venue}`);
    },
    // Official final settlement only, through the existing resolution checks.
    resolve:(venue,venueId)=>venue==='polymarket'?resolvedPolymarket(venueId):resolvedKalshi(venueId),
  };
}
