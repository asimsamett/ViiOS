import test from 'node:test';
import assert from 'node:assert/strict';
import { storageTopology, createStorageMonitor } from '../server/storage.mjs';

test('topology exposes bounded public metadata and keeps absent rates unknown',()=>{
  const result=storageTopology({available:true,devices:[{id:'disk:0',name:'Disk 0',kind:'disk',sizeBytes:100,parentIds:[],volumeIds:[],serialNumber:'private',readBytesPerSecond:0,writeBytesPerSecond:-1},null,{id:'disk:0'}]});
  assert.equal(result.devices.length,1); assert.equal(result.devices[0].readBytesPerSecond,0);
  assert.equal(result.devices[0].writeBytesPerSecond,null); assert.equal('serialNumber' in result.devices[0],false);
  assert.equal(storageTopology(null).available,false);
  assert.equal(storageTopology({available:true,devices:Array.from({length:600},(_,i)=>({id:String(i)}))}).partial,true);
});
test('legacy storage still serves capacity and a failed refresh retains topology as stale',async()=>{
  let now=0,fail=false;
  const monitor=createStorageMonitor({id:'test',host:'localhost'},{now:()=>now,run:async()=>{
    if(fail)throw Error('offline');
    return {available:true,summary:{totalBytes:100},volumes:[{id:'v',totalBytes:100}],topology:{available:true,devices:[{id:'d',sizeBytes:200,volumeIds:['v']}]}};
  }});
  const first=await monitor.read();assert.equal(first.summary.totalBytes,100);assert.equal(first.topology.devices[0].sizeBytes,200);
  now=6000;fail=true;const stale=await monitor.read();assert.equal(stale.stale,true);assert.equal(stale.topology.devices[0].id,'d');monitor.shutdown();
});
