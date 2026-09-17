// Retired strategies keep their complete ledger and original exit mechanics.
// Neither a future favorable backtest nor a UI action can restart their entries.
import {advancePaper as originalAdvance} from '../dashboard/market-core.mjs';
import {assessEvidence as originalEvidence} from '../dashboard/outcomes.mjs';
import {retireLegacy} from '../dashboard/crypto-strategies-core.mjs';
export {PRODUCTS,VERSION,analyzeMarket,evaluateToken} from '../dashboard/market-core.mjs';
export {applyEvidence} from '../dashboard/outcomes.mjs';
export function assessEvidence(report,now){return retireLegacy({entryPolicy:originalEvidence(report,now)},now).entryPolicy;}
export function advancePaper(previous,markets,now,options={}){return retireLegacy(originalAdvance(previous,markets,now,{...options,strategies:[]}),now);}
