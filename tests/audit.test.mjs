import test from 'node:test';
import assert from 'node:assert/strict';
import { annotate, csv, freePorts, freePortQuery, insights, inventoryReport, patchAnnotation } from '../server/audit.mjs';
import { reconcile } from '../server/history.mjs';

const app=(port,transports,active=true)=>({port,name:`App ${port}`,transports,active,addresses:['127.0.0.1'],protocol:transports[0],status:200,httpApplicable:true});
const fixture=()=>({start:1,end:65535,scannedAt:new Date().toISOString(),host:'example',apps:[app(8000,['tcp']),app(8001,['udp']),app(8002,['tcp','udp']),{...app(8003,['tcp'],false),control:{canStart:true}}]});
const query=(protocol='both')=>({start:'8000',end:'8005',protocol,excludeKnown:'false'});
test('free ports distinguish TCP, UDP, both and closed historical applications',()=>{
  const state=fixture();
  assert.deepEqual(freePorts(state,query()).ports.map(p=>p.port),[8003,8004,8005]);
  const tcp=freePorts(state,query('tcp'));assert.deepEqual(tcp.ports.map(p=>p.port),[8001,8003,8004,8005]);
  assert.equal(tcp.ports[0].otherProtocol,'UDP');
  assert.deepEqual(freePorts(state,query('udp')).ports.map(p=>p.port),[8000,8003,8004,8005]);
  assert.equal(tcp.ports[1].restartable,true);assert.equal(tcp.ports[1].previousName,'App 8003');
  const excluded=freePorts(state,{...query(),excludeKnown:'true'});assert.equal(excluded.excludedKnown,1);assert.equal(excluded.total,2);
});
test('loopback and duplicate IPv4/IPv6 listeners count as one occupied number',()=>{
  const state=fixture();state.apps[0].addresses=['127.0.0.1','::1'];state.apps.push({...state.apps[0]});
  assert.equal(freePorts(state,query()).occupied,3);
});
test('inclusive boundaries, pagination and full export preserve the same result',()=>{
  const state={...fixture(),apps:[]};
  assert.equal(freePorts(state,{start:'1',end:'1'}).ports[0].port,1);
  assert.equal(freePorts(state,{start:'65535',end:'65535'}).ports[0].port,65535);
  const result=freePorts(state,{start:'1',end:'1000',offset:'990',limit:'100'});assert.equal(result.total,1000);assert.equal(result.ports.length,10);assert.equal(result.ports[9].port,1000);
  assert.equal(freePorts(state,{start:'1',end:'1000',limit:'10'},true).ports.length,1000);
});
test('invalid range, protocol, scope and pagination never produce misleading results',()=>{
  for(const q of [{start:'0'},{end:'65536'},{start:'2',end:'1'},{start:'3.5'},{protocol:'http'},{protocol:['tcp']},{offset:'-1'},{limit:'501'},{excludeKnown:'yes'}])assert.throws(()=>freePortQuery(q),{status:400});
  assert.throws(()=>freePortQuery({start:'1',end:'99'},{start:8000,end:8999}),{status:400});
});
test('unknown scan returns unavailable, failed or old scan is explicitly stale',()=>{
  assert.throws(()=>freePorts({...fixture(),scannedAt:null},query()),{status:503});
  const state=fixture(),original=freePorts(state,query());
  const failed=freePorts({...state,error:'SSH unavailable'},query());assert.equal(failed.stale,true);assert.deepEqual(failed.ports,original.ports);assert.equal(failed.scannedAt,original.scannedAt);
  assert.equal(freePorts({...state,scannedAt:new Date(Date.now()-200000).toISOString()},query()).stale,true);
});
test('annotations survive fresh scan, PID replacement, closure and JSON persistence',()=>{
  let previous={...app(8097,['tcp']),pid:10};
  const annotations={'8097':patchAnnotation(undefined,{displayName:'Gölge',note:'Takip notu',favorite:true,expectedUp:true,tags:['demo']})};
  previous=reconcile([previous],[{...previous,pid:11}]).apps[0];
  const closed=reconcile([previous],[]).apps[0];
  const loaded=JSON.parse(JSON.stringify(annotations));
  for(const observed of [previous,closed]){const joined=annotate(observed,loaded);assert.equal(joined.name,'Gölge');assert.equal(joined.annotation.note,'Takip notu');assert.equal(joined.annotation.favorite,true);}
  assert.equal(annotate(previous,{}).name,'App 8097');
});
test('annotation patches validate lengths and types, preserve unrelated fields and reject stale revisions',()=>{
  const first=patchAnnotation(undefined,{note:'Not',favorite:true,tags:[' demo ','demo']});assert.deepEqual(first.tags,['demo']);
  const second=patchAnnotation(first,{favorite:false});assert.equal(second.note,'Not');assert.equal(second.revision,2);
  assert.throws(()=>patchAnnotation(second,{note:'Overwritten',revision:1}),{status:409});
  for(const patch of [{favorite:'yes'},{expectedUp:1},{note:'x'.repeat(2001)},{displayName:9},{tags:['a'.repeat(25)]},{tags:['a','b','c','d','e','f']},{pid:123},[]])assert.throws(()=>patchAnnotation(first,patch),{status:400});
});
test('audit priorities respect expected downtime and HTTP authentication/root responses',()=>{
  const apps=[{...app(1,['tcp'],false),annotation:{expectedUp:true}},{...app(2,['tcp'],false),annotation:{expectedUp:false}},...([401,403,404,500,null].map((status,i)=>({...app(10+i,['tcp']),status})))];
  const events=[{type:'closed',at:new Date().toISOString()},{type:'opened',at:new Date(Date.now()-90000000).toISOString()},{type:'control_failed',at:new Date().toISOString()}];
  const summary=insights(apps,events);assert.equal(summary.issues,3);assert.equal(summary.expectedDown,1);assert.equal(summary.opened24h,0);assert.equal(summary.closed24h,1);assert.equal(summary.failed24h,1);
});
test('CSV safely handles Turkish, quotes, multiline content and spreadsheet formulas',()=>{
  const out=csv([['Uygulama','Not'],['Gölge, geçiş','"Merhaba"\nİkinci satır'],['=1+1',' \t@SUM(A1)'],['-5','+5']]);
  assert.ok(out.startsWith('\uFEFF'));assert.ok(out.includes('"Gölge, geçiş"'));assert.ok(out.includes('""Merhaba""\nİkinci satır'));
  assert.ok(out.includes('"\'=1+1"'));assert.ok(out.includes('"\' \t@SUM(A1)"'));assert.ok(out.includes('"\'-5"'));
});
test('JSON inventory exports an explicit field list without command tokens or tunnels',()=>{
  const report=inventoryReport({...fixture(),apps:[{...app(8097,['tcp']),openUrl:'http://127.80.1.2:4321',control:{token:'secret'},env:{PASSWORD:'hidden'},annotation:{note:'Visible',favorite:true,tags:['demo']}}]});
  const raw=JSON.stringify(report);assert.ok(!raw.includes('secret'));assert.ok(!raw.includes('PASSWORD'));assert.ok(!raw.includes('127.80.1.2'));assert.equal(report.apps[0].note,'Visible');
});
