import {advanceCompetition} from '../dashboard/crypto-strategies-core.mjs';

// Collection timestamps belong to the feed. The decision timestamp belongs
// to the instant after collection; it must never be captured before I/O.
export async function collectAndAdvance(previous, options, collect, clock=()=>Date.now()/1000) {
  let feed;
  try { feed=await collect(options); }
  catch(error) {
    feed={markets:(options.cached||[]).map(m=>({...m,sourceError:'Collection failed; retained observation'})),
      errors:[{stage:'discovery',message:error.message}],universe:{selected:0,collectionFailed:true}};
  }
  const now=clock();
  return {feed,now,state:advanceCompetition(previous,feed.markets,now)};
}
