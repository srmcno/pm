// Capacity controls new entries only. They never resize existing holdings,
// change the funded allocation, or relax fee, protection and loss checks.
const profiles=Object.freeze({
 standard:Object.freeze({name:'standard',maxPositions:3,positionWeight:'0.20',exposureWeight:'0.60'}),
 expanded:Object.freeze({name:'expanded',maxPositions:10,positionWeight:'0.30',exposureWeight:'0.90'}),
});
export function getCapacityProfile(name='standard'){
 if(typeof name!=='string'||!Object.hasOwn(profiles,name))throw Error('Unknown capacity profile; use standard or expanded.');
 return profiles[name];
}
