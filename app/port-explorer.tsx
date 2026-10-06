'use client';
import { useTarget } from './target-context';
import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy, Download, Info, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { copyText } from './api';
import type { Inventory } from './types';

type Result={scannedAt:string;stale:boolean;connectionError:string|null;total:number;occupied:number;excludedKnown:number;rangeSize:number;ports:{port:number;previouslyUsed:boolean;previousName:string|null;restartable:boolean;otherProtocol:string|null}[]};
export default function PortExplorer({inventory,onSelect,onMessage,onScan}:{inventory:Inventory|null;onSelect:(port:number)=>void;onMessage:(text:string)=>void;onScan:()=>void}) {
  const {api, downloadReport}=useTarget();
  const [draftStart,setDraftStart]=useState('8000'),[draftEnd,setDraftEnd]=useState('8999');
  const [range,setRange]=useState({start:8000,end:8999});
  const [protocol,setProtocol]=useState('both'),[excludeKnown,setExcludeKnown]=useState(true),[offset,setOffset]=useState(0);
  const [data,setData]=useState<Result|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[downloading,setDownloading]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  const query=new URLSearchParams({start:String(range.start),end:String(range.end),protocol,excludeKnown:String(excludeKnown),offset:String(offset),limit:'100'}).toString();
  const availability=JSON.stringify(inventory?.apps.map(a=>[a.port,a.active,a.transports,a.name,a.control?.canStart]));
  const stale=!!data && (data.stale || !!inventory?.pendingControlScan || !!inventory?.controlling || now-new Date(data.scannedAt).getTime()>180000);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{setLoading(true);void api<Result>(`/ports/free?${query}`,{signal:controller.signal}).then(result=>{setData(result);setError('');}).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});},0);
    return()=>{clearTimeout(timer);controller.abort();};
  },[api,query,inventory?.scannedAt,inventory?.error,inventory?.pendingControlScan,availability]);
  function apply(start:number,end:number){if(!Number.isInteger(start) || !Number.isInteger(end) || start<1 || end>65535 || start>end){setError('1–65535 arasında geçerli bir başlangıç ve bitiş girin.');return;}setRange({start,end});setDraftStart(String(start));setDraftEnd(String(end));setOffset(0);setError('');}
  async function download(){setDownloading(true);try{await downloadReport(`free-ports?${query}&format=csv`);}catch(e){onMessage((e as Error).message);}finally{setDownloading(false);}}
  return <section className="port-explorer"><div className="section-heading"><div><h2>Boş portlar</h2><p className="section-description">Yeni uygulamanız için port bulun. Son başarılı taramadaki dinleyiciler esas alınır.</p></div><Button variant="outline" disabled={downloading || loading || !data || !!error} onClick={()=>void download()}><Download size={16}/>{downloading?'Hazırlanıyor…':'Listeyi indir'}</Button></div>
    <form className="port-search-panel" onSubmit={e=>{e.preventDefault();apply(Number(draftStart),Number(draftEnd));}}><div className="port-range-inputs"><label htmlFor="port-start">Başlangıç<Input id="port-start" type="number" min={1} max={65535} value={draftStart} onChange={e=>setDraftStart(e.target.value)} required/></label><span>—</span><label htmlFor="port-end">Bitiş<Input id="port-end" type="number" min={1} max={65535} value={draftEnd} onChange={e=>setDraftEnd(e.target.value)} required/></label></div><div className="protocol-picker"><span>Protokol</span><Select value={protocol} onValueChange={value=>{if(value){setProtocol(value);setOffset(0);}}} items={{both:'TCP ve UDP boş',tcp:'TCP boş',udp:'UDP boş'}}><SelectTrigger aria-label="Boş port protokolü"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="both">TCP ve UDP boş</SelectItem><SelectItem value="tcp">TCP boş</SelectItem><SelectItem value="udp">UDP boş</SelectItem></SelectContent></Select></div><Button type="submit" className="port-apply"><Network size={16}/>Portları listele</Button><div className="range-presets"><span>Hızlı aralık</span>{[[1,65535],[8000,8999],[3000,3999],[9000,9999]].map(([start,end])=><Button type="button" key={start} variant="ghost" className={range.start===start && range.end===end?'selected':''} onClick={()=>apply(start,end)}>{start}–{end}</Button>)}</div><label htmlFor="exclude-known" className="known-port-check"><Checkbox id="exclude-known" checked={excludeKnown} onCheckedChange={value=>{setExcludeKnown(value);setOffset(0);}}/>Kapalı uygulamaların daha önce kullandığı portları dışla</label></form>
    {error && <div className="notice error-notice" role="alert"><Info size={18}/>{error}</div>}
    {stale && <div className="notice error-notice"><Info size={18}/><span>Bu sonuçlar güncel olmayabilir. {inventory?.pendingControlScan?'Servis işlemi sonrası tarama bekleniyor.':data?.connectionError || 'Son taramanın üzerinden üç dakikadan fazla geçti.'}</span><Button variant="ghost" onClick={onScan}>Yeniden tara</Button></div>}
    <div className="free-port-summary"><div><strong>{loading?'…':data?.total.toLocaleString('tr-TR') || '0'}</strong><span>filtreye uygun boş port</span></div><div><strong>{data?.occupied.toLocaleString('tr-TR') || '0'}</strong><span>seçili protokolde kullanımda</span></div><div><strong>{data?.excludedKnown || 0}</strong><span>geçmiş kaydı nedeniyle dışlandı</span></div><span className="port-snapshot">Son tarama<br/><b>{data?.scannedAt?new Date(data.scannedAt).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'Henüz yok'}</b></span></div>
    <div className="port-legend"><span><i className="status-dot green"/>Seçili protokolde dinleyici yok</span><span><i className="status-dot amber"/>Önceki uygulama kaydı var</span><span>Numaraya tıklayarak kopyalayın</span></div>
    <div className={`free-port-grid ${loading?'is-loading':''}`} aria-busy={loading}>{!error && data?.ports.map(p=><div className={`free-port ${p.previouslyUsed?'previous-port':''}`} key={p.port}><button className="port-number" disabled={loading} onClick={()=>void copyText(String(p.port)).then(()=>onMessage(`:${p.port} kopyalandı.`)).catch(e=>onMessage((e as Error).message))} aria-label={`${p.port} portunu kopyala`}><span>:{p.port}</span><Copy size={13}/></button>{p.previouslyUsed?<button className="previous-app" title={p.previousName || ''} onClick={()=>onSelect(p.port)}>{p.restartable?'Yeniden başlatılabilir':p.previousName}<ArrowUpRight size={12}/></button>:<span className="port-availability">{p.otherProtocol?`${p.otherProtocol} kullanımda`:'Dinleyici yok'}</span>}</div>)}</div>
    {!loading && !error && !data?.ports.length && <div className="log-empty"><Network size={28}/><strong>Bu filtrede boş port bulunamadı.</strong><p>Aralığı genişletebilir veya geçmiş port filtresini kaldırabilirsiniz.</p></div>}
    <div className="history-footer"><span>{data?.total?`${offset+1}–${Math.min(offset+100,data.total)} / ${data.total.toLocaleString('tr-TR')}`:'0'} port</span><div><Button variant="outline" size="icon" aria-label="Önceki boş portlar" disabled={offset===0 || loading} onClick={()=>setOffset(Math.max(0,offset-100))}><ChevronLeft/></Button><span>{Math.floor(offset/100)+1} / {Math.max(1,Math.ceil((data?.total || 0)/100))}</span><Button variant="outline" size="icon" aria-label="Sonraki boş portlar" disabled={loading || offset+100>=(data?.total || 0)} onClick={()=>setOffset(offset+100)}><ChevronRight/></Button></div></div>
    <p className="port-footnote"><Info size={16}/>Boş görünmesi portu ayırmaz. Uygulama başlatmadan önce yeniden tarayın. TCP ve UDP ayrı değerlendirilir; yalnızca sunucu içinden erişilen dinleyiciler de kullanım sayılır.</p>
  </section>;
}
