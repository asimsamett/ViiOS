'use client';
import { DEMO_MODE } from '@/lib/public-mode';
import { useEffect, useRef, useState } from 'react';
import { Cog, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTarget } from './target-context';
import { overviewIsFresh } from './overview-state';
import { filterServices, serviceLabels, serviceStatus, type ServerService, type ServiceSort } from './service-state';
import './server-overview.css';
import './service-manager.css';
type Sample={available:boolean;platform:string;sampledAt:number;partial:boolean;services:ServerService[]};
type Logs={available:boolean;reason:string;entries:{at:number|null;priority:number|null;message:string}[]};
const startup=(value:string)=>({Auto:'Otomatik',Manual:'Elle',Disabled:'Devre dışı',enabled:'Açık',disabled:'Kapalı',static:'Statik',masked:'Maskeli'} as Record<string,string>)[value]||value;
const columns:{key:ServiceSort;label:string}[]=[{key:'name',label:'Servis'},{key:'displayName',label:'Görünen ad'},{key:'state',label:'Durum'},{key:'startup',label:'Başlangıç'},{key:'pid',label:'PID'}];
export default function ServiceManager({visible}:{visible:boolean}) {
  const {api,id}=useTarget();
  const [sample,setSample]=useState<Sample|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[sort,setSort]=useState<ServiceSort>('name'),[descending,setDescending]=useState(false),[page,setPage]=useState(0);
  const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<ServerService|null>(null),[detailError,setDetailError]=useState(''),[detailBusy,setDetailBusy]=useState(false),[detailRevision,setDetailRevision]=useState(0);
  const [confirmation,setConfirmation]=useState<string|null>(null),[changing,setChanging]=useState(false),[notice,setNotice]=useState(''),[logs,setLogs]=useState<Logs|null>(null),[logsBusy,setLogsBusy]=useState(false),[logsError,setLogsError]=useState(''),[logsRevision,setLogsRevision]=useState(0);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!visible||selected!==null)return;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined,request:AbortController|null=null;
    const cancel=()=>{clearTimeout(timer);request?.abort();request=null;};
    async function load(){if(!active||document.hidden||request)return;const controller=new AbortController();request=controller;setBusy(true);
      try{const value=await api<Sample>('/services',{signal:controller.signal,cache:'no-store'});if(!value.available||!Array.isArray(value.services)||!Number.isFinite(value.sampledAt))throw new Error('Servis listesi alınamadı.');if(active&&!controller.signal.aborted){setSample(value);setError('');}}
      catch(reason){if(active&&!controller.signal.aborted)setError((reason as Error).message);}
      finally{if(request===controller)request=null;if(active&&!controller.signal.aborted){setBusy(false);if(!document.hidden)timer=setTimeout(()=>void load(),15000);}}
    }
    const wake=()=>{cancel();if(!document.hidden)void load();};void load();document.addEventListener('visibilitychange',wake);
    return()=>{active=false;cancel();document.removeEventListener('visibilitychange',wake);};
  },[api,id,visible,revision,selected]);
  useEffect(()=>{
    if(selected===null)return;const controller=new AbortController();
    api<{service:ServerService}>(`/services/${encodeURIComponent(selected)}`,{signal:controller.signal,cache:'no-store'}).then(value=>{if(!controller.signal.aborted)setDetail(value.service);}).catch(reason=>{if(!controller.signal.aborted)setDetailError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setDetailBusy(false);});
    return()=>controller.abort();
  },[api,selected,detailRevision]);
  useEffect(()=>{
    if(!selected||!logsRevision)return;const controller=new AbortController();
    api<Logs>(`/services/${encodeURIComponent(selected)}/logs?limit=100`,{signal:controller.signal,cache:'no-store'}).then(value=>{if(!controller.signal.aborted)setLogs(value);}).catch(reason=>{if(!controller.signal.aborted)setLogsError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setLogsBusy(false);});return()=>controller.abort();
  },[api,selected,logsRevision]);
  function open(name:string){setSelected(name);setDetail(null);setDetailError('');setDetailBusy(true);setConfirmation(null);setNotice('');setLogs(null);setLogsError('');setLogsRevision(0);setLogsBusy(false);}
  function refreshDetails(){setDetail(null);setDetailError('');setDetailBusy(true);setConfirmation(null);setDetailRevision(value=>value+1);}
  async function change(){if(!detail?.token||!confirmation||changing)return;setChanging(true);setDetailError('');const action=confirmation;
    try{const value=await api<{ok:boolean;service:ServerService}>(`/services/${encodeURIComponent(detail.name)}/action`,{method:'POST',body:JSON.stringify({action,token:detail.token})});if(alive.current){setDetail(value.service);setConfirmation(null);setNotice(`${detail.name}: ${serviceLabels[action]} işlemi doğrulandı.`);setRevision(value=>value+1);}}
    catch(reason){if(alive.current){setDetailError((reason as Error).message);setDetail(null);setConfirmation(null);}}
    finally{if(alive.current)setChanging(false);}
  }
  const rows=filterServices(sample?.services||[],query,status,sort,descending),lastPage=Math.max(0,Math.ceil(rows.length/50)-1),shownPage=Math.min(page,lastPage);
  const stale=!!error||!sample||!overviewIsFresh({status:'online',sampledAt:sample.sampledAt});
  return <div className="server-overview service-manager">
    <header className="overview-header"><span className="overview-mark"><Cog size={26}/></span><div><h2>Servisler</h2><p>Servis durumu, başlangıç ayarları ve güvenli yönetim</p></div><Button variant="outline" disabled={busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15} className={busy?'spin':''}/>Yenile</Button></header>
    <div className="overview-status"><span className={stale?'overview-warning':'overview-live'}>{busy?'Servisler alınıyor…':stale?'Güncel durum bekleniyor':DEMO_MODE?'Temsili demo':'Canlı bağlantı'}</span><span>{sample?.services.length??'—'} servis</span><span>Son ölçüm: {sample?new Date(sample.sampledAt).toLocaleTimeString('tr-TR'):'—'}</span></div>
    {error&&<p className="overview-alert" role="alert">{error} {sample?'Son başarılı liste gösteriliyor.':''}</p>}
    {sample?.services.some(row=>row.lab)&&<p className="overview-alert">Laboratuvar: Windows servisleri gerçek ve salt okunurdur. “ViiOS Lab Service” ayrı bir süreç tabanlı test servisidir; Windows Services kaydı değildir.</p>}
    {sample?.partial&&<p className="overview-alert">İlk 2.000 servis gösteriliyor; yanıt sınırına ulaşıldı.</p>}
    <section className="overview-section"><div className="service-filters"><Search size={17}/><Input aria-label="Servis ara" placeholder="Servis adı veya durum ara…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/><select aria-label="Servis durum filtresi" value={status} onChange={event=>{setStatus(event.target.value);setPage(0);}}><option value="all">Tüm durumlar</option><option value="running">Çalışanlar</option><option value="stopped">Durmuş olanlar</option><option value="failed">Hata alanlar</option><option value="readonly">Salt okunur</option></select></div>
      <p className="overview-muted">Yönetim için agent yapılandırmasında servis izni gerekir. Sistem ve bağlantı servisleri korunur. İşlem öncesinde güncel durum doğrulanır.</p>
      <div className="overview-table service-table"><table><thead><tr>{columns.map(column=><th key={column.key} aria-sort={sort===column.key?(descending?'descending':'ascending'):'none'}><button onClick={()=>{setSort(column.key);setDescending(sort===column.key?!descending:false);setPage(0);}}>{column.label}{sort===column.key?(descending?' ↓':' ↑'):''}</button></th>)}<th>İşlem</th></tr></thead><tbody>{rows.slice(shownPage*50,shownPage*50+50).map(row=><tr key={row.name}><td><span className="service-name">{!row.actions.length&&<ShieldCheck size={13} aria-label="Salt okunur"/>}{row.name}</span>{row.lab&&<small>Yerel test servisi</small>}</td><td>{row.displayName}</td><td><span className={['Running','active'].includes(row.state)?'overview-live':''}>{serviceStatus(row.state)}</span>{row.subState&&<small>{row.subState}</small>}</td><td>{startup(row.startup)}</td><td>{row.pid??'—'}</td><td><Button variant="ghost" size="sm" aria-label={`${row.name} servis ayrıntıları`} onClick={()=>open(row.name)}>Ayrıntılar</Button></td></tr>)}</tbody></table></div>
      {!rows.length&&<p className="overview-muted">{sample?'Filtreye uyan servis yok.':busy?'Servisler yükleniyor…':'Henüz servis listesi alınmadı.'}</p>}
      <div className="service-pagination"><span>{rows.length} sonuç · Sayfa {shownPage+1} / {lastPage+1}</span><Button variant="outline" size="sm" disabled={shownPage===0} onClick={()=>setPage(shownPage-1)}>Önceki</Button><Button variant="outline" size="sm" disabled={shownPage===lastPage} onClick={()=>setPage(shownPage+1)}>Sonraki</Button></div>
    </section>
    <Dialog open={selected!==null} onOpenChange={open=>{if(!open&&!changing)setSelected(null);}}><DialogContent className="service-dialog" showCloseButton={!changing}><DialogHeader><DialogTitle>{confirmation?`${serviceLabels[confirmation]} — onay`:'Servis ayrıntıları'}</DialogTitle><DialogDescription>{selected}</DialogDescription></DialogHeader>
      {detailBusy&&<output>Servisin güncel durumu alınıyor…</output>}{detailError&&<p className="overview-alert" role="alert">{detailError}</p>}{notice&&<output className="overview-alert">{notice}</output>}
      {detail&&<><p>{detail.description||detail.displayName}</p><dl className="overview-details"><div><dt>Durum</dt><dd>{serviceStatus(detail.state)} {detail.subState}</dd></div><div><dt>Başlangıç</dt><dd>{startup(detail.startup)}</dd></div><div><dt>PID</dt><dd>{detail.pid??'—'}</dd></div><div><dt>Yönetim</dt><dd>{detail.actions.length?'İzinli':'Salt okunur'}</dd></div><div><dt>Gereken servisler</dt><dd>{detail.dependencies.join(', ')||'Yok'}</dd></div><div><dt>Bu servise bağlı olanlar</dt><dd>{detail.dependents.join(', ')||'Yok'}</dd></div></dl>
        {detail.reason&&<p className="overview-alert">{detail.reason}</p>}{detail.lab&&<p className="overview-alert">Bu test servisi yalnız laboratuvar sürecini yönetir. Başlangıç ayarı laboratuvar yeniden açıldığında uygulanır.</p>}
        {!confirmation&&<div className="service-actions">{detail.actions.map(action=><Button key={action} variant={['stop','restart','disabled','disable'].includes(action)?'outline':'default'} disabled={changing} onClick={()=>{setNotice('');setConfirmation(action);}}>{serviceLabels[action]}</Button>)}</div>}
        {confirmation&&<p className="overview-alert">{serviceLabels[confirmation]} işlemi “{detail.displayName||detail.name}” için uygulanacak.{['stop','restart'].includes(confirmation)?' Bu servisi kullanan uygulamalar geçici olarak erişilemez olabilir.':''}{['enable','disable','automatic','manual','disabled'].includes(confirmation)?' Bu ayar şu anki çalışma durumunu değiştirmez; sonraki başlangıçları etkiler.':''}</p>}
        {!confirmation&&<><Button variant="outline" disabled={!detail.canLogs||logsBusy||changing} onClick={()=>{setLogsBusy(true);setLogsError('');setLogsRevision(value=>value+1);}}>{logsBusy?'Günlük alınıyor…':'Servis günlüğü · son 100 kayıt'}</Button>{!detail.canLogs&&<p className="overview-muted">Windows olay günlükleri bu aşamanın kapsamında değil.</p>}{logsError&&<p role="alert" className="overview-alert">{logsError}</p>}{logs&&<section className="service-logs"><p className="overview-muted">Son 24 saat. Yaygın kimlik bilgisi kalıpları maskelenir; günlükler yine de hassas uygulama verisi içerebilir.</p>{!logs.available?<p>{logs.reason}</p>:logs.entries.length?logs.entries.map((entry,index)=><div key={index}><small>{entry.at?new Date(entry.at).toLocaleString('tr-TR'):'—'} · Öncelik {entry.priority??'—'}</small><pre>{entry.message}</pre></div>):<p>Bu zaman aralığında kayıt yok.</p>}</section>}</>}
      </>}
      <DialogFooter><Button variant="outline" disabled={changing} onClick={()=>confirmation?setConfirmation(null):setSelected(null)}>{confirmation?'Vazgeç':'Kapat'}</Button>{!confirmation&&<Button variant="outline" disabled={changing||detailBusy} onClick={refreshDetails}>Durumu yenile</Button>}{confirmation&&<Button variant="destructive" disabled={changing} onClick={()=>void change()}>{changing?'Uygulanıyor…':'Evet, uygula'}</Button>}</DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
