import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serviceRequest } from '../server/services.mjs';
export const labServiceName='ViiOSLabService';
const fail=(message,status)=>Object.assign(new Error(message),{status});
export async function createLabService({root,dataDir,port=3291}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw fail('Invalid lab service port.',400);
  const configFile=path.join(dataDir,'service.json');let mode='Auto';
  try{const saved=JSON.parse(await readFile(configFile,'utf8'));if(!['Auto','Manual','Disabled'].includes(saved.startup))throw fail('Invalid lab service configuration.',503);mode=saved.startup;}catch(error){if(error.code!=='ENOENT')throw error;}
  let child=null,state='Stopped',busy=false,closed=false,revision=0,listeningPort=port;const boot=randomUUID(),events=[];
  const event=message=>{events.push({at:Date.now(),priority:6,message});if(events.length>200)events.shift();};
  const row=()=>({name:labServiceName,displayName:'ViiOS Lab Service',description:'Disposable process-based service fixture on loopback port 3291. This is not a Windows SCM service.',state,subState:'',startup:mode,pid:child?.pid||null,
    token:createHash('sha256').update(`${boot}:${revision}:${state}:${mode}:${child?.pid||0}`).digest('hex'),actions:closed||busy?[]:[...(state==='Running'?['stop',...(mode==='Disabled'?[]:['restart'])]:mode==='Disabled'?[]:['start']),...['automatic','manual','disabled'].filter(action=>({automatic:'Auto',manual:'Manual',disabled:'Disabled'})[action]!==mode)],reason:'',dependencies:[],dependents:[],canLogs:true,lab:true});
  async function start(){
    if(child||closed)throw fail('Lab service is already running or closed.',409);
    state='Start Pending';revision++;
    const worker=spawn(process.execPath,[path.join(root,'scripts/lab-service-worker.mjs'),String(port)],{cwd:root,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});child=worker;
    worker.once('exit',()=>{if(child===worker){child=null;state='Stopped';revision++;event('Lab service process exited.');}});
    try{await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.kill();reject(fail('Lab service readiness timeout.',503));},10000);
      const done=error=>{clearTimeout(timer);worker.removeListener('error',onError);worker.removeListener('exit',onExit);worker.removeListener('message',onReady);if(error)reject(error);else resolve();};
      const onError=()=>done(fail('Lab service could not start.',503)),onExit=()=>done(fail('Lab service exited before readiness. The configured port may be occupied.',503)),onReady=message=>{if(message?.ready===true){listeningPort=message.port;done();}};
      worker.once('error',onError);worker.once('exit',onExit);worker.on('message',onReady);
    });state='Running';revision++;event('Lab service started; HTTP readiness verified.');}
    catch(error){worker.kill();if(child===worker)child=null;state='Failed';revision++;throw error;}
  }
  async function stop(){
    const worker=child;if(!worker){state='Stopped';return;}
    state='Stop Pending';revision++;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(fail('Lab service exit not confirmed.',503)),10000);worker.once('exit',()=>{clearTimeout(timer);resolve();});worker.kill();});
    state='Stopped';revision++;event('Lab service stopped; process exit verified.');
  }
  if(mode==='Auto')await start();
  return {row,port:()=>listeningPort,
    async run(request){serviceRequest(request);if(request.name!==labServiceName)throw fail('Only the dedicated lab service permits mutations.',403);if(closed)throw fail('Lab service is closed.',503);
      if(request.action==='details')return {ok:true,service:row()};
      if(request.action==='logs')return {ok:true,available:true,entries:events.slice(-request.limit)};
      if(busy)throw fail('Another lab service operation is running.',409);
      const current=row();if(current.token!==request.token)throw fail('Lab service state changed.',409);if(!current.actions.includes(request.action))throw fail('Lab service action unavailable.',403);
      busy=true;
      try{if(request.action==='restart'){await stop();await start();}else if(request.action==='start')await start();else if(request.action==='stop')await stop();else{const next={automatic:'Auto',manual:'Manual',disabled:'Disabled'}[request.action];await writeFile(configFile,JSON.stringify({startup:next}));mode=next;revision++;event(`Lab startup preference changed to ${mode}; current running state unchanged.`);}busy=false;return {ok:true,service:row()};}finally{busy=false;}
    },
    async shutdown(){closed=true;await stop();},
  };
}
