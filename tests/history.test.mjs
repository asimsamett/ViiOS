import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyDue,healthOf,localDay,nextAudit,reconcile} from '../server/history.mjs';
const fixture=(port,status=200)=>({port,status,name:`App ${port}`,pid:port,directory:`/opt/${port}`,kind:'web',httpApplicable:true,protocol:'http',transports:['tcp']});
const at='2026-09-09T21:00:00.000Z';
test('midnight is evaluated in Istanbul, once per local day with retry backoff',()=>{
  assert.equal(localDay(new Date('2026-09-09T20:59:59Z')),'2026-09-09');
  assert.equal(localDay(new Date(at)),'2026-09-10');
  assert.equal(nextAudit(new Date('2026-09-09T20:59:59Z')),at);
  assert.equal(dailyDue('2026-09-09',null,new Date(at)),true);
  assert.equal(dailyDue('2026-09-10',null,new Date(at)),false);
  assert.equal(dailyDue('2026-09-09',at,new Date('2026-09-09T21:01:00Z')),false);
  assert.equal(dailyDue('2026-09-09',at,new Date('2026-09-09T21:05:00Z')),true);
});
test('initial inventory is logged without notification flooding',()=>{
  const r=reconcile([], [fixture(8000),fixture(8001)],{initial:true,at});
  assert.equal(r.events.length,2);assert.ok(r.events.every(e=>e.type==='discovered' && !e.notify));
  assert.ok(r.apps.every(a=>a.active && a.firstSeen===at));
});
test('new, closed, repeated closed and reopened port retain identity and preview',()=>{
  const base=reconcile([],[fixture(8000)],{initial:true,at}).apps;
  base[0].previewAt=at;
  const changed=reconcile(base,[fixture(8001)],{at});
  assert.deepEqual(changed.events.map(e=>e.type),['opened','closed']);
  const closed=changed.apps.find(a=>a.port===8000);assert.equal(closed.active,false);assert.equal(closed.previewAt,at);
  assert.equal(reconcile(changed.apps,[fixture(8001)],{at}).events.length,0);
  const reopened=reconcile(changed.apps,[fixture(8000),fixture(8001)],{at});
  assert.deepEqual(reopened.events.map(e=>e.type),['reopened']);assert.equal(reopened.apps[0].firstSeen,at);
});
test('API 401/403/404 replies are up; 5xx and missing web responses are distinct',()=>{
  for(const code of [200,301,401,403,404])assert.equal(healthOf({...fixture(8,code),active:true}),'up');
  assert.equal(healthOf(fixture(8,503)),'degraded');assert.equal(healthOf(fixture(8,null)),'unreachable');
  assert.equal(healthOf({...fixture(22,null),httpApplicable:false}),'listening');
  const previous=[{...fixture(8),active:true}];
  const down=reconcile(previous,[{...fixture(8,null),httpApplicable:false,httpProbeError:'Unknown'}],{at});
  assert.equal(down.apps[0].health,'unreachable');assert.equal(down.apps[0].httpApplicable,true);
  assert.equal(down.events[0].type,'unreachable');
  assert.equal(reconcile(down.apps,[fixture(8)],{at}).events[0].type,'recovered');
});
test('unchanged scans do not create duplicate logs; different app PID clears stale preview',()=>{
  const old=[{...fixture(1),active:true,previewAt:at}];
  assert.equal(reconcile(old,[fixture(1)],{at}).events.length,0);
  assert.equal(reconcile(old,[{...fixture(1),pid:99}],{at}).apps[0].previewAt,undefined);
});
test('TCP/UDP additions on a shared port generate a change event',()=>{
  const old=[{...fixture(53,null),httpApplicable:false,active:true}];
  const next=[{...old[0],transports:['tcp','udp']}];
  assert.equal(reconcile(old,next,{at}).events[0].type,'bindings_changed');
});
