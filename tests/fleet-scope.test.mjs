import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInventory} from '../server/inventory.mjs';
import {inventoryReport} from '../server/audit.mjs';
test('equal ports isolate notes, notifications and data across registered servers',async t=>{const base=await mkdtemp(path.join(os.tmpdir(),'viios-fleet-'));const make=n=>createInventory({id:'srv-'+String(n).padStart(24,'0'),host:`192.0.2.${n}`,mode:'network',dataDir:path.join(base,String(n))});const a=make(1),b=make(2);t.after(async()=>{await a.shutdown();await b.shutdown();await rm(base,{recursive:true,force:true});});await a.initialize();await b.initialize();const result={apps:[{port:8080,process:'web',directory:'/srv/example',pid:42,addresses:['127.0.0.1'],transports:['tcp'],kind:'web',protocol:'http',path:'/',httpApplicable:true,status:200,networkState:'open'}],reachable:true,checked:1,refusedKnown:[],unknownKnown:[]};await a.ingestNetwork(result);await b.ingestNetwork(result);await a.updateAnnotation(8080,{note:'Server A',favorite:true});assert.equal(a.inventory().apps[0].annotation.note,'Server A');assert.equal(b.inventory().apps[0].annotation.note,'');assert.notEqual(inventoryReport(a.inventory()).host,inventoryReport(b.inventory()).host);assert.notEqual(a.dataDir,b.dataDir);await assert.rejects(a.controlApplication(8080,'stop','0'.repeat(64)),{status:403});});
