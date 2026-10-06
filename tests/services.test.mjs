import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import {serviceRequest,serviceResponse,publicService,redactServiceLog,createServiceManager,serviceRouter} from '../server/services.mjs';
import {createLabService,labServiceName} from '../scripts/lab-service.mjs';
import {apiErrorMiddleware} from '../server/http-errors.mjs';
import {managedCommand} from '../server/ssh-transport.mjs';
const token='a'.repeat(64),row={name:'demo.service',state:'active',token,actions:['stop']};
test('service schema blocks shell metacharacters, extra fields and unsupported actions',()=>{
 for(const value of [null,[],{action:'toString'},{action:'list',script:'bad'},{action:'details',name:'-bad'},{action:'details',name:'a;id'},{action:'details',name:'../x'},{action:'logs',name:'demo',limit:201},{action:'stop',name:'demo',token:'x'}])assert.throws(()=>serviceRequest(value),{status:400});
 assert.doesNotThrow(()=>serviceRequest({action:'restart',name:'Demo Service',token}));
 assert.match(managedCommand('sudo -n /usr/bin/python3 -I /opt/viios-agent/services.py','windows'),/-Helper services$/);
});
test('service output allowlist strips private configuration and log redaction masks credentials',()=>{
 const result=publicService({...row,PathName:'SECRET',environment:{secret:'SECRET'},password:'SECRET',actions:['stop','shell']});
 assert.ok(!JSON.stringify(result).includes('SECRET'));assert.deepEqual(result.actions,['stop']);
 assert.deepEqual(publicService({...row,token:null}).actions,[]);
 const clean=redactServiceLog('password=SECRET token="SECRET" Authorization: Bearer SECRET https://user:SECRET@example.invalid/');assert.ok(!clean.includes('SECRET'));assert.match(clean,/REDACTED/);
 assert.throws(()=>serviceResponse({ok:false,status:403,error:'SECRET'},'list'),error=>error.status===403&&!error.message.includes('SECRET'));
 assert.throws(()=>serviceResponse({ok:true,available:true,services:[null],sampledAt:1},'list'));
});
test('service mutations serialize and send fixed command plus bounded JSON stdin',async()=>{
 let child,args,body;const manager=createServiceManager({}, {profile:async()=>({transport:'ssh',sshTarget:'srv-test'}),spawn:(_command,a)=>{args=a;child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};child.stdin.on('data',chunk=>body=JSON.parse(chunk));return child;}});
 const pending=manager.run({action:'stop',name:'demo',token});await assert.rejects(manager.run({action:'start',name:'other',token}),{status:409});assert.equal(args.at(-1),'sudo -n /usr/bin/python3 -I /opt/viios-agent/services.py');assert.equal(body.name,'demo');
 child.stdout.end(JSON.stringify({ok:true,service:row}));child.emit('close',0);assert.equal((await pending).service.name,'demo.service');manager.shutdown();await assert.rejects(manager.run({action:'list'}),{status:503});
});
test('service routes reject mutation of action schema and invalid log limits',async()=>{
 let count=0;const app=express();app.use(express.json());app.use('/services',serviceRouter({run:async request=>{serviceRequest(request);count++;return {ok:true};}}));app.use(apiErrorMiddleware);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/services`;
 try{assert.equal((await fetch(url+'/demo/logs?limit=999')).status,400);assert.equal((await fetch(url+'/demo/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'list',token})})).status,400);assert.equal(count,0);assert.equal((await fetch(url+'/demo')).status,200);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('lab service lifecycle uses owned live HTTP worker and persists startup preference',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'viios-service-'));let fixture;
 try{
  fixture=await createLabService({root:process.cwd(),dataDir,port:0});const change=action=>fixture.run({action,name:labServiceName,token:fixture.row().token});
  assert.equal((await fetch(`http://127.0.0.1:${fixture.port()}/`)).status,200);const initial=fixture.row();
  await assert.rejects(fixture.run({action:'stop',name:labServiceName,token:'b'.repeat(64)}),{status:409});await assert.rejects(fixture.run({action:'stop',name:'other',token:initial.token}),{status:403});
  await change('stop');assert.equal(fixture.row().state,'Stopped');await assert.rejects(fetch(`http://127.0.0.1:${fixture.port()}/`));
  await change('start');await change('restart');assert.equal(fixture.row().state,'Running');assert.notEqual(fixture.row().pid,initial.pid);
  await change('disabled');assert.equal(fixture.row().state,'Running');assert.equal(fixture.row().startup,'Disabled');await change('stop');assert.ok(!fixture.row().actions.includes('start'));
  await change('manual');await fixture.shutdown();fixture=await createLabService({root:process.cwd(),dataDir,port:0});assert.equal(fixture.row().state,'Stopped');assert.equal(fixture.row().startup,'Manual');await change('automatic');assert.equal(fixture.row().state,'Stopped');
  await fixture.shutdown();fixture=await createLabService({root:process.cwd(),dataDir,port:0});assert.equal(fixture.row().state,'Running');assert.ok((await fixture.run({action:'logs',name:labServiceName,limit:100})).entries.length>0);
 }finally{await fixture?.shutdown();await rm(dataDir,{recursive:true,force:true});}
});
