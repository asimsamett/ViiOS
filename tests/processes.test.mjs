import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { processRequest, publicProcess, processResponse, createProcessManager, processRouter } from '../server/processes.mjs';
import { labProcessRequest } from '../scripts/server-lab.mjs';
import { managedCommand } from '../server/ssh-transport.mjs';
import { apiErrorMiddleware } from '../server/http-errors.mjs';
const token='a'.repeat(64);
test('process input is a strict fixed action schema; injection and inherited keys rejected',()=>{
  for(const value of [null,[],{action:'toString'},{action:'kill'},{action:'list',command:'whoami'},{action:'details',pid:'1;id'},{action:'details',pid:0},{action:'details',pid:true},{action:'details',pid:2147483648},{action:'terminate',pid:12,token:'x'},{action:'terminate',pid:12,token,force:true}])assert.throws(()=>processRequest(value),{status:400});
  for(const value of [{action:'list'},{action:'details',pid:12},{action:'terminate',pid:12,token}])assert.deepEqual(processRequest(value),value);
});
test('process responses expose only metadata and a bounded identity; errors remain generic',()=>{
  const row=publicProcess({pid:12,name:'node\u0000',user:'demo',state:'Running',cpuPercent:999,memoryBytes:-1,startedAt:'bad',token,canTerminate:true,commandLine:'SECRET',environment:{password:'SECRET'}});
  assert.equal(row.name,'node');assert.equal(row.cpuPercent,100);assert.equal(row.memoryBytes,null);assert.equal(row.startedAt,null);assert.equal(row.canTerminate,true);assert.ok(!JSON.stringify(row).includes('SECRET'));
  assert.equal(publicProcess({pid:1,token,canTerminate:true}).canTerminate,false);
  assert.equal(publicProcess({pid:10,canTerminate:true}).canTerminate,false);
  assert.throws(()=>processResponse({ok:false,status:403,error:'SECRET'},'list'),e=>e.status===403&&!e.message.includes('SECRET'));
  assert.throws(()=>processResponse({ok:true,available:true,processes:[null],sampledAt:1},'list'));
});
test('lab permits mutation only for its owned process and matching identity',()=>{
  const worker={pid:123,token};
  assert.equal(labProcessRequest({action:'terminate',pid:123,token},worker),true);
  assert.equal(labProcessRequest({action:'terminate',pid:124,token},worker),false);
  assert.equal(labProcessRequest({action:'terminate',pid:123,token:'b'.repeat(64)},worker),false);
  assert.equal(labProcessRequest({action:'terminate',pid:123,token},null),false);
  assert.match(managedCommand('sudo -n /usr/bin/python3 -I /opt/viios-agent/processes.py','windows'),/-Helper processes$/);
});
test('process mutations serialize, use fixed command and JSON stdin, and re-enable after completion',async()=>{
  let child,args,request;
  const manager=createProcessManager({}, {profile:async()=>({transport:'ssh',sshTarget:'srv-test'}),spawn:(_cmd,a)=>{
    args=a;child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    child.stdin.on('data',chunk=>{request=JSON.parse(chunk);});return child;
  }});
  const pending=manager.run({action:'terminate',pid:123,token});
  await assert.rejects(manager.run({action:'terminate',pid:124,token}),{status:409});
  assert.equal(args.at(-1),'sudo -n /usr/bin/python3 -I /opt/viios-agent/processes.py');assert.deepEqual(request,{action:'terminate',pid:123,token});
  child.stdout.write('{"ok":true,"exited":true}');child.emit('close',0);assert.deepEqual(await pending,{ok:true,exited:true});
  manager.shutdown();await assert.rejects(manager.run({action:'details',pid:123}),{status:503});
});
test('HTTP process routes validate PID and body before invoking the target',async()=>{
  const seen=[];const app=express();app.use(express.json());app.use('/processes',processRouter({run:async request=>{processRequest(request);seen.push(request);return {ok:true};}}));app.use(apiErrorMiddleware);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const pathname of ['/processes/1;whoami','/processes/0','/processes/2147483648'])assert.equal((await fetch(base+pathname)).status,400);
    assert.equal((await fetch(base+'/processes/12/terminate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,command:'bad'})})).status,400);
    assert.equal(seen.length,0);
    assert.equal((await fetch(base+'/processes/12')).status,200);assert.deepEqual(seen,[{action:'details',pid:12}]);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
