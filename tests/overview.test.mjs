import test from 'node:test';
import assert from 'node:assert/strict';
import { serverOverview } from '../server/overview.mjs';
import { labHelper, labForward } from '../scripts/server-lab.mjs';
import { managedCommand } from '../server/ssh-transport.mjs';
import { createDesktopLayoutStore } from '../server/desktop-layout.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../server/auth.mjs';

test('lab login and logout use a separate cookie without accepting the main cookie', () => {
  const auth = createAuth(hashPassword('local-test-password'), { cookieName: 'viios_lab_session' });
  let cookie = '', status = 200;
  const response = { setHeader(_name,value) { cookie=value; },json() {},status(value) {status=value;return this;} };
  auth.login({body:{password:'local-test-password'},socket:{remoteAddress:'127.0.0.1'},headers:{}},response);
  assert.ok(cookie.startsWith('viios_lab_session='));
  let accepted=false;
  auth.require({headers:{cookie:cookie.split(';')[0]}},response,()=>{accepted=true;});assert.equal(accepted,true);
  auth.require({headers:{cookie:cookie.replace('viios_lab_session=','viios_session=')}},response,()=>assert.fail('Wrong cookie accepted'));assert.equal(status,401);
  auth.logout({headers:{cookie}},response);assert.ok(cookie.startsWith('viios_lab_session=;'));
  assert.throws(()=>createAuth('unused',{cookieName:'bad; Secure'}));
});

test('overview strips secrets and invalid numbers without inventing zero measurements', () => {
  const result = serverOverview({available:true,sampledAt:1000,password:'secret',system:{cpuPercent:999,memory:{usedBytes:-1},disk:{}},overview:{version:1,platform:'windows',cpuTemperatureC:Infinity,environment:{TOKEN:'secret'},disks:[{name:'disk',readBytesPerSecond:0,writeBytesPerSecond:-1}],topProcesses:[{pid:1,name:'node',cpuPercent:NaN,memoryBytes:2,commandLine:'--password secret'}]}},1000);
  assert.equal(result.status,'online'); assert.equal(result.cpuPercent,null); assert.equal(result.memory.usedBytes,null);
  assert.equal(result.disks[0].readBytesPerSecond,0); assert.equal(result.disks[0].writeBytesPerSecond,null);
  assert.equal(result.cpuTemperatureC,null); assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('legacy agents retain basic telemetry and stale/future samples are not live', () => {
  const sample={available:true,sampledAt:1000,system:{cpuPercent:12,memory:{},disk:{}}};
  assert.equal(serverOverview(sample,1000).extended,false); assert.equal(serverOverview(sample,1000).cpuPercent,12);
  assert.equal(serverOverview(sample,62000).status,'unavailable'); assert.equal(serverOverview(sample,-5000).status,'unavailable');
  assert.equal(serverOverview(null).status,'unavailable');
});
test('local SSH lab rejects shells, extra arguments and forwarding to other endpoints', () => {
  const command=managedCommand('sudo -n /usr/bin/python3 -I /opt/viios-agent/resources.py','windows');
  assert.equal(labHelper(command),'resources'); assert.equal(labHelper(command+'; whoami'),null);
  assert.equal(labHelper('powershell.exe'),null); assert.equal(labHelper('sudo reboot'),null);
  assert.equal(labForward({destIP:'127.0.0.1',destPort:3281}),true);
  assert.equal(labForward({destIP:'192.0.2.1',destPort:3281}),false);
  assert.equal(labForward({destIP:'127.0.0.1',destPort:3180}),false);
});
test('monitor shortcuts persist alongside existing shortcuts and layout revisions', async () => {
  const dataDir=await mkdtemp(path.join(tmpdir(),'viios-overview-'));
  try {
    const store=createDesktopLayoutStore({dataDir});
    const dock=[{id:'action:services',kind:'action',label:'Services',view:'services'},{id:'action:overview',kind:'action',label:'Monitor',view:'overview'},{id:'action:processes',kind:'action',label:'Processes',view:'processes'},{id:'tasks',kind:'tasks',label:'Tasks'}];
    await store.save({revision:0,dock,desktop:dock});
    assert.deepEqual((await store.read()).dock,dock);
    assert.deepEqual((await store.read()).desktop,dock);
    await assert.rejects(store.save({revision:0,dock,desktop:null}),error=>error.status===409);
  } finally { await rm(dataDir,{recursive:true,force:true}); }
});
