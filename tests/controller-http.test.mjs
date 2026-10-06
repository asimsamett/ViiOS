import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('controller first-run, auth, empty fleet, CSRF, isolation and private files work over real HTTP',async t=>{
 const cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'viios-http-'));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd,windowsHide:true,env:{...process.env,DATA_DIR:dataDir,APP_PORT:'0',APP_HOST:'127.0.0.1',BACKGROUND_SCANS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const closed=once(child,'exit');child.kill();await closed;}await rm(dataDir,{recursive:true,force:true});});
 const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Controller startup timeout')),20000);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/ViiOS: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',()=>{clearTimeout(timer);reject(new Error('Controller exited before ready'));});});


const write=(url,body={},cookie='')=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Management-Request':'1',Origin:base,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
assert.deepEqual(await (await fetch(base+'/api/setup')).json(),{required:true});
assert.equal((await fetch(base+'/api/connections')).status,401);
assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
assert.equal((await write('/api/setup',{password:'short',confirmPassword:'short'})).status,400);
assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Management-Request':'1',Origin:'https://foreign.example'},body:JSON.stringify({password:'Demo2026!',confirmPassword:'Demo2026!'})})).status,403);
assert.equal((await write('/api/setup',{password:'Demo2026!',confirmPassword:'Demo2026!'})).status,201);
const login=await write('/api/login',{password:'Demo2026!'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const authGet=url=>fetch(base+url,{headers:{Cookie:cookie}});
assert.deepEqual(await (await authGet('/api/connections')).json(),{servers:[]});
assert.equal((await (await authGet('/api/servers')).json()).servers.length,0);
assert.equal((await authGet('/api/servers/srv-'+'a'.repeat(24)+'/resources')).status,404);
assert.equal((await write('/api/connections',{host:'bad;command',platform:'linux'},cookie)).status,400);
assert.equal((await fetch(base+'/api/connections/probe',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Management-Request':'1',Origin:'https://foreign.example'},body:'{}'})).status,403);
assert.equal((await fetch(base+'/.env')).status,404);assert.equal((await fetch(base+'/data/admin.json')).status,404);
assert.equal((await write('/api/setup',{},cookie)).status,409);
assert.equal((await write('/api/logout',{},cookie)).status,200);assert.equal((await authGet('/api/session')).status,401);


});
