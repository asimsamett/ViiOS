import test from 'node:test';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
const source=stripTypeScriptTypes(await readFile(new URL('../app/service-state.ts',import.meta.url),'utf8'));
const {filterServices}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('service search, platform status filters and sorting preserve original data',()=>{
 const rows=[{name:'win',displayName:'Database',state:'Running',startup:'Manual',pid:20,actions:['stop']},{name:'linux',displayName:'Web',state:'active',startup:'enabled',pid:10,actions:[]},{name:'off',displayName:'Worker',state:'Stopped',startup:'Disabled',pid:null,actions:[]}];
 assert.equal(filterServices(rows,'database','all','name',false)[0].name,'win');
 assert.deepEqual(filterServices(rows,'','running','pid',false).map(row=>row.pid),[10,20]);
 assert.equal(filterServices(rows,'','stopped','name',false).length,1);assert.equal(filterServices(rows,'','readonly','name',false).length,2);
 assert.deepEqual(filterServices(rows,'','all','pid',true).map(row=>row.pid),[20,10,null]);assert.equal(rows[0].name,'win');
});
