'use client';
import { DEMO_MODE } from '@/lib/public-mode';
import { useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTarget } from './target-context';
import { storageBytes } from './storage-format';
import { filterProcesses, type ProcessSort, type ServerProcess } from './process-state';
import { overviewIsFresh } from './overview-state';
import './server-overview.css';
import './process-manager.css';

type Sample = { available: boolean; processes: ServerProcess[]; sampledAt: number; partial: boolean; platform: string };
const percent = (value: number | null) => value === null ? '—' : `${value.toLocaleString('tr-TR',{maximumFractionDigits:1})}%`;
const date = (value: string | null) => value ? new Date(value).toLocaleString('tr-TR') : '—';
const columns: {key:ProcessSort;label:string}[] = [{key:'pid',label:'PID'},{key:'name',label:'Süreç'},{key:'cpuPercent',label:'CPU'},{key:'memoryBytes',label:'Bellek'},{key:'user',label:'Kullanıcı'},{key:'state',label:'Durum'},{key:'startedAt',label:'Başlangıç'}];

export default function ProcessManager({visible}:{visible:boolean}) {
  const {api,id} = useTarget();
  const [sample,setSample] = useState<Sample|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [revision,setRevision] = useState(0);
  const [query,setQuery] = useState(''), [sort,setSort] = useState<ProcessSort>('cpuPercent'), [descending,setDescending] = useState(true), [page,setPage] = useState(0);
  const [selected,setSelected] = useState<number|null>(null), [detail,setDetail] = useState<ServerProcess|null>(null), [detailBusy,setDetailBusy] = useState(false), [detailError,setDetailError] = useState('');
  const [confirm,setConfirm] = useState(false), [terminating,setTerminating] = useState(false), [notice,setNotice] = useState('');
  const alive = useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!visible || selected !== null)return;
    let active=true, timer:ReturnType<typeof setTimeout>|undefined, request:AbortController|null=null;
    const cancel=()=>{clearTimeout(timer);request?.abort();request=null;};
    async function load(){
      if(!active||document.hidden||request)return;
      const controller=new AbortController();request=controller;setBusy(true);
      try{
        const result=await api<Sample>('/processes',{signal:controller.signal,cache:'no-store'});
        if(!result.available||!Array.isArray(result.processes)||!Number.isFinite(result.sampledAt))throw new Error('Süreç listesi alınamadı.');
        if(active&&!controller.signal.aborted){setSample(result);setError('');}
      }catch(reason){if(active&&!controller.signal.aborted)setError((reason as Error).message);}
      finally{if(request===controller)request=null;if(active&&!controller.signal.aborted){setBusy(false);if(!document.hidden)timer=setTimeout(()=>void load(),12000);}}
    }
    const wake=()=>{cancel();if(!document.hidden)void load();};
    void load();document.addEventListener('visibilitychange',wake);
    return()=>{active=false;cancel();document.removeEventListener('visibilitychange',wake);};
  },[api,id,visible,revision,selected]);
  useEffect(()=>{
    if(selected===null)return;
    const controller=new AbortController();
    api<{process:ServerProcess}>(`/processes/${selected}`,{signal:controller.signal,cache:'no-store'}).then(result=>{
      if(!controller.signal.aborted)setDetail(result.process);
    }).catch(reason=>{if(!controller.signal.aborted)setDetailError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setDetailBusy(false);});
    return()=>controller.abort();
  },[api,selected]);
  async function terminate(){
    if(!detail?.canTerminate||!detail.token||terminating)return;
    setTerminating(true);setDetailError('');
    try{
      const result=await api<{ok:boolean;exited:boolean}>(`/processes/${detail.pid}/terminate`,{method:'POST',body:JSON.stringify({token:detail.token})});
      if(alive.current){setNotice(result.exited?`PID ${detail.pid} sonlandırıldı.`:`PID ${detail.pid} için sonlandırma istendi. Kapanıp kapanmadığını yenileyerek kontrol edin.`);setSelected(null);setRevision(value=>value+1);}
    }catch(reason){if(alive.current){setDetailError((reason as Error).message);setConfirm(false);setDetail(null);}}
    finally{if(alive.current)setTerminating(false);}
  }
  const rows=filterProcesses(sample?.processes||[],query,sort,descending), lastPage=Math.max(0,Math.ceil(rows.length/50)-1), shownPage=Math.min(page,lastPage);
  const stale=!!error||!sample||!overviewIsFresh({status:'online',sampledAt:sample.sampledAt});
  return <div className="server-overview process-manager">
    <header className="overview-header"><span className="overview-mark"><Activity size={26}/></span><div><h2>Süreç Yöneticisi</h2><p>Sunucudaki süreçler · PID, kullanıcı ve kaynak kullanımı</p></div><Button variant="outline" disabled={busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15} className={busy?'spin':''}/>Yenile</Button></header>
    <div className="overview-status"><span className={stale?'overview-warning':'overview-live'}>{busy?'Süreçler ölçülüyor…':stale?'Güncel ölçüm bekleniyor':DEMO_MODE?'Temsili demo':'Canlı bağlantı'}</span><span>{sample?.processes.length??'—'} süreç</span><span>Son ölçüm: {sample?new Date(sample.sampledAt).toLocaleTimeString('tr-TR'):'—'}</span></div>
    {error&&<p role="alert" className="overview-alert">{error} {sample?'Son başarılı liste gösteriliyor.':''}</p>}
    {notice&&<output className="overview-alert">{notice}</output>}
    {sample?.partial&&<p className="overview-alert">Sunucunun ilk 10.000 süreci gösteriliyor; yanıt sınırına ulaşıldı.</p>}
    <section className="overview-section"><div className="process-search"><Search size={18}/><Input aria-label="Süreç ara" placeholder="PID, süreç, kullanıcı veya durum ara…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></div>
      <p className="overview-muted">Sıralamak için sütun başlığına tıklayın. CPU yüzdesi toplam işlemci kapasitesine göredir. Sistem, servis ve yönetim süreçleri korunur.</p>
      <div className="overview-table process-table"><table><thead><tr>{columns.map(column=><th key={column.key} aria-sort={sort===column.key?(descending?'descending':'ascending'):'none'}><button onClick={()=>{setSort(column.key);setDescending(sort===column.key?!descending:false);setPage(0);}}>{column.label}{sort===column.key?(descending?' ↓':' ↑'):''}</button></th>)}<th>İşlem</th></tr></thead><tbody>{rows.slice(shownPage*50,shownPage*50+50).map(row=><tr key={`${row.pid}:${row.token}`}><td>{row.pid}</td><td><span className="process-name">{!row.canTerminate&&<ShieldCheck size={13} aria-label="Korumalı"/>}{row.name}</span></td><td>{percent(row.cpuPercent)}</td><td>{row.memoryBytes===null?'—':storageBytes(row.memoryBytes)}</td><td>{row.user||'—'}</td><td>{row.state||'—'}</td><td>{date(row.startedAt)}</td><td><Button variant="ghost" size="sm" disabled={row.pid===0} aria-label={`${row.name} PID ${row.pid} ayrıntıları`} onClick={()=>{setNotice('');setDetail(null);setDetailError('');setDetailBusy(true);setConfirm(false);setSelected(row.pid);}}>Ayrıntılar</Button></td></tr>)}</tbody></table></div>
      {!rows.length&&<p className="overview-muted">{busy?'Süreçler yükleniyor…':sample?'Aramaya uyan süreç yok.':'Henüz süreç listesi alınmadı.'}</p>}
      <div className="process-pagination"><span>{rows.length} sonuç · Sayfa {shownPage+1} / {lastPage+1}</span><Button variant="outline" size="sm" disabled={shownPage===0} onClick={()=>setPage(shownPage-1)}>Önceki</Button><Button variant="outline" size="sm" disabled={shownPage===lastPage} onClick={()=>setPage(shownPage+1)}>Sonraki</Button></div>
    </section>
    <Dialog open={selected!==null} onOpenChange={open=>{if(!open&&!terminating)setSelected(null);}}><DialogContent className="process-dialog" showCloseButton={!terminating}><DialogHeader><DialogTitle>{confirm?'Süreci sonlandır':'Süreç ayrıntıları'}</DialogTitle><DialogDescription>PID {selected} · {detail?.name||'Sunucudan güncel bilgi alınıyor'}</DialogDescription></DialogHeader>
      {detailBusy&&<output>Süreç doğrulanıyor…</output>}{detailError&&<p role="alert" className="overview-alert">{detailError}</p>}
      {detail&&<><dl className="overview-details"><div><dt>Kullanıcı</dt><dd>{detail.user||'—'}</dd></div><div><dt>Durum</dt><dd>{detail.state}</dd></div><div><dt>CPU</dt><dd>{percent(detail.cpuPercent)}</dd></div><div><dt>Bellek</dt><dd>{detail.memoryBytes===null?'—':storageBytes(detail.memoryBytes)}</dd></div><div><dt>Başlangıç</dt><dd>{date(detail.startedAt)}</dd></div><div><dt>Üst süreç PID</dt><dd>{detail.parentPid??'—'}</dd></div></dl>
        {!detail.canTerminate&&<p className="overview-alert">Sonlandırma kapalı: {detail.reason||'Bu süreç korumalı.'}</p>}
        {confirm&&<p className="overview-alert">{sample?.platform==='windows'?'Windows süreci zorla kapatır; kaydedilmemiş veriler kaybolabilir.':'Linux sürece SIGTERM gönderir; sürecin kapanması zaman alabilir.'} {detail.name} (PID {detail.pid}) sonlandırılsın mı?</p>}</>}
      <DialogFooter><Button variant="outline" disabled={terminating} onClick={()=>confirm?setConfirm(false):setSelected(null)}>{confirm?'Vazgeç':'Kapat'}</Button>{detail?.canTerminate&&(confirm?<Button variant="destructive" disabled={terminating} onClick={()=>void terminate()}>{terminating?'Sonlandırılıyor…':'Evet, sonlandır'}</Button>:<Button variant="destructive" onClick={()=>setConfirm(true)}>Sonlandır</Button>)}</DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
