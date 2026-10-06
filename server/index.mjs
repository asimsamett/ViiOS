import { createDesktopLayoutStore, desktopLayoutRouter } from './desktop-layout.mjs';
import {fileRouter} from './files.mjs';
import {createModelCatalog,modelCatalogRouter} from './model-catalog.mjs';
import {versionRouter} from './versioning.mjs';
import {apiErrorMiddleware} from './http-errors.mjs';
import {createTeamStore,teamRouter} from './team.mjs';
import {createAppCredentialStore,appCredentialsRouter} from './app-credentials.mjs';
import {createAppCredentialSync} from './app-credential-sync.mjs';
import {createConnectionManager,connectionRouter} from './connection-routes.mjs';
import {createAdminSetup} from './admin-setup.mjs';
import {createFleet} from './fleet.mjs';
import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {createAuth,protectWrites} from './auth.mjs';
import {freePorts,inventoryReport,inventoryCsv,csv} from './audit.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(existsSync(path.join(root,'.env')))loadEnvFile(path.join(root,'.env'));
const dataDir=path.resolve(process.env.DATA_DIR || path.join(root,'data'));
const fleet=createFleet({dataDir}),routers=new Map(),modelTargets=new Map(),credentialTargets=new Map();
function modelsFor(target){if(!modelTargets.has(target))modelTargets.set(target,createModelCatalog({dataDir:target.dataDir,mode:'ssh',sshTarget:target.inventory().serverId,privileged:true}));return modelTargets.get(target);}
function credentialServices(target){if(!credentialTargets.has(target)){const store=createAppCredentialStore({dataDir:target.dataDir});const sync=createAppCredentialSync({store,dataDir:target.dataDir,enabled:false,disabledReason:'Erişim bilgilerini bu sunucu için elle ekleyebilirsiniz.'});credentialTargets.set(target,{store,sync});}return credentialTargets.get(target);}
let auth;
const setup=await createAdminSetup({dataDir,onConfigured:hash=>{auth=createAuth(hash,{secure:process.env.COOKIE_SECURE==='true'});}});
if(setup.passwordHash())auth=createAuth(setup.passwordHash(),{secure:process.env.COOKIE_SECURE==='true'});
const manager=createConnectionManager({dataDir,onReady:profile=>fleet.add(profile),onRemove:async id=>{const target=fleet.targets.get(id);routers.delete(id);await modelTargets.get(target)?.shutdown();modelTargets.delete(target);await credentialTargets.get(target)?.sync.close();credentialTargets.delete(target);await fleet.remove(id);}});
await manager.initialize();
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");next();});
app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/api',protectWrites);
const smallJson=express.json({limit:'256kb'}),fileJson=express.json({limit:'24mb'});
app.use('/api',(req,res,next)=>{if(/^\/(?:servers\/srv-[a-f0-9]{24}\/)?files\/action$/.test(req.path)&&auth)return auth.require(req,res,()=>fileJson(req,res,next));return smallJson(req,res,next);});
app.get('/api/setup',(_req,res)=>res.json(setup.status()));
app.post('/api/setup',async(req,res)=>res.status(201).json(await setup.configure(req.body)));
app.post('/api/login',(req,res,next)=>auth?auth.login(req,res,next):res.status(409).json({error:'Önce ilk kurulumu tamamlayın.',setupRequired:true}));
app.use('/api',(req,res,next)=>auth?auth.require(req,res,next):res.status(401).json({error:'İlk kurulum gerekli.',setupRequired:true}));
app.get('/api/session',(_req,res)=>res.json({authenticated:true}));
app.post('/api/logout',(req,res)=>auth.logout(req,res));
app.use('/api/connections',connectionRouter(manager));
app.use('/api/team',teamRouter(createTeamStore({dataDir,resolveServer:id=>fleet.resolve(id)})));
app.get('/api/servers',(_req,res)=>res.json(fleet.list()));
app.post('/api/servers/discover',(_req,res)=>{fleet.tick();res.status(202).json({ok:true});});
function targetRouter(target) {
 const {inventory,scan,capture,applicationUrl,dataDir,history,markRead,controlStatus,controlApplication,updateAnnotation}=target;
 const router=express.Router();
 router.use('/desktop-layout',desktopLayoutRouter(createDesktopLayoutStore({dataDir})));
 const credentials=credentialServices(target);
 router.use('/credentials',appCredentialsRouter(credentials.store,{sync:credentials.sync}));
 router.use('/files',fileRouter(target.files));
 router.use('/versions',versionRouter({id:inventory().serverId,host:inventory().host,mode:'ssh',platform:inventory().platform,capabilities:inventory().capabilities}));
 router.use('/ops',(_req,res)=>res.status(501).json({error:'UAT ortamı bu taşınabilir sürümde yapılandırılmadı.'}));
 router.use('/models',modelCatalogRouter(modelsFor(target)));
router.get('/inventory',(_req,res)=>res.json(inventory()));
router.get('/resources',async(_req,res)=>res.json(await target.resources.read()));
router.get('/storage',async(_req,res)=>res.json(await target.storage.read()));
router.get('/storage/usage',(req,res)=>res.json(target.storage.usage(req.query)));
router.get('/storage/apps',(req,res)=>res.json(target.storage.apps(req.query)));
function historyQuery(query) {
  const port=query.port===undefined?null:Number(query.port);
  if(port!==null && (typeof query.port!=='string' || !/^[1-9]\d{0,4}$/.test(query.port) || port>65535))throw Object.assign(new Error('Geçersiz günlük portu.'),{status:400});
  if(query.period!==undefined && !['all','24h','7d'].includes(query.period))throw Object.assign(new Error('Geçersiz günlük dönemi.'),{status:400});
  return {notifications:query.notifications==='true',type:typeof query.type==='string'?query.type:'',port,since:query.period==='24h'?Date.now()-86400000:query.period==='7d'?Date.now()-7*86400000:0};
}
router.get('/events',(req,res)=>res.json(history({...historyQuery(req.query),limit:Math.max(1,Math.min(200,Number(req.query.limit)||100)),offset:Math.max(0,Number(req.query.offset)||0)})));
router.get('/ports/free',(req,res)=>{res.json(freePorts(inventory(),req.query));});
router.patch('/apps/:port/annotation',async(req,res)=>{
  if(!/^[1-9]\d{0,4}$/.test(req.params.port) || Number(req.params.port)>65535)return res.status(400).json({error:'Geçersiz port.'});
  res.json(await updateAnnotation(Number(req.params.port),req.body));
});
router.get('/reports/:kind',(req,res)=>{
  const format=req.query.format || 'csv';if(!['csv','json'].includes(format))return res.status(400).json({error:'CSV veya JSON seçin.'});
  let report,content;
  if(req.params.kind==='inventory') {report=inventoryReport(inventory());content=format==='csv'?inventoryCsv(report):null;}
  else if(req.params.kind==='events') {
    report={exportedAt:new Date().toISOString(),host:inventory().host,...history({...historyQuery(req.query),limit:10000})};
    content=format==='csv'?csv([['Sunucu','Zaman','Olay','Port','Uygulama','Açıklama'],...report.events.map(e=>[report.host,e.at,e.type,e.port,e.name,e.message])]):null;
  } else if(req.params.kind==='free-ports') {
    // Enumerate the full filtered range; the UI page size never truncates exports.
    const first=freePorts(inventory(),{...req.query,offset:'0',limit:'500'},true);
    const ports=first.ports;
    report={exportedAt:new Date().toISOString(),...first,ports};
    content=format==='csv'?csv([['Sunucu','Son tarama','Protokol filtresi','Port','Önceki uygulama','Diğer protokol','Veri eski'],...ports.map(p=>[report.host,report.scannedAt,report.filters.protocol,p.port,p.previousName,p.otherProtocol,report.stale?'Evet':'Hayır'])]):null;
  } else return res.status(404).json({error:'Rapor bulunamadı.'});
  res.setHeader('Content-Disposition',`attachment; filename="management-${req.params.kind}-${new Date().toISOString().slice(0,10)}.${format}"`);
  res.type(format==='csv'?'text/csv':'application/json').send(format==='csv'?content:JSON.stringify(report,null,2));
});
router.post('/notifications/read',async(req,res)=>{
  if(!Array.isArray(req.body?.ids) || req.body.ids.length>200 || req.body.ids.some(id=>typeof id!=='string'))return res.status(400).json({error:'Geçersiz bildirim kimlikleri.'});
  await markRead(req.body.ids);res.json({ok:true});
});
router.post('/scan',async(_req,res)=>{if(inventory().networkOnly)await scan();else void scan();res.status(202).json({ok:true});});
router.post('/previews',(_req,res)=>{void capture();res.status(202).json({ok:true});});
router.get('/apps/:port/control',async(req,res)=>{
  if(!/^[1-9]\d{0,4}$/.test(req.params.port) || Number(req.params.port)>65535)return res.status(400).json({error:'Geçersiz port.'});
  try {res.json(await controlStatus(Number(req.params.port)));}
  catch(error){res.status(error.status || 503).json({error:error.status ? error.message : 'Servis kontrolüne erişilemiyor.'});}
});
router.post('/apps/:port/control',async(req,res)=>{
  if(!/^[1-9]\d{0,4}$/.test(req.params.port) || Number(req.params.port)>65535)return res.status(400).json({error:'Geçersiz port.'});
  if(!req.body || Object.keys(req.body).some(k=>!['action','token'].includes(k)) || !['start','stop','restart'].includes(req.body.action) || typeof req.body.token!=='string' || !/^[a-f0-9]{64}$/.test(req.body.token))return res.status(400).json({error:'Geçersiz servis işlemi.'});
  try {res.json(await controlApplication(Number(req.params.port),req.body.action,req.body.token));}
  catch(error){res.status(error.status || 503).json({error:error.status ? error.message : 'Servis işlemi tamamlanamadı. Güncel durumu kontrol edin.'});}
});
router.get('/previews/:port',(req,res)=>{
  if(!/^\d{1,5}$/.test(req.params.port))return res.status(404).json({error:'Önizleme bulunamadı.'});
  const target=inventory().apps.find(a=>a.port===Number(req.params.port));
  if(!target?.previewAt)return res.status(404).json({error:'Önizleme henüz hazır değil.'});
  res.sendFile(path.join(dataDir,'previews',`${target.port}.jpg`),error=>{if(error && !res.headersSent)res.status(404).json({error:'Önizleme bulunamadı.'});});
});
router.get('/apps/:port/open',async(req,res)=>{
  if(!/^\d{1,5}$/.test(req.params.port))return res.status(404).json({error:'Uygulama bulunamadı.'});
  try {res.redirect(302,await applicationUrl(Number(req.params.port)));}catch(error){res.status(404).json({error:error.message});}
});
return router;
}
app.use('/api/servers/:serverId',(req,res,next)=>{try{const target=fleet.resolve(req.params.serverId);if(!routers.has(req.params.serverId))routers.set(req.params.serverId,targetRouter(target));return routers.get(req.params.serverId)(req,res,next);}catch(error){next(error);}});
app.use('/api',(req,res,next)=>{const target=fleet.primary;if(!target)return next();const id=target.inventory().serverId;if(!routers.has(id))routers.set(id,targetRouter(target));return routers.get(id)(req,res,next);});
app.use('/api',(_req,res)=>res.status(404).json({error:'Adres veya hazır sunucu bulunamadı.'}));
const publicDir=path.join(root,'dist','client');
app.use(express.static(publicDir,{index:'index.html',dotfiles:'deny',setHeaders(res,file){if(file.endsWith('.html'))res.setHeader('Cache-Control','no-store');}}));
app.use((_req,res)=>res.status(404).type('text').send('Sayfa bulunamadı.'));
app.use(apiErrorMiddleware);
const port=Number(process.env.APP_PORT||3180),host=process.env.APP_HOST||'127.0.0.1';
const server=app.listen(port,host,()=>{console.log(`ViiOS: http://${host}:${server.address().port}`);});
server.requestTimeout=0;
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
const background=process.env.BACKGROUND_SCANS_ENABLED!=='false',auto=Number(process.env.SCAN_INTERVAL_SECONDS||60);
const timer=background&&auto>0?setInterval(()=>fleet.tick(),Math.max(30,auto)*1000):null;
const dailyTimer=background?setInterval(()=>fleet.tick(false),30000):null;
timer?.unref();dailyTimer?.unref();
let closing=false;
async function close(){if(closing)return;closing=true;if(timer)clearInterval(timer);if(dailyTimer)clearInterval(dailyTimer);server.close();await manager.shutdown();await Promise.all([...credentialTargets.values()].map(({sync})=>sync.close()));await Promise.all([...modelTargets.values()].map(m=>m.shutdown()));await fleet.shutdown();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
