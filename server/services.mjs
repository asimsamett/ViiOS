import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, readConnectionProfile } from './ssh-transport.mjs';
import { sharedResourceSample } from './resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reads = new Set(['list','details','logs']);
export const serviceActions = ['start','stop','restart','enable','disable','automatic','manual','disabled'];
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const text = (value,limit=256) => typeof value==='string' ? value.replace(/\p{Cc}/gu,' ').slice(0,limit) : '';
export function serviceRequest(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || (!reads.has(value.action)&&!serviceActions.includes(value.action))) throw fail('Geçersiz servis işlemi.');
  const fields = value.action==='list' ? ['action'] : value.action==='details' ? ['action','name'] : value.action==='logs' ? ['action','name','limit'] : ['action','name','token'];
  if (Object.keys(value).length!==fields.length || fields.some(key=>!Object.hasOwn(value,key))) throw fail('Geçersiz servis alanları.');
  if(value.action!=='list' && (typeof value.name!=='string'||! /^[A-Za-z0-9_][A-Za-z0-9_.@:\\ -]{0,254}$/.test(value.name))) throw fail('Geçersiz servis adı.');
  if(value.action==='logs' && (!Number.isInteger(value.limit)||value.limit<1||value.limit>200)) throw fail('Günlük sınırı 1–200 olmalı.');
  if(!reads.has(value.action) && (typeof value.token!=='string'|| !/^[a-f0-9]{64}$/.test(value.token))) throw fail('Geçersiz servis kimliği.');
  return value;
}
export function redactServiceLog(value) {
  return text(value,4096)
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END[\s\S]*?PRIVATE KEY-----|$)/gi,'[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi,'$1 [REDACTED]')
    .replace(/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@');
}
export function publicService(value) {
  if(!value || typeof value.name!=='string') throw fail('Geçersiz servis yanıtı.',502);
  const token=typeof value.token==='string'&&/^[a-f0-9]{64}$/.test(value.token)?value.token:null;
  return {name:text(value.name),displayName:text(value.displayName),description:text(value.description,1000),state:text(value.state),subState:text(value.subState),startup:text(value.startup),
    pid:Number.isInteger(value.pid)&&value.pid>0?value.pid:null,token,
    actions:token&&Array.isArray(value.actions)?[...new Set(value.actions.filter(action=>serviceActions.includes(action)))]:[],
    reason:text(value.reason,500),canLogs:value.canLogs===true,lab:value.lab===true,
    dependencies:Array.isArray(value.dependencies)?value.dependencies.slice(0,100).map(name=>text(name)):[],
    dependents:Array.isArray(value.dependents)?value.dependents.slice(0,100).map(name=>text(name)):[]};
}
export function serviceResponse(value,action) {
  if(value?.ok!==true) throw fail(value?.status===409?'Servisin durumu veya yapılandırması değişti. Ayrıntıları yeniden açın.':value?.status===403?'Bu servis korumalı veya yönetim izni verilmemiş.':value?.status===404?'Servis artık bulunamıyor.':value?.status===501?'Bu işletim sistemi servis işlemini desteklemiyor.':'Servis işlemi tamamlanamadı. Sunucu izinlerini ve agent sürümünü kontrol edin.',[400,403,404,409,413,501,503,504].includes(value?.status)?value.status:503);
  if(action==='list') {
    if(!value.available||!Array.isArray(value.services)||value.services.length>2000||!Number.isFinite(value.sampledAt))throw fail('Servis listesi alınamadı.',502);
    return {available:true,platform:['windows','linux'].includes(value.platform)?value.platform:null,sampledAt:value.sampledAt,partial:value.partial===true,services:value.services.map(publicService)};
  }
  if(action==='logs') return {available:value.available===true,reason:text(value.reason,500),entries:Array.isArray(value.entries)?value.entries.slice(-200).map(row=>({at:Number.isFinite(row.at)?row.at:null,priority:Number.isInteger(row.priority)&&row.priority>=0&&row.priority<=7?row.priority:null,message:redactServiceLog(row.message)})):[]};
  return {ok:true,service:publicService(value.service)};
}
export function createServiceManager(config,dependencies={}) {
  let closed=false,mutating=false;
  const workers=new Set();
  async function execute(request) {
    const profile=await (dependencies.profile||readConnectionProfile)(config);
    if(closed)throw fail('Servis yöneticisi kapanıyor.',503);
    if(!profile)throw fail('Servis yönetimi için yönetim bağlantısı gerekli.',501);
    const args=profile.transport==='ssh'?['-o','BatchMode=yes','-o','ConnectTimeout=8',profile.sshTarget,'sudo -n /usr/bin/python3 -I /opt/viios-agent/services.py']:['-n','/usr/bin/python3','-I',path.join(root,'server/services.py')];
    const raw=await new Promise((resolve,reject)=>{
      const child=(dependencies.spawn||spawn)(profile.transport==='ssh'?'ssh':'sudo',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});workers.add(child);let out='',done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);workers.delete(child);if(error)reject(error);else resolve(out);};
      const failure=()=>fail('Servis yanıtı alınamadı. Durumu yenileyerek kontrol edin; gönderilmiş bir işlem sunucuda devam ediyor olabilir.',503);
      const timer=setTimeout(()=>{child.kill();finish(failure());},60000);
      child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8*1024*1024){child.kill();finish(failure());}});child.stderr.resume();
      child.on('error',()=>finish(failure()));child.stdin.on('error',()=>finish(failure()));child.on('close',code=>finish(code===0?null:failure()));child.stdin.end(JSON.stringify(request));
    });
    let value;try{value=JSON.parse(raw);}catch{throw fail('Geçersiz servis yanıtı.',502);}return serviceResponse(value,request.action);
  }
  let list=sharedResourceSample(()=>execute({action:'list'}));
  return {async run(value){if(closed)throw fail('Servis yöneticisi kapanıyor.',503);const request=serviceRequest(value);if(request.action==='list')return list();if(reads.has(request.action))return execute(request);if(mutating)throw fail('Başka bir servis işlemi sürüyor.',409);mutating=true;try{return await execute(request);}finally{mutating=false;list=sharedResourceSample(()=>execute({action:'list'}));}},shutdown(){closed=true;for(const child of workers)child.kill();}};
}
export function serviceRouter(manager) {
  const router=express.Router();
  router.get('/',async(_req,res)=>res.json(await manager.run({action:'list'})));
  router.get('/:name',async(req,res)=>res.json(await manager.run({action:'details',name:req.params.name})));
  router.get('/:name/logs',async(req,res)=>{if(req.query.limit!==undefined&&(typeof req.query.limit!=='string'||!/^\d{1,3}$/.test(req.query.limit)))throw fail('Geçersiz günlük sınırı.');res.json(await manager.run({action:'logs',name:req.params.name,limit:Number(req.query.limit??100)}));});
  router.post('/:name/action',async(req,res)=>{if(!req.body||Object.keys(req.body).length!==2||!Object.hasOwn(req.body,'action')||!Object.hasOwn(req.body,'token')||!serviceActions.includes(req.body.action))throw fail('Geçersiz servis işlemi.');res.json(await manager.run({action:req.body.action,name:req.params.name,token:req.body.token}));});
  return router;
}
