'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Bookmark, CircleHelp, Clock3, FolderOpen, History, Network, Play, RefreshCw, RotateCw, Server, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import HistoryPanel from './history-panel';
import PortExplorer from './port-explorer';
import PortInventory, { ServicePreview } from './port-inventory';
import AnnotationDialog from './annotation-dialog';
import HelpPanel from './help-panel';
import ReportsPanel from './reports-panel';
import ModelConnections from './model-connections';
import ModelCatalog from './model-catalog';
import PeoplePanel from './people-panel';
import AppCredentials from './app-credentials';
import StoragePanel from './storage-panel';
import LockScreen from './lock-screen';
import SetupScreen from './setup-screen';
import ServerConnections from './server-connections';
import Appearance, { useWallpaper } from './appearance';
import ViiBrandIcon from './vii-brand-icon';
import { api as globalApi } from './api';
import { TeamProvider } from './team-context';
import FileDesktop from './file-desktop';
import ControlActions, { actionAllowed, actionText, actionTitle } from './control-actions';
import type { App, Control, ControlAction, Inventory } from './types';
import type { DesktopView } from './launcher-data';
import { TargetProvider, useTarget } from './target-context';
import ServerPicker from './server-picker';
import { DEMO_MODE } from '@/lib/public-mode';
import DemoFrame from './demo-frame';
import AclNoticeDialog from './acl-notice';
const time=(value:string|null|undefined)=>value?new Date(value).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}):'—';

export default function Home(){
 return <>{DEMO_MODE ? <DemoFrame><WorkspaceEntry/></DemoFrame> : <WorkspaceEntry/>}<AclNoticeDialog/></>;
}
function WorkspaceEntry(){
 const [phase,setPhase]=useState<'checking'|'setup'|'locked'|'ready'|'error'>('checking');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  async function bootstrap(){
   try{
    const setup=await globalApi<{required:boolean}>('/setup',{signal:controller.signal,cache:'no-store'});
    if(controller.signal.aborted)return;
    if(setup.required){setPhase('setup');return;}
    try{await globalApi('/session',{signal:controller.signal});if(!controller.signal.aborted)setPhase('ready');}
    catch(reason){if(controller.signal.aborted)return;if((reason as {status?:number}).status===401)setPhase('locked');else throw reason;}
   }catch(reason){if(!controller.signal.aborted){setError((reason as Error).message);setPhase('error');}}
  }
  void bootstrap();return()=>controller.abort();
 },[revision]);
 if(phase==='setup')return <SetupScreen onConfigured={()=>{setNotice('Yönetici şifreniz oluşturuldu. Yeni şifrenizle giriş yapın.');setPhase('locked');}}/>;
 if(phase==='ready')return <AuthenticatedWorkspace onSessionLost={()=>{setNotice('');setPhase('locked');}}/>;
 if(phase==='error')return <main className="onboarding-shell"><section className="setup-card"><ViiBrandIcon/><h1>ViiOS’a bağlanılamadı.</h1><p className="onboarding-error" role="alert">{error}</p><Button onClick={()=>{setPhase('checking');setRevision(value=>value+1);}}><RefreshCw size={16}/>Tekrar dene</Button></section></main>;
 return <LockScreen pending={phase==='checking'} notice={notice} onLogin={()=>{setNotice('');setPhase('ready');}}/>;
}
function AuthenticatedWorkspace({onSessionLost}:{onSessionLost:()=>void}){
 const [serverId,setServerId]=useState('none');
 const [servers,setServers]=useState<{id:string;name:string;host:string}[]|null>(null),[error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const wallpaper=useWallpaper('desktop');
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>|undefined,request:AbortController|null=null;
  const cancel=()=>{clearTimeout(timer);request?.abort();request=null;};
  async function load(){
   if(!active || document.hidden || request)return;
   const controller=new AbortController();request=controller;
   try{
    const result=await globalApi<{servers:{id:string;name:string;host:string}[]}>('/servers',{signal:controller.signal,cache:'no-store'});
    if(!active || controller.signal.aborted)return;
    setServers(result.servers);setError('');
    setServerId(current=>result.servers.some(server=>server.id===current)?current:result.servers[0]?.id || 'none');
   }catch(reason){if(active && !controller.signal.aborted){if((reason as {status?:number}).status===401)onSessionLost();else setError((reason as Error).message);}}
   finally{if(request===controller)request=null;if(active && !controller.signal.aborted && !document.hidden)timer=setTimeout(()=>void load(),5000);}
  }
  const wake=()=>{cancel();if(!document.hidden)void load();};
  timer=setTimeout(()=>void load(),0);document.addEventListener('visibilitychange',wake);window.addEventListener('viios-connections-changed',wake);
  return()=>{active=false;cancel();document.removeEventListener('visibilitychange',wake);window.removeEventListener('viios-connections-changed',wake);};
 },[revision,onSessionLost]);
 async function logout(){if(DEMO_MODE){location.reload();return;}try{await globalApi('/logout',{method:'POST',body:'{}'});onSessionLost();}catch(reason){setError((reason as Error).message);}}
 if(serverId!=='none' && servers?.some(server=>server.id===serverId))return <TargetProvider key={serverId} id={serverId}><DesktopSession onServer={setServerId} onSessionLost={onSessionLost}/></TargetProvider>;
 return <main className="vii-wallpaper onboarding-shell" data-wallpaper={wallpaper}><header className="onboarding-topbar"><span><ViiBrandIcon/><strong>ViiOS</strong><small>Visual Infrastructure Intelligence</small></span><div><Appearance/><Button variant="outline" onClick={()=>void logout()}>Oturumu kapat</Button></div></header><div className="onboarding-workspace"><section className="onboarding-welcome"><span className="onboarding-eyebrow">ÇALIŞMA ALANINIZ HAZIR</span><h1>Sunucularınızı bir araya getirin.</h1><p>Windows ve Linux ortamlarınızı bağlayın; uygulamaları, dosyaları ve kaynakları aynı masaüstünden yönetin. Kullanılabilir özellikler her sunucuda ayrıca doğrulanır.</p></section>{error && <div className="onboarding-error" role="alert">{error}<Button variant="outline" onClick={()=>setRevision(value=>value+1)}>Yeniden dene</Button></div>}{!servers && !error ? <p className="onboarding-loading"><RefreshCw className="spin" size={18}/>Sunucularınız alınıyor…</p> : <ServerConnections onSelect={id=>{setServerId(id);setRevision(value=>value+1);}}/>}</div></main>;
}
function DesktopSession({onServer,onSessionLost}:{onServer:(id:string)=>void;onSessionLost:()=>void}){
 const {api,url,id:serverId}=useTarget();
 const [inventory,setInventory]=useState<Inventory|null>(null);
 const [selected,setSelected]=useState<App|null>(null),[message,setMessage]=useState(''),[connectionError,setConnectionError]=useState('');
 const [actionPending,setActionPending]=useState(false),[controlBusy,setControlBusy]=useState(false),[fileBusy,setFileBusy]=useState(false);
 const [panel,setPanel]=useState<'events'|'notifications'|null>(null),[eventPort,setEventPort]=useState<number|null>(null);
 const [controlDialog,setControlDialog]=useState<{app:App;action:ControlAction;control?:Control;error?:string}|null>(null);
 const [editing,setEditing]=useState<App|null>(null);
 const [fileRequest,setFileRequest]=useState<{id:number;path:string}|null>(null);
 const [navigationRequest,setNavigationRequest]=useState<{id:number;view:DesktopView}|null>(()=>{
  const view=typeof window!=='undefined'?new URLSearchParams(window.location.search).get('view'):null;
  return view && ['models','ports','reports','people','help','endpoints','servers','credentials','storage'].includes(view)?{id:1,view:view as DesktopView}:null;
 });
 function navigate(view:DesktopView){setNavigationRequest(current=>({id:(current?.id || 0)+1,view}));}
 function openFiles(path:string){setSelected(null);setPanel(null);setFileRequest(current=>({id:(current?.id || 0)+1,path}));}
 function showHistory(port:number|null=null){setEventPort(port);setPanel('events');setSelected(null);}
 const refresh=useCallback(async()=>{
  try{setInventory(await api<Inventory>('/inventory'));setConnectionError('');}
  catch(e){if((e as {status?:number}).status===401){onSessionLost();}else setConnectionError((e as Error).message);}
 },[api,onSessionLost]);
 useEffect(()=>{const first=setTimeout(()=>void refresh(),0),timer=setInterval(()=>void refresh(),3000);return()=>{clearTimeout(first);clearInterval(timer);};},[refresh]);
 useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(''),5000);return()=>clearTimeout(timer);},[message]);
 useEffect(()=>{
  const context=(document as Document & {modelContext?:{registerTool:(tool:Record<string,unknown>,options:{signal:AbortSignal})=>void|Promise<void>}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const tools=[
   {name:'list_monitored_applications',description:'Read the latest monitored ports and application status in this authenticated management panel.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async()=>{const data=await api<Inventory>('/inventory');setInventory(data);return {scannedAt:data.scannedAt,apps:data.apps.map(a=>({port:a.port,name:a.name,active:a.active,health:a.health}))};}},
   {name:'start_port_scan',description:'Start a read-only scan of the configured server. This updates the management inventory and event log asynchronously.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:async()=>{await api('/scan',{method:'POST',body:'{}'});await refresh();return {started:true};}},
  ];
  for(const tool of tools){try{void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
  return()=>lifecycle.abort();
 },[api,refresh]);
 async function run(path:string){setActionPending(true);try{await api(path,{method:'POST',body:'{}'});await refresh();}catch(e){setMessage((e as Error).message);}finally{setActionPending(false);}}
 async function prepareControl(app:App,action:ControlAction){setControlDialog({app,action});setControlBusy(true);try{const result=await api<{control:Control}>(`/apps/${app.port}/control`);setControlDialog({app,action,control:result.control});}catch(e){setControlDialog({app,action,error:(e as Error).message});}finally{setControlBusy(false);}}
 async function applyControl(){if(!controlDialog?.control?.token)return;setControlBusy(true);try{const result=await api<{message:string}>(`/apps/${controlDialog.app.port}/control`,{method:'POST',body:JSON.stringify({action:controlDialog.action,token:controlDialog.control.token})});setMessage(result.message);setControlDialog(null);await refresh();}catch(e){setControlDialog({...controlDialog,error:(e as Error).message});await refresh();}finally{setControlBusy(false);}}
 async function logout(){if(DEMO_MODE){location.reload();return;}if(fileBusy || controlBusy)return;try{await api('/logout',{method:'POST',body:'{}'});onSessionLost();}catch{setMessage('Çıkış yapılamadı. Tekrar deneyin.');}}
 const controls=(app:App)=><ControlActions app={app} inventory={inventory} busy={controlBusy} onAction={(target,action)=>void prepareControl(target,action)}/>;
 const apps=inventory?.apps || [],current=selected && (apps.find(app=>app.port===selected.port) || selected),busy=!!inventory?.scanning || actionPending;
 function renderPanel(view:DesktopView,visible:boolean){
  switch(view){
   case 'models':return <ModelCatalog/>;
   case 'people':return <PeoplePanel/>;
   case 'credentials':return visible?<AppCredentials query=""/>:null;
   case 'storage':return <StoragePanel key={serverId} visible={visible}/>;
   case 'endpoints':return <PortInventory inventory={inventory} busy={controlBusy} onAction={(app,action)=>void prepareControl(app,action)} onSelect={setSelected} onHistory={showHistory} onAnnotate={setEditing} onMessage={setMessage} onRefresh={refresh}/>;
   case 'ports':return inventory?.networkOnly?<div className="empty-state"><Network size={30}/><h3>Boş port doğrulaması için sunucu erişimi gerekir</h3><p>Ağ üzerinden yanıt gelmemesi portun boş olduğunu kanıtlamaz.</p></div>:<PortExplorer inventory={inventory} onSelect={port=>setSelected(apps.find(app=>app.port===port) || null)} onMessage={setMessage} onScan={()=>void run('/scan')}/>;
   case 'reports':return <ReportsPanel inventory={inventory} onMessage={setMessage} onPorts={()=>navigate('ports')}/>;
   case 'help':return <HelpPanel onGo={view=>view==='files'?openFiles('/'):navigate(view)}/>;
   case 'servers':return <div className="desktop-server-panel"><ServerPicker selected={serverId} onSelect={onServer} disabled={controlBusy || fileBusy}/><section className="server-strip" aria-label="Bağlı sunucu"><div className="server-identity"><span className="server-icon"><Server size={21}/></span><div><strong>{inventory?.hostname || 'Seçili sunucu'}</strong><span>{inventory?.host || 'Bağlanıyor…'}</span></div><span className={`server-connection ${inventory?.error || connectionError?'error':''}`}>{inventory?.error || connectionError?'Bağlantı sorunu':inventory?.scannedAt?inventory.stale?'Güncellik bekleniyor':'Bağlı':'Bağlanıyor'}</span></div><div className="server-meta"><span><Clock3 size={15}/>Son tarama <strong>{time(inventory?.scannedAt)}</strong></span></div></section>{(inventory?.error || connectionError) && <div className="notice error-notice" role="alert">{inventory?.error || connectionError}</div>}{inventory?.networkOnly && <div className="notice"><Network size={18}/><span>Ağ üzerinden izleniyor. Süreç bilgisi, UDP ve servis yönetimi için sunucu erişimi gerekir.</span></div>}<Button variant="outline" disabled={busy} onClick={()=>void run('/scan')}><RefreshCw size={16} className={busy?'spin':''}/>{busy?'Taranıyor…':'Portları yeniden tara'}</Button></div>;
   default:return null;
  }
 }
 return <TeamProvider><div className="desktop-session"><FileDesktop inventory={inventory} busy={controlBusy} onAction={(app,action)=>void prepareControl(app,action)} onHistory={showHistory} fileRequest={fileRequest} repoRequest={null} navigationRequest={navigationRequest} renderPanel={renderPanel} host={inventory?.host || ''} apps={apps} onApp={setSelected} onMessage={setMessage} onBusy={setFileBusy} onLogout={()=>void logout()} onNotifications={()=>setPanel('notifications')} notificationCount={inventory?.unread || 0} onScan={()=>void run('/scan')} scanning={busy} connectionError={inventory?.error || connectionError}/>
  <Dialog open={!!current} onOpenChange={open => {if(!open)setSelected(null);}}><DialogContent className="app-dialog" showCloseButton={false}>{current && <><DialogHeader><div className="dialog-heading"><div><DialogTitle>{current.name}</DialogTitle><DialogDescription>{inventory?.host}:{current.port} · {current.kind==='web' ? 'Web uygulaması' : 'API / servis'}</DialogDescription></div><Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="Önizlemeyi kapat"><X /></Button></div></DialogHeader>{controls(current)}<ServicePreview app={current} large /><div className="detail-grid"><div><span>PORT / PROTOKOL</span><strong>{current.port} / {current.protocol.toUpperCase()}</strong></div><div><span>{current.httpApplicable===false ? 'DİNLEME DURUMU' : 'HTTP DURUMU'}</span><strong>{current.active===false ? 'Kapalı · Son yanıt '+(current.status || '—') : current.httpApplicable===false ? 'Dinliyor · HTTP servisi değil' : (current.status || 'Yanıt yok')+' · '+current.latency+' ms'}</strong></div><div><span>ERİŞİM</span><strong>{current.internal ? 'Sunucu içi' : 'Ağ üzerinden'}</strong></div><div><span>İŞLEM</span><strong>{current.process || 'Bilinmiyor'} {current.pid && `· PID ${current.pid}`}</strong></div><div><span>İLK GÖRÜLME</span><strong>{current.firstSeen ? new Date(current.firstSeen).toLocaleString('tr-TR') : '—'}</strong></div><div><span>{current.active===false ? 'KAPANMA' : 'SON KONTROL'}</span><strong>{(current.closedAt || current.lastSeen) ? new Date((current.closedAt || current.lastSeen)!).toLocaleString('tr-TR') : '—'}</strong></div><div className="detail-wide"><span>DİNLEYEN ADRESLER</span><code>{current.listeners?.map(l=>`${l.transport.toUpperCase()} ${l.address}:${current.port}`).join(' · ') || current.addresses.join(', ')}</code></div><div className="detail-wide"><span>UYGULAMA DİZİNİ</span><code>{current.directory || 'Dizin bilgisi alınamadı'}</code></div></div><ModelConnections apps={[current]}/><div className="detail-audit-actions">{current.filesPath && <Button variant="outline" onClick={()=>openFiles(current.filesPath!)}><FolderOpen size={15}/>Dosyalara git</Button>}<Button variant="outline" onClick={()=>{setEditing(current);setSelected(null);}}><Bookmark size={15}/>Port notu ve takip</Button><Button variant="outline" onClick={()=>showHistory(current.port)}><History size={15}/>Bu portun günlüğü</Button></div>{current.annotation?.note && <div className="detail-port-note"><strong>Port notu</strong><p>{current.annotation.note}</p></div>}{current.status===404 && <p className="detail-note">Servis yanıt veriyor; kök adreste bir sayfa tanımlı değil. Bu durum tek başına servisin çalışmadığı anlamına gelmez.</p>}{current.tlsUnverified && <p className="detail-note">HTTPS sertifikası tarama sırasında doğrulanamadı. Önizleme, sertifika kontrolü atlanarak alındı.</p>}{current.previewError && <p className="detail-note">Önizleme: {current.previewError}</p>}<div className="dialog-footer"><span><Clock3 size={14} />Görüntü: {time(current.previewAt)}</span>{current.openUrl && <a className="primary-link" href={url(`/apps/${current.port}/open`)} target="_blank" rel="noopener noreferrer">Uygulamayı aç <ArrowUpRight size={17} /></a>}</div></>}</DialogContent></Dialog>{message && <output className="toast"><CircleHelp size={18} />{message}<button onClick={() => setMessage('')} aria-label="Bildirimi kapat"><X size={16} /></button></output>}
  <AlertDialog open={!!controlDialog} onOpenChange={open=>{if(!open && !controlBusy)setControlDialog(null);}}><AlertDialogContent className="control-dialog"><AlertDialogHeader><AlertDialogTitle>{controlDialog? actionTitle[controlDialog.action]:'Uygulama işlemi'}</AlertDialogTitle><AlertDialogDescription>{controlDialog?.app.name} · :{controlDialog?.app.port}</AlertDialogDescription></AlertDialogHeader><div className="control-confirm-body">{controlDialog?.control ? <><p>{controlDialog.action==='stop'?'Uygulama kapanacak ve port boşaltılacak. Daha sonra Başlat ile yeniden açabilirsiniz.':controlDialog.action==='restart'?'Uygulama durdurulup kayıtlı ayarlarıyla yeniden açılacak. Bu işlem sırasında kısa süreli erişim kesintisi olur.':'Uygulama kayıtlı başlatma ayarlarıyla yeniden çalıştırılacak.'}</p><div className="control-target"><span>ETKİLENEN PORTLAR</span><strong>{controlDialog.control.affectedPorts?.map(p=>`:${p}`).join(' · ') || `:${controlDialog.app.port}`}</strong>{controlDialog.control.label && <small>{controlDialog.control.label}</small>}</div>{controlDialog.control.reason && <p className="form-error">{controlDialog.control.reason}</p>}</>:<p><RefreshCw size={16} className={controlBusy?'spin':''}/> {controlBusy?'Güncel uygulama durumu kontrol ediliyor…':'Kontrol bilgisi alınamadı.'}</p>}{controlDialog?.error && <p className="form-error" role="alert">{controlDialog.error}</p>}{controlBusy && controlDialog?.control && <p className="control-progress"><RefreshCw size={16} className="spin"/>İşlem yapılıyor ve portun durumu doğrulanıyor…</p>}</div><AlertDialogFooter><AlertDialogCancel disabled={controlBusy}>Vazgeç</AlertDialogCancel><AlertDialogAction className={controlDialog?.action==='stop'?'confirm-stop':controlDialog?.action==='restart'?'confirm-restart':'confirm-start'} disabled={controlBusy || !!controlDialog?.error || !(controlDialog?.control && actionAllowed({...controlDialog.app,control:controlDialog.control},controlDialog.action))} onClick={()=>void applyControl()}>{controlDialog?.action==='stop'?<Square size={14}/>:controlDialog?.action==='restart'?<RotateCw size={14}/>:<Play size={14}/>}{controlDialog? actionText[controlDialog.action]:'İşlemi uygula'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  {editing && <AnnotationDialog key={editing.port} app={editing} onClose={()=>setEditing(null)} onSaved={()=>{void refresh();setMessage('Port notu ve takip tercihleri kaydedildi.');}}/>}
  <HistoryPanel key={`${panel || 'closed'}-${eventPort || 'all'}`} mode={panel} port={panel==='events'?eventPort:null} onClose={() => setPanel(null)} onRead={refresh} onSelect={port=>{setPanel(null);setSelected(apps.find(a=>a.port===port) || null);}} /></div></TeamProvider>;
}
