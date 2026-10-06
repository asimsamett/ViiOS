import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
const source=stripTypeScriptTypes(await readFile(new URL('../app/process-state.ts',import.meta.url),'utf8'));
const {filterProcesses}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('process search spans PID, owner, name and state, sorting leaves unknown values last',()=>{
  const rows=[{pid:2,name:'Node',user:'demo',state:'Running',cpuPercent:null},{pid:3,name:'Node',user:'demo',state:'Running',cpuPercent:10},{pid:1,name:'Python',user:'root',state:'Sleep',cpuPercent:25}];
  assert.deepEqual(filterProcesses(rows,'NODE DEMO','pid',false).map(x=>x.pid),[2,3]);
  assert.deepEqual(filterProcesses(rows,'3 running','pid',false).map(x=>x.pid),[3]);
  assert.deepEqual(filterProcesses(rows,'','cpuPercent',true).map(x=>x.pid),[1,3,2]);
  assert.deepEqual(filterProcesses(rows,'','cpuPercent',false).map(x=>x.pid),[3,1,2]);
  assert.deepEqual(rows.map(x=>x.pid),[2,3,1]);
});
