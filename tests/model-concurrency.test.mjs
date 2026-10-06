import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { createConcurrencyCollector, createModelConcurrency, validateConcurrency } from '../server/model-concurrency.mjs';
import { modelCatalogRouter } from '../server/model-catalog.mjs';

const checkedAt='2026-09-30T11:00:00.000Z';
const service={id:'qwen',endpoint:'http://host:31989',host:'host',runtime:'llama.cpp',status:'partial',checkedAt,running:0,waiting:null,configuredParallelism:24,configuredQueueLimit:null,scope:'service',modelName:null,sources:[{kind:'metrics',source:'http://host:31989/slots',detail:'Count only'}],note:null,capacity:{status:'not_tested'}};
const result={checkedAt,error:null,services:[service]};
function fixture(output,exitCode=0) {
  const calls=[];
  const spawnProcess=(command,args,options)=>{
    calls.push({command,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};
    queueMicrotask(()=>{child.stdout.write(typeof output==='string'?output:JSON.stringify(output));child.stderr.write('sensitive command stderr');child.emit('close',exitCode);});return child;
  };
  return {calls,spawnProcess};
}
test('collector uses fixed read-only helper with strict SSH and no stdin',async()=>{
  const fake=fixture(result);const collect=createConcurrencyCollector({mode:'ssh',sshTarget:'fixture-server',...fake});
  assert.equal((await collect()).services[0].configuredParallelism,24);
  assert.ok(fake.calls[0].args.includes('StrictHostKeyChecking=yes'));
  assert.deepEqual(fake.calls[0].args.slice(-6),['fixture-server','sudo','-n','/usr/bin/python3','-I','/opt/viios-agent/model_concurrency.py']);
  assert.equal(fake.calls[0].options.stdio[0],'ignore');
  await assert.rejects(createConcurrencyCollector({mode:'ssh',sshTarget:'-oProxyCommand=evil',...fake})(),{status:503});
});
test('collector timeout and output failure never expose raw stderr',async()=>{
  for(const fake of [fixture('SECRETinvalid'),fixture({},1)])await assert.rejects(createConcurrencyCollector({mode:'local',...fake})(),error=>!error.message.includes('SECRET')&&!error.message.includes('sensitive'));
  let child;
  const spawnProcess=()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};return child;};
  await assert.rejects(createConcurrencyCollector({mode:'local',timeoutMs:10,spawnProcess})(),/zaman aşımı/);assert.equal(child.killed,true);
});
test('projection discards arbitrary prompt fields and rejects invalid numeric measures',()=>{
  const sanitized=validateConcurrency({...result,prompt:'PRIVATE',services:[{...service,prompt:'SECRET',capacity:{status:'tested',prompt:'PRIVATE'},sources:[{...service.sources[0],prompt:'PRIVATE'}]}]});
  assert.ok(!JSON.stringify(sanitized).includes('PRIVATE'));assert.ok(!JSON.stringify(sanitized).includes('SECRET'));
  assert.equal(sanitized.services[0].capacity.status,'not_tested');
  for(const running of [undefined,-1,NaN,1.5,'0',true]) assert.throws(()=>validateConcurrency({...result,services:[{...service,running}]}));
  assert.equal(validateConcurrency(result).services[0].running,0);
});
test('light monitor is lazy, singleflight and independently throttled to 15 seconds',async()=>{
  let complete,calls=0,clock=Date.parse(checkedAt);
  const monitor=createModelConcurrency({now:()=>clock,collect:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}});
  assert.equal(calls,0);
  const snapshots=await Promise.all([monitor.read(),monitor.read(),monitor.read()]);
  assert.ok(snapshots.every(snapshot=>snapshot.refreshing));assert.equal(calls,1);
  complete(result);const ready=await monitor.waitForIdle();assert.equal(ready.refreshing,false);assert.equal(ready.stale,false);
  clock+=14999;await monitor.read();assert.equal(calls,1);
  clock+=1;await monitor.read();await Promise.resolve();assert.equal(calls,2);complete({...result,checkedAt:new Date(clock).toISOString()});await monitor.waitForIdle();await monitor.shutdown();
});
test('failure keeps last time but never old request counts as current or fake zeros',async()=>{
  let clock=Date.parse(checkedAt),failed=false;
  const monitor=createModelConcurrency({now:()=>clock,collect:async()=>{if(failed)throw new Error('private');return {...result,services:[{...service,running:5,waiting:2}]};}});
  await monitor.read();await monitor.waitForIdle();failed=true;clock+=15001;await monitor.read();const broken=await monitor.waitForIdle();
  assert.equal(broken.checkedAt,checkedAt);assert.equal(broken.stale,true);assert.equal(broken.services[0].running,null);assert.equal(broken.services[0].waiting,null);
  assert.equal(broken.services[0].checkedAt,checkedAt);assert.equal(broken.services[0].stale,true);assert.equal(broken.services[0].status,'unavailable');
  assert.ok(!broken.error.includes('private'));
});
test('per-service failures retain time and null values while another service remains live',async()=>{
  let clock=Date.parse(checkedAt),second=false;
  const monitor=createModelConcurrency({now:()=>clock,collect:async()=>second?{...result,checkedAt:new Date(clock).toISOString(),services:[{...service,status:'unavailable',checkedAt:null,running:null,configuredParallelism:null}]}:result});
  await monitor.read();await monitor.waitForIdle();second=true;clock+=15001;await monitor.read();const current=await monitor.waitForIdle();
  assert.equal(current.services[0].checkedAt,checkedAt);assert.equal(current.services[0].running,null);assert.equal(current.services[0].stale,true);
});
test('router exposes only GET and rejects caller target parameters',async t=>{
  let calls=0;const app=express();app.use('/api/models',modelCatalogRouter({readConcurrency:async()=>{calls++;return result;}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/models/concurrency`;
  assert.equal((await fetch(base+'?target=evil')).status,400);assert.equal(calls,0);
  const response=await fetch(base);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(calls,1);
  assert.equal((await fetch(base,{method:'POST'})).status,404);assert.equal(calls,1);
});
