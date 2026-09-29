// Capacity controls new entries only. They never resize existing holdings,
// change the funded allocation, or relax fee, protection and loss checks.
// The trend profile holds at most one capped BTC and one capped ETH position;
// its larger per-entry risk fraction pays for a native crash stop set well
// below entry. The $5 order cap and $2 loss trigger still bound every entry.
const profiles=Object.freeze({
 standard:Object.freeze({name:'standard',maxPositions:3,positionWeight:'0.20',exposureWeight:'0.60',entryRiskWeight:'0.01'}),
 expanded:Object.freeze({name:'expanded',maxPositions:10,positionWeight:'0.30',exposureWeight:'0.90',entryRiskWeight:'0.01'}),
 active:Object.freeze({name:'active',maxPositions:10,positionWeight:'0.30',exposureWeight:'0.90',entryRiskWeight:'0.02'}),
 trend:Object.freeze({name:'trend',maxPositions:4,positionWeight:'0.50',exposureWeight:'0.99',entryRiskWeight:'0.16'}),
});
export function getCapacityProfile(name='standard'){
 if(typeof name!=='string'||!Object.hasOwn(profiles,name))throw Error('Unknown capacity profile; use standard, expanded, active or trend.');
 return profiles[name];
}
