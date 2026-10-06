import { createFileManager } from './files.mjs';
import { createResourceMonitor } from './resources.mjs';
import { createStorageMonitor } from './storage.mjs';
import { spawn } from './ssh-transport.mjs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dailyDue, event, localDay, nextAudit, reconcile, timezone } from './history.mjs';
import { annotate, insights, patchAnnotation } from './audit.mjs';
import { projectApps } from './project-catalog.mjs';
import { enrichClosedModels } from './model-connections.mjs';

let previewActive=0;const previewWaiters=[];
async function previewSlot(){if(previewActive>=2)await new Promise(resolve=>previewWaiters.push(resolve));else previewActive++;return ()=>{const next=previewWaiters.shift();if(next)next();else previewActive--;};}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createInventory(config = {}) {
const dataDir = config.dataDir || path.resolve(root, process.env.DATA_DIR || 'data');
const sshTarget = config.sshTarget || config.id || 'none';
const mode = config.mode || process.env.TARGET_MODE || 'ssh';
const start = Number(process.env.PORT_RANGE_START || 1), end = Number(process.env.PORT_RANGE_END || 65535);
if (!['ssh', 'local', 'network'].includes(mode) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) throw new Error('Geçersiz tarama ayarı.');
if (!/^[a-zA-Z0-9_.@-]+$/.test(sshTarget) || sshTarget.startsWith('-')) throw new Error('Geçersiz SSH hedefi.');
const sshBase = ['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2'];
const state = { apps: [], scannedAt: null, scanning: false, capturing: false, controlling: null, pendingControlScan:false, controlError: null, error: config.initialError || null, previewError: null, serverId: config.id || 'none', networkOnly:mode==='network', networkAutoFull:config.networkAutoFull!==false, networkProgress:null, networkCoverage:null, host: config.host || process.env.TARGET_HOST || '', hostname: config.name || sshTarget, mode, platform:config.platform || 'linux', capabilities:config.capabilities || {}, start, end, events: [], lastDailyAuditDay: localDay(), lastDailyAttemptAt: null };
const files=createFileManager({id:config.id || 'none',mode,host:state.host,log:async(type,message)=>{state.events.push(event(type,message));await persist();}});
const resources=createResourceMonitor({id:config.id || 'none',mode,host:state.host});
const storage=createStorageMonitor({id:config.id || 'none',mode,host:state.host},{applications:()=>inventory().apps});
const tunnels = new Map();
const metadata = {};
let annotations = {};
let closed = false;
let browser;
let cooldown = 0;
let writeQueue = Promise.resolve();
let controlRefresh;
const workers = new Set();
function command(command, args, input, timeout = 90000) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}); workers.add(child);
    let out='',err='',done=false;
    const timer=setTimeout(() => { child.kill(); finish(new Error('Bağlantı zaman aşımına uğradı.')); },timeout);
    function finish(error) { if(done)return; done=true; clearTimeout(timer); workers.delete(child); if(error)reject(error);else resolve(out); }
    child.stdout.on('data',d => {out+=d; if(out.length>4*1024*1024){child.kill();finish(new Error('Yanıt sınırı aşıldı.'));}});
    child.stderr.on('data',d => {err=(err+d).slice(-3000);});
    child.on('error',finish); child.on('close',code => finish(code===0 ? null : new Error(err || `İşlem kodu: ${code}`)));
    child.stdin.on('error',()=>{}); child.stdin.end(input || '');
  });
}
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function unusedPort() { return new Promise((resolve,reject) => {const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}); }
const tunnelHost = app => `127.${config.tunnelNamespace || 80}.${Math.floor(app.port/256)}.${app.port%256}`;
async function ready(port,host) { return new Promise(resolve => {const s=net.connect({host,port});s.setTimeout(200);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});}); }
async function tunnel(app) {
  const current=tunnels.get(app.port);
  if(current && current.child.exitCode===null && !current.child.killed) return current.port;
  if(closed) throw new Error('Uygulama kapanıyor.');
  const port=await unusedPort();
  const remoteHost=app.probeHost==='::1' ? '[::1]' : app.probeHost || '127.0.0.1';
  const child=spawn('ssh',[...sshBase,'-N','-o','ExitOnForwardFailure=yes','-L',`${tunnelHost(app)}:${port}:${remoteHost}:${app.port}`,sshTarget],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let failure=''; child.stderr.on('data',d=>{failure=(failure+d).slice(-1000);});child.on('error',()=>{failure='SSH başlatılamadı.';});
  const record={port,child,proxy:null};
  tunnels.set(app.port,record);
  child.on('exit',()=>{record.proxy?.close();if(tunnels.get(app.port)?.child===child)tunnels.delete(app.port);});
  for(let attempt=0;attempt<50;attempt++){
    if(await ready(port,tunnelHost(app))){
      const hostHeader=metadata[String(app.port)]?.hostHeader;
      if(hostHeader && app.internal && app.protocol==='http') {
        record.proxy=http.createServer((req,res)=>{
          const upstream=http.request({host:tunnelHost(app),port,path:req.url,method:req.method,headers:{...req.headers,host:hostHeader}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
          upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Servise erişilemedi.');});
          req.pipe(upstream);
        });
        await new Promise((resolve,reject)=>{record.proxy.once('error',reject);record.proxy.listen(0,tunnelHost(app),resolve);});
        record.port=record.proxy.address().port;
      }
      return record.port;
    }
    if(child.exitCode!==null || failure.includes('failed'))break;await sleep(100);
  }
  child.kill(); tunnels.delete(app.port); throw new Error('SSH tüneli kurulamadı.');
}
function appMetadata(app) {const extra=metadata[String(app.port)] || {};return extra.expectedDirectory && app.directory && extra.expectedDirectory!==app.directory ? {} : extra;}
function normalize(app) {
  const extra=appMetadata(app);
  const known={'sshd':'SSH · Uzak Erişim','systemd-resolve':'DNS · Sistem Çözümleyicisi','avahi-daemon':'Avahi · Ağ Keşfi','cupsd':'CUPS · Yazdırma Yönetimi','ollama':'Ollama · Model Servisi'};
  const fallback=app.entry ? app.entry.replace(/\.py$/, '').replace(/_/g,' ') : path.basename(app.directory || '') || app.process || `Servis ${app.port}`;
  return {...app,name:extra.name || app.title || known[app.process] || ((app.process || '').startsWith('code-')?'VS Code · Remote Server':fallback),path:extra.path || app.path || '/'};
}
function publicHost() { const host=state.host; return host.includes(':') ? `[${host}]` : host; }
function directUrl(app) { return `${app.protocol}://${publicHost()}:${app.port}${app.path}`; }
function inventory() {
  const {events,...publicState}=state;
  const apps=state.apps.map(app=>{
    const active=tunnels.get(app.port);
    const openUrl=app.networkState==='unknown' || app.active===false || app.httpApplicable===false ? null : mode==='ssh' && app.internal ? active && `${app.protocol}://${tunnelHost(app)}:${active.port}${app.path}` : !app.internal ? directUrl(app) : null;
    return {...annotate(app,annotations),openUrl:openUrl || null};
  });
  return {...publicState,stale:!!state.error || !state.scannedAt || Date.now()-new Date(state.scannedAt).getTime()>180000,apps:projectApps(apps,{id:state.serverId,host:state.host}),insights:insights(apps,events),timezone,nextAuditAt:nextAudit(),unread:events.filter(e=>e.notify && !e.read).length};
}
async function persist() {
  const cache=JSON.stringify({host:state.host,hostname:state.hostname,mode,start,end,sshTarget,error:state.error,scannedAt:state.scannedAt,apps:state.apps,annotations,events:state.events.slice(-10000),lastDailyAuditDay:state.lastDailyAuditDay,lastDailyAttemptAt:state.lastDailyAttemptAt,networkCoverage:state.networkCoverage},null,2);
  const next=writeQueue.catch(()=>{}).then(async()=>{await writeFile(path.join(dataDir,'inventory.tmp'),cache);await rename(path.join(dataDir,'inventory.tmp'),path.join(dataDir,'inventory.json'));});
  writeQueue=next; await next;
}
async function scan(reason='manual') {
  if(mode==='network'){return config.onNetworkScan?.(state.host,reason);}
  if(state.scanning || state.capturing || state.controlling || closed)return;
  if(reason!=='control' && Date.now()<cooldown)return;
  cooldown=Date.now()+10000;state.scanning=true;
  const previousError=state.error; state.error=null;
  if(reason==='daily')state.lastDailyAttemptAt=new Date().toISOString();
  try {
    const script=await readFile(path.join(root,'server','scan.py'),'utf8');
    if(!state.host && mode==='ssh') {
      const config=await command('ssh',['-G',sshTarget],null,15000);
      state.host=/^hostname (.+)$/m.exec(config)?.[1]?.trim() || sshTarget;
    }
    if(!state.host)state.host='127.0.0.1';
    const headers=Object.fromEntries(Object.entries(metadata).filter(([,value])=>value.hostHeader).map(([port,value])=>[port,value.hostHeader]));
    // Header overrides are encoded inside the trusted script rather than shell arguments.
    const input=`import sys\nsys.argv = ['scan.py', '${start}', '${end}', ${JSON.stringify(JSON.stringify(headers))}]\n`+script;
    const output=mode==='ssh' ? await command('ssh',[...sshBase,sshTarget,'sudo -n /usr/bin/python3 -I /opt/viios-agent/scan.py 1 65535'],null)
      : process.env.SCANNER_PRIVILEGED==='true'
        ? await command('sudo',['-n','/usr/bin/python3','-I',path.join(root,'server','scan.py'),String(start),String(end)])
        : await command(process.env.PYTHON_COMMAND || 'python3',['-'],input);
    const result=JSON.parse(output);
    if(!Array.isArray(result.apps))throw new Error('Geçersiz envanter yanıtı.');
    const at=new Date().toISOString();
    const changes=reconcile(state.apps,result.apps.map(normalize),{at,initial:!state.scannedAt});
    state.apps=enrichClosedModels(changes.apps,result.modelProfiles);state.events.push(...changes.events);
    try {
      const {controls}=await controlCommand({action:'status'});
      for(const app of state.apps)app.control=controls[String(app.port)] || {canStop:false,canStart:false,reason:'Kayıtlı başlatma bilgisi yok.'};
      state.controlError=null;
    } catch {
      state.controlError='Servis kontrol bilgileri alınamadı. Yeniden taramayı deneyin.';
      for(const app of state.apps)app.control={canStop:false,canStart:false,reason:state.controlError};
    }
    for(const [port,item] of tunnels)if(!state.apps.some(a=>a.port===port && a.active)){item.child.kill();tunnels.delete(port);}
    if(previousError)state.events.push(event('connection_restored','Sunucu bağlantısı yeniden kuruldu.',null,at,true));
    if(!['automatic','control'].includes(reason))state.events.push(event(reason==='daily'?'daily_audit':'scan',`${reason==='daily'?'Günlük denetim':'Port taraması'} tamamlandı: ${result.apps.length} açık, ${state.apps.filter(a=>!a.active).length} kapalı port.`,null,at));
    if(reason==='daily')state.lastDailyAuditDay=localDay();
    state.hostname=result.hostname;state.scannedAt=at;state.pendingControlScan=false;
    state.events=state.events.slice(-10000);
    await persist();
  } catch(error) {
    console.error('Tarama başarısız:',error.message);
    state.error=mode==='ssh' ? 'Sunucuya bağlanılamadı. SSH bağlantısını ve sunucu erişimini kontrol edin.' : 'Yerel port taraması tamamlanamadı. Python 3 ve ss komutunu kontrol edin.';
    if(!previousError)state.events.push(event('connection_error','Sunucuya erişilemedi. Port durumları son başarılı taramadan korunuyor.',null,undefined,true));
    await persist().catch(()=>{});
  } finally {state.scanning=false;}
  if(!state.error)void capture(false);
}
async function browserLaunch() {
  const options={headless:true,chromiumSandbox:process.platform!=='win32' && process.getuid?.()!==0};
  const executables=[process.env.BROWSER_EXECUTABLE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
  const executable=executables.find(p=>p && existsSync(p));
  return chromium.launch({...options,...(executable ? {executablePath:executable} : {})});
}
async function capture(force=true) {
  if(state.capturing || state.scanning || state.controlling || closed)return;
  if(!state.apps.some(a=>a.active!==false && a.networkState!=='unknown' && a.kind==='web' && (force || !a.previewAt || Date.now()-new Date(a.previewAt).getTime()>15*60*1000)) && mode==='network')return;
  state.capturing=true;state.previewError=null;
  const release=await previewSlot();
  if(closed){release();state.capturing=false;return;}
  try {
    // Local forwards also make loopback-only applications available to this computer.
    for(const app of state.apps.filter(a=>a.active!==false && a.httpApplicable!==false && a.internal && mode==='ssh')) {
      try {await tunnel(app);}catch{app.previewError='SSH tüneli kurulamadı.';}
    }
    const queue=state.apps.filter(a=>a.active!==false && a.networkState!=='unknown' && a.kind==='web' && (force || !a.previewAt || Date.now()-new Date(a.previewAt).getTime()>15*60*1000));
    if(!queue.length)return;
    browser=await browserLaunch();
    const work=async()=>{
      while(queue.length && !closed){
        const app=queue.shift(); let context;
        try {
          const targetPort=mode==='ssh' ? await tunnel(app) : app.port;
          const host=mode==='ssh' ? tunnelHost(app) : app.probeHost;
          const url=`${app.protocol}://${host==='::1'?'[::1]':host}:${targetPort}${app.path}`;
          context=await browser.newContext({viewport:{width:1280,height:760},deviceScaleFactor:1,ignoreHTTPSErrors:!!app.tlsUnverified,serviceWorkers:'block',acceptDownloads:false});
          const page=await context.newPage();
          const expectedHost=appMetadata(app).hostHeader;
          if(expectedHost && !app.internal)await page.route('**/*',async route=>{
            const request=route.request();
            if(new URL(request.url()).host===new URL(url).host){const response=await route.fetch({headers:{...request.headers(),host:expectedHost}});await route.fulfill({response});}
            else await route.continue();
          });
          if(process.env.PREVIEW_BLOCK_EXTERNAL_FONTS==='true') {
            // Offline deployments use the application's fallback fonts instead of
            // waiting on blocked Google Fonts stylesheets and font downloads.
            await page.route(/^https?:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
          }
          // Screenshots load the unauthenticated UI; no credentials or profile are shared.
          page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
          const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:18000});
          if(response && response.status()>=400)throw new Error(`HTTP ${response.status()}`);
          await page.waitForLoadState('networkidle',{timeout:3500}).catch(()=>{});
          await page.waitForTimeout(1400);
          const temp=path.join(dataDir,'previews',`${app.port}.tmp.jpg`);
          await page.screenshot({path:temp,type:'jpeg',quality:76,fullPage:false,timeout:10000});
          await rename(temp,path.join(dataDir,'previews',`${app.port}.jpg`));
          const latest=state.apps.find(a=>a.port===app.port && a.pid===app.pid && a.directory===app.directory && a.protocol===app.protocol && a.path===app.path && a.active!==false);
          if(latest){latest.previewAt=new Date().toISOString();latest.previewError=undefined;}
        } catch(error) {app.previewError=error.message.startsWith('HTTP ') ? error.message : 'Uygulama görüntüsü alınamadı. Yenilemeyi deneyin.';}
        finally {await context?.close().catch(()=>{});}
      }
    };
    await Promise.all([work(),work(),work()]);
    await persist();
  } catch(error) {console.error('Önizleme:',error.message);state.previewError='Önizleme tarayıcısı başlatılamadı. Sunucuda Chromium kurulumunu kontrol edin.';}
  finally {await browser?.close().catch(()=>{});browser=null;state.capturing=false;release();}
}
async function controlCommand(request,retry=0) {
  if(mode==='network')throw Object.assign(new Error('Bu sunucu ağ üzerinden izleniyor. Başlat/durdur için sunucu erişimi yapılandırılmalı.'),{status:403});
  const input=JSON.stringify(request);
  // Remote helper is installed in a fixed, root-owned location. No user input
  // enters SSH's command string or the sudo argument list.
  const output=mode==='ssh'
    ? await command('ssh',[...sshBase,sshTarget,'sudo -n /usr/bin/python3 -I /opt/viios-agent/control.py'],input,150000)
    : await command('sudo',['-n','/usr/bin/python3','-I',path.join(root,'server','control.py')],input,150000);
  const result=JSON.parse(output);
  // Local and server panels share the broker lock. Brief read-only overlap
  // should not hide all manageable apps or fail a freshly opened action dialog.
  if(!result.ok && result.status===409 && request.action==='status' && retry<4){await sleep(250*(retry+1));return controlCommand(request,retry+1);}
  if(!result.ok)throw Object.assign(new Error(result.error || 'Servis kontrolü tamamlanamadı.'),{status:result.status || 503});
  return result;
}
async function controlStatus(port) {
  if(!state.apps.some(app=>app.port===port))throw Object.assign(new Error('Uygulama bulunamadı.'),{status:404});
  return controlCommand({action:'status',port});
}
function refreshAfterControl() {
  clearTimeout(controlRefresh);
  if(closed)return;
  if(state.scanning || state.capturing || state.controlling){controlRefresh=setTimeout(refreshAfterControl,500);controlRefresh.unref();return;}
  void scan('control');
}
async function controlApplication(port,action,token) {
  if(mode==='network')throw Object.assign(new Error('Ağ üzerinden izlenen sunucuda servis kontrolü kullanılamaz.'),{status:403});
  const app=state.apps.find(a=>a.port===port);
  if(!app)throw Object.assign(new Error('Uygulama bulunamadı.'),{status:404});
  if(state.controlling)throw Object.assign(new Error('Başka bir servis işlemi sürüyor.'),{status:409});
  if(state.scanning)throw Object.assign(new Error('Port taraması sürüyor. Birkaç saniye sonra tekrar deneyin.'),{status:409});
  state.controlling={port,action};state.pendingControlScan=true;
  const actionLabel={stop:'Durdurma',start:'Başlatma',restart:'Yeniden başlatma'}[action];
  state.events.push(event('control_requested',`${actionLabel} istendi.`,app));
  try {
    // Persist the intent before changing a service, including failed attempts.
    await persist();
    const result=await controlCommand({action,port,token});
    state.events.push(event({stop:'control_stopped',start:'control_started',restart:'control_restarted'}[action],result.message,app,undefined,true));
    const at=new Date().toISOString();
    for(const affected of state.apps.filter(a=>result.affectedPorts.includes(a.port))){
      if(action==='stop'){
        if(affected.active)state.events.push(event('closed','Port yönetim panelinden durduruldu.',affected,at));
        Object.assign(affected,{active:false,health:'closed',closedAt:at,lastSeen:at});
      } else if(affected.port===port){
        if(!affected.active)state.events.push(event('reopened','Port yönetim panelinden yeniden açıldı.',affected,at));
        Object.assign(affected,{active:true,health:affected.httpApplicable===false?'listening':'unreachable',status:null,closedAt:null,lastSeen:at,previewAt:undefined});
      }
      affected.control={...result.control};
    }
    await persist();
    return result;
  } catch(error) {
    state.events.push(event('control_failed',`${actionLabel} tamamlanamadı: ${error.message}`,app,undefined,true));
    await persist().catch(()=>{});
    throw error;
  } finally {
    state.controlling=null;
    refreshAfterControl();
  }
}
async function applicationUrl(port) {
  const app=state.apps.find(a=>a.port===port);
  if(!app)throw new Error('Uygulama bulunamadı.');
  if(app.active===false)throw new Error('Bu port kapalı.');
  if(app.networkState==='unknown')throw new Error('Bu porta ağ erişimi doğrulanamadı.');
  if(app.httpApplicable===false)throw new Error('Bu servis web tarayıcısıyla açılmaz.');
  if(mode==='ssh' && app.internal)return `${app.protocol}://${tunnelHost(app)}:${await tunnel(app)}${app.path}`;
  if(app.internal)throw new Error('Bu uygulama yalnızca sunucunun yerel arabiriminde erişilebilir.');
  return directUrl(app);
}
async function initialize({background=true}={}) {
  await mkdir(path.join(dataDir,'previews'),{recursive:true});
  try {
    const cache=JSON.parse(await readFile(path.join(dataDir,'inventory.json'),'utf8'));
    if(cache.mode===mode && cache.start===start && cache.end===end && cache.sshTarget===sshTarget && (!state.host || state.host===cache.host)) {
      state.apps=cache.apps.map(a=>({...a,previewAt:a.previewAt && existsSync(path.join(dataDir,'previews',`${a.port}.jpg`)) ? a.previewAt : undefined}));
      state.scannedAt=cache.scannedAt;state.hostname=cache.hostname;state.error=cache.error || state.error;state.networkCoverage=cache.networkCoverage || null;
      annotations=cache.annotations && typeof cache.annotations==='object' && !Array.isArray(cache.annotations)?cache.annotations:{};
      state.events=cache.events || [];state.lastDailyAuditDay=cache.lastDailyAuditDay || localDay();state.lastDailyAttemptAt=cache.lastDailyAttemptAt || null;
    }
  } catch{}
  if(background && mode!=='network')void scan(dailyDue(state.lastDailyAuditDay,state.lastDailyAttemptAt)?'daily':'startup');
}
function scheduledScan() {void scan(dailyDue(state.lastDailyAuditDay,state.lastDailyAttemptAt)?'daily':'automatic');}
function history({notifications=false,type='',limit=100,offset=0,port=null,since=0}={}) {
  const events=state.events.filter(e=>(!notifications || e.notify) && (!type || e.type===type) && (port===null || e.port===port) && (!since || new Date(e.at).getTime()>=since)).slice().reverse();
  return {total:events.length,events:events.slice(offset,offset+limit).map(e=>({...e,previewAt:state.apps.find(a=>a.port===e.port)?.previewAt || null})),timezone,nextAuditAt:nextAudit(),lastDailyAuditDay:state.lastDailyAuditDay};
}
async function markRead(ids) {const selected=new Set(ids);for(const item of state.events)if(selected.has(item.id))item.read=true;await persist();}
async function updateAnnotation(port,patch) {
  const app=state.apps.find(a=>a.port===port);
  if(!app)throw Object.assign(new Error('Uygulama bulunamadı.'),{status:404});
  const next=patchAnnotation(annotations[String(port)],patch);
  annotations[String(port)]=next;
  state.events.push(event('annotation_updated','Port adı, notu veya takip tercihleri güncellendi.',annotate(app,annotations)));
  await persist();return {ok:true,annotation:next};
}
async function shutdown() {closed=true;files.shutdown();resources.shutdown();storage.shutdown();for(const {child,proxy} of tunnels.values()){proxy?.close();child.kill();}for(const child of workers)child.kill();await browser?.close().catch(()=>{});await writeQueue.catch(()=>{});}

function networkProgress(progress) {state.networkProgress=progress;}
async function ingestNetwork(result) {
  const at=new Date().toISOString(),previousError=state.error;
  state.networkProgress=null;
  if(!result.reachable){
    state.error='Sunucu ağ üzerinden yanıt vermiyor. Son başarılı kayıtlar korunuyor.';
    if(!previousError)state.events.push(event('connection_error',state.error,null,at,true));
    await persist();return;
  }
  const refused=new Set(result.refusedKnown),incoming=new Map(result.apps.map(a=>[a.port,normalize(a)]));
  for(const previous of state.apps)if(previous.active && !incoming.has(previous.port) && !refused.has(previous.port)){
    incoming.set(previous.port,{...previous,networkState:'unknown',status:null});
  }
  const changes=reconcile(state.apps,[...incoming.values()],{at,initial:!state.scannedAt});
  state.apps=changes.apps.map(a=>({...a,control:{canStop:false,canStart:false,canRestart:false,reason:'Ağ üzerinden izleniyor. Servis yönetimi için sunucu erişimi gerekli.'}}));
  state.events.push(...changes.events);state.error=null;state.controlError=null;state.scannedAt=at;
  if(previousError)state.events.push(event('connection_restored','Sunucu yeniden ağ üzerinden yanıt veriyor.',null,at,true));
  state.networkCoverage={...state.networkCoverage,lastChecked:result.checked,refused:result.refused,unknown:result.unknown,...(result.full?{fullScannedAt:at}:{}),note:'Yalnızca ağdan erişilebilen TCP portları. UDP, yerel dinleyiciler ve süreçler için SSH erişimi gerekir.'};
  if(result.full){state.lastDailyAuditDay=localDay();state.events.push(event('daily_audit','1–65535 TCP portunun ağ denetimi tamamlandı. Yanıtsız portlar boş kabul edilmez.',null,at));}
  state.events=state.events.slice(-10000);await persist();void capture(false);
}
return {files,resources,storage,inventory,scan,capture,applicationUrl,initialize,shutdown,dataDir,scheduledScan,history,markRead,controlStatus,controlApplication,updateAnnotation,ingestNetwork,networkProgress};
}
