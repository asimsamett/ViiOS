import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAdminSetup} from '../server/admin-setup.mjs';
import {verifyPassword} from '../server/auth.mjs';
const password='12345678';
test('first administrator accepts a matching eight-character simple password without a code, only once',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'viios-setup-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let hash;const setup=await createAdminSetup({dataDir,onConfigured:value=>{hash=value;}});
 assert.deepEqual(setup.status(),{required:true});assert.equal(setup.passwordHash(),null);
 await assert.rejects(readFile(path.join(dataDir,'setup.token')),{code:'ENOENT'});
 for(const input of [{password:'1234567',confirmPassword:'1234567'},{password,confirmPassword:'different'},{password:'x'.repeat(257),confirmPassword:'x'.repeat(257)}])await assert.rejects(setup.configure(input),{status:400});
 const results=await Promise.allSettled([setup.configure({password,confirmPassword:password}),setup.configure({password,confirmPassword:password})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(verifyPassword(password,hash),true);
 assert.equal((await readFile(path.join(dataDir,'admin.json'),'utf8')).includes(password),false);
 const restart=await createAdminSetup({dataDir});assert.deepEqual(restart.status(),{required:false});assert.equal(restart.passwordHash(),hash);
 await assert.rejects(restart.configure({password,confirmPassword:password}),{status:409});
});
test('previous setup token files do not block code-free setup with a short mixed password',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'viios-setup-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 await writeFile(path.join(dataDir,'setup.token'),'obsolete-fixture-code');
 const setup=await createAdminSetup({dataDir});const example='Demo2026!';
 assert.deepEqual(await setup.configure({password:example,confirmPassword:example}),{configured:true});
 assert.equal(verifyPassword(example,setup.passwordHash()),true);
});
test('corrupt administrator data fails closed instead of resetting first-run claim',async t=>{const dataDir=await mkdtemp(path.join(os.tmpdir(),'viios-setup-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));await writeFile(path.join(dataDir,'admin.json'),'{}');await assert.rejects(createAdminSetup({dataDir}),{status:503});});
