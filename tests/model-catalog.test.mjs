import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createModelCatalog, createModelCollector, modelCatalogRouter } from '../server/model-catalog.mjs';

const model = {id:'model', name:'Qwen fixture', status:'available', evidence:[], paths:[], applications:[]};
const result = {models:[model],hosts:[],warnings:[],error:null,coverage:{hostsChecked:1,endpointsChecked:1,filesChecked:0,notes:[]}};
function processFixture(output, code=0) {
  const calls=[];
  const spawnProcess=(command,args,options)=>{
    calls.push({command,args,options});
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.write(typeof output==='string'?output:JSON.stringify(output));child.stderr.write('private command output');child.emit('close',code);});
    return child;
  };
  return {calls,spawnProcess};
}
async function temporary(t) {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'model-catalog-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  return dataDir;
}
test('collector is fixed read-only helper, SSH verifies known host and stdout errors are sanitized',async()=>{
  const fixture=processFixture(result);
  assert.deepEqual(await createModelCollector({mode:'ssh',sshTarget:'fixture-server',...fixture})(),result);
  assert.ok(fixture.calls[0].args.includes('StrictHostKeyChecking=yes'));
  assert.deepEqual(fixture.calls[0].args.slice(-6),['fixture-server','sudo','-n','/usr/bin/python3','-I','/opt/viios-agent/model_catalog.py']);
  assert.equal(fixture.calls[0].options.stdio[0],'ignore');
  await assert.rejects(createModelCollector({mode:'ssh',sshTarget:'-oProxyCommand=evil',...fixture})(),{status:503});
  for(const fail of [processFixture('private invalid JSON'),processFixture({},1)]) await assert.rejects(createModelCollector({mode:'local',...fail})(),error=>!error.message.includes('private'));
});
test('concurrent refreshes share a scan, snapshot persists and polls obey TTL',async t=>{
  const dataDir=await temporary(t);let complete,calls=0,clock=Date.now();
  const store=createModelCatalog({dataDir,now:()=>clock,collect:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}});
  const snapshots=await Promise.all([store.refresh(),store.refresh(),store.read()]);
  assert.equal(calls,1);assert.ok(snapshots.every(s=>s.scanning));
  complete(result);const finished=await store.waitForIdle();
  assert.equal(finished.scanning,false);assert.equal(finished.stale,false);
  assert.equal(JSON.parse(await readFile(path.join(dataDir,'model-catalog.json'),'utf8')).models[0].name,model.name);
  await store.read();assert.equal(calls,1);
  const restored=createModelCatalog({dataDir,now:()=>clock,collect:async()=>{throw new Error('unused');}});
  assert.deepEqual((await restored.read()).models,[model]);
  clock+=300001;await store.read();assert.equal(calls,2);complete(result);await store.waitForIdle();
});
test('failed scan preserves successful inventory and backs off automatic retries',async t=>{
  const dataDir=await temporary(t);let failed=false,calls=0;
  const store=createModelCatalog({dataDir,collect:async()=>{calls++;if(failed)throw new Error('sensitive credentials');return result;}});
  await store.refresh();const success=await store.waitForIdle();failed=true;
  await store.refresh();const error=await store.waitForIdle();
  assert.deepEqual(error.models,success.models);assert.equal(error.scannedAt,success.scannedAt);assert.equal(error.stale,true);
  assert.ok(error.error);assert.ok(!error.error.includes('credentials'));
  await store.read();assert.equal(calls,2);
});
test('empty unavailable result never erases previous models',async t=>{
  const dataDir=await temporary(t);let unavailable=false;
  const store=createModelCatalog({dataDir,collect:async()=>unavailable?{...result,models:[],error:'Kaynak erişilemiyor.'}:result});
  await store.refresh();const original=await store.waitForIdle();unavailable=true;
  await store.refresh();const snapshot=await store.waitForIdle();
  assert.deepEqual(snapshot.models,[model]);assert.equal(snapshot.scannedAt,original.scannedAt);assert.ok(snapshot.error);
});
test('one failed endpoint retains its previously listed models as unreachable',async t=>{
  const dataDir=await temporary(t);let failed=false;
  const previous={...model,endpoint:'http://host:31989',loadedFromAPI:true,checkedAt:'2026-09-30T10:00:00Z'};
  const collect=async()=>failed?{...result,models:[],coverage:{...result.coverage,endpoints:[{endpoint:previous.endpoint,status:'unreachable'}]}}:{...result,models:[previous]};
  const store=createModelCatalog({dataDir,collect});await store.refresh();await store.waitForIdle();failed=true;
  await store.refresh();const snapshot=await store.waitForIdle();
  assert.equal(snapshot.models.length,1);assert.equal(snapshot.models[0].status,'unreachable');assert.equal(snapshot.models[0].loadedFromAPI,false);
  assert.equal(snapshot.models[0].lastSeenAt,previous.checkedAt);assert.equal(snapshot.models[0].evidence.at(-1).kind,'last-seen');
});
test('router rejects caller-supplied targets and returns an asynchronous scan snapshot',async t=>{
  let refreshes=0;
  const app=express();app.use(express.json());app.use('/api/models',modelCatalogRouter({read:async()=>({...result,scanning:false}),refresh:async()=>{refreshes++;return {...result,scanning:true};}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/models`;
  assert.equal((await fetch(url)).status,200);
  const rejected=await fetch(url+'/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'http://evil'})});
  assert.equal(rejected.status,400);assert.equal(refreshes,0);
  const accepted=await fetch(url+'/refresh',{method:'POST'});assert.equal(accepted.status,202);assert.equal((await accepted.json()).scanning,true);assert.equal(refreshes,1);
});
