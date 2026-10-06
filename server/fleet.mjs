import path from 'node:path';
import { createInventory } from './inventory.mjs';
import { dailyDue } from './history.mjs';
export const validServerId = value => typeof value === 'string' && /^srv-[a-f0-9]{24}$/.test(value);
export function resolveTarget(targets,id) {if(!validServerId(id)||!targets.has(id))throw Object.assign(new Error('Sunucu henüz hazır değil veya kaldırılmış.'),{status:404});return targets.get(id);}
export function createFleet({dataDir,inventoryFactory=createInventory}={}) {
 if(!dataDir)throw new Error('Sunucu kayıt dizini gerekli.');
 const targets=new Map(),profiles=new Map();let closed=false;
 async function add(profile){
  if(closed||profile.status!=='ready')return;
  if(!validServerId(profile.id))throw new Error('Geçersiz sunucu kimliği.');
  if(targets.has(profile.id))return targets.get(profile.id);
  const target=inventoryFactory({id:profile.id,host:profile.host,name:profile.name,mode:'ssh',sshTarget:profile.id,platform:profile.platform,capabilities:profile.capabilities,dataDir:path.join(dataDir,'servers',profile.id)});
  profiles.set(profile.id,profile);targets.set(profile.id,target);
  try{await target.initialize({background:true});}catch(error){targets.delete(profile.id);profiles.delete(profile.id);await target.shutdown();throw error;}return target;
 }
 async function remove(id){const target=targets.get(id);targets.delete(id);profiles.delete(id);await target?.shutdown();}
 function list(){return {discoveryEnabled:false,subnet:null,lastDiscovery:null,discovering:false,fullScanning:false,fullRemaining:0,error:null,servers:[...targets].map(([id,target])=>{const s=target.inventory(),p=profiles.get(id);return {id,host:p.host,name:p.name,platform:p.platform,capabilities:p.capabilities,mode:'ssh',configurationStatus:'ready',deviceType:'managed',status:s.error?'unreachable':s.scannedAt?s.stale?'stale':'online':'pending',scannedAt:s.scannedAt,lastSeen:s.scannedAt,active:s.apps.filter(a=>a.active!==false).length,manageable:s.apps.filter(a=>a.control?.canStop||a.control?.canStart).length,unread:s.unread,previewPort:s.apps.find(a=>a.previewAt)?.port||null,progress:null,fullScannedAt:s.scannedAt};})};}
 return {targets,profiles,dataDir,add,remove,list,resolve:id=>resolveTarget(targets,id),get primary(){return targets.values().next().value||null;},async initialize(connections=[]){for(const p of connections)await add(p);},tick(periodic=true){if(closed)return;for(const target of targets.values()){const s=target.inventory();if(periodic||dailyDue(s.lastDailyAuditDay,s.lastDailyAttemptAt))target.scheduledScan();}},async shutdown(){closed=true;await Promise.all([...targets.values()].map(t=>t.shutdown()));targets.clear();}};
}
