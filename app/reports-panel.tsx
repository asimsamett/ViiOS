'use client';
import { useTarget } from './target-context';
import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet, History, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Inventory } from './types';
export default function ReportsPanel({inventory,onMessage,onPorts}:{inventory:Inventory|null;onMessage:(message:string)=>void;onPorts:()=>void}) {
  const {downloadReport}=useTarget();
  const [busy,setBusy]=useState('');
  async function download(kind:string,format:string){setBusy(`${kind}-${format}`);try{await downloadReport(`${kind}?format=${format}`);}catch(e){onMessage((e as Error).message);}finally{setBusy('');}}
  return <section className="reports-panel"><div className="section-heading"><div><h2>Denetim raporları</h2><p className="section-description">Sunucu: {inventory?.host} · Son tarama: {inventory?.scannedAt?new Date(inventory.scannedAt).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'Bekleniyor'}</p></div></div><div className="report-grid">{[{key:'inventory',title:'Uygulama envanteri',icon:FileSpreadsheet,description:'Açık ve kapalı uygulamalar, portlar, protokoller, son durum, favoriler, etiketler ve port notları.'},{key:'events',title:'İşlem günlüğü',icon:History,description:'Saklanan en fazla 10.000 olay: açılma, kapanma, servis işlemleri, hatalar ve denetimler.'}].map(({key,title,icon:Icon,description})=><article key={key}><Icon size={26}/><h3>{title}</h3><p>{description}</p><div>{['csv','json'].map(format=><Button key={format} variant="outline" disabled={!!busy || !inventory?.scannedAt} onClick={()=>void download(key,format)}>{format==='csv'?<Download size={16}/>:<FileJson size={16}/>} {busy===`${key}-${format}`?'Hazırlanıyor…':format.toUpperCase()+' indir'}</Button>)}</div></article>)}<article><Network size={26}/><h3>Boş port raporu</h3><p>Seçtiğiniz aralık ve protokole göre boş portlar. Geçmiş uygulama kaydı ve tarama zamanı dahildir.</p><Button variant="outline" onClick={onPorts}>Aralık seç ve indir</Button></article></div><p className="report-note">Raporlar indirdiğiniz andaki kayıtları içerir. Bağlantı sorunu varsa son başarılı tarama kullanılır. CSV dosyaları Türkçe karakterleri korur; notlar ve adlar elektronik tablolarda formül çalıştırmayacak şekilde aktarılır.</p></section>;
}
