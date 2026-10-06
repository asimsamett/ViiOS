import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('../app/overview-state.ts',import.meta.url),'utf8'));
const {validateOverview,overviewIsFresh} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('resuming an old successful sample does not label it live',()=>{
 assert.equal(overviewIsFresh({status:'online',sampledAt:1},61002),false);
 assert.equal(overviewIsFresh({status:'online',sampledAt:1},1000),true);
 assert.equal(overviewIsFresh(null,1000),false);
});
test('unavailable and truncated payloads cannot replace the last successful overview',()=>{
 for(const value of [null,{}, {available:false}, {available:true,sampledAt:1}, {available:true,sampledAt:1,memory:{},disk:{},addresses:[],loadAverage:[],disks:[null],network:[],topProcesses:[]}])assert.throws(()=>validateOverview(value));
 const good={available:true,sampledAt:1,memory:{},disk:{},addresses:[],loadAverage:[],disks:[],network:[],topProcesses:[]};
 assert.doesNotThrow(()=>validateOverview(good));
});
