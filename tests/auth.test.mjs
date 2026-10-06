import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {createAuth,hashPassword,protectWrites,verifyPassword} from '../server/auth.mjs';

test('password hash validates correctly and malformed inputs are rejected',()=>{
  const hash=hashPassword('test-password-123');assert.ok(!hash.includes('test-password'));
  assert.equal(verifyPassword('test-password-123',hash),true);
  for(const input of ['bad',null,{},'x'.repeat(257)])assert.equal(verifyPassword(input,hash),false);
  assert.equal(verifyPassword('anything','scrypt:broken:hash'),false);
});
test('API auth, CSRF checks, cookie security, expiration, logout, and throttling',async t=>{
  let now=Date.now();const app=express();const auth=createAuth(hashPassword('test-password-123'),{now:()=>now});
  app.use(protectWrites,express.json());app.post('/login',auth.login);app.use(auth.require);app.get('/private',(_req,res)=>res.json({secret:true}));app.post('/logout',auth.logout);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  const login=(password,headers={})=>fetch(url+'/login',{method:'POST',headers:{'Content-Type':'application/json','X-Management-Request':'1',...headers},body:JSON.stringify({password})});
  assert.equal((await fetch(url+'/private')).status,401);
  assert.equal((await fetch(url+'/login',{method:'POST'})).status,403);
  assert.equal((await login('test-password-123',{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await login('wrong')).status,401);
  let result=await login('test-password-123');assert.equal(result.status,200);
  const setCookie=result.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  const cookie=setCookie.split(';')[0];assert.equal((await fetch(url+'/private',{headers:{Cookie:cookie}})).status,200);
  now+=8*60*60*1000+1;assert.equal((await fetch(url+'/private',{headers:{Cookie:cookie}})).status,401);
  result=await login('test-password-123');const newCookie=result.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url+'/logout',{method:'POST',headers:{Cookie:newCookie,'X-Management-Request':'1'}})).status,200);
  assert.equal((await fetch(url+'/private',{headers:{Cookie:newCookie}})).status,401);
  for(let i=0;i<8;i++)assert.equal((await login('incorrect')).status,401);
  assert.equal((await login('test-password-123')).status,429);
  now+=15*60*1000+1;assert.equal((await login('test-password-123')).status,200);
});
