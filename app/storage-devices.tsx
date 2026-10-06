'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { storageBytes } from './storage-format';

export type StorageDevice = { id:string; name:string; kind:string; sizeBytes:number|null; parentIds:string[]; volumeIds:string[]; model?:string; partitionStyle?:string; readBytesPerSecond:number|null; writeBytesPerSecond:number|null };
export type StorageTopology = { available:boolean; partial?:boolean; devices:StorageDevice[]; reason?:string };
type MountedVolume = { id:string; mount:string; filesystem:string };
export default function StorageDevices({topology,volumes,onInspect,onFiles}:{topology?:StorageTopology;volumes:MountedVolume[];onInspect:(path:string)=>void;onFiles:(path:string)=>void}) {
  const [selected,setSelected]=useState<string|null>(null);
  const rows=topology?.devices||[], chosen=rows.find(row=>row.id===selected);
  const descendants=new Set(chosen?[chosen.id]:rows.map(row=>row.id));
  if(chosen)for(let step=0;step<rows.length;step++){const count=descendants.size;for(const row of rows)if(row.parentIds.some(id=>descendants.has(id)))descendants.add(row.id);if(count===descendants.size)break;}
  const related=(row:StorageDevice)=>descendants.has(row.id);
  return <section className="storage-device-section" aria-label="Disk yapısı">
    <p className="storage-explanation">Disk kapasitesi ile bölüm kapasitesi aynı alanın farklı katmanlarıdır; birbirine eklenmez. Sunucu toplamı yukarıdaki bağlı dosya sistemlerinden hesaplanır. Okuma/yazma değerleri cihaz bazındadır.</p>
    {!topology?.available?<output className="storage-notice">{topology?.reason||'Bu agent disk yapısı bilgisi sağlamıyor. Disk bölümleri sekmesini kullanabilirsiniz.'}</output>:<>
      {topology.partial&&<p className="storage-notice">Disk yapısı kısmen okunabildi; erişilemeyen bilgiler “—” gösterilir.</p>}
      <div className="storage-device-selector"><Button variant={selected===null?'default':'outline'} onClick={()=>setSelected(null)}>Tüm cihazlar</Button>{rows.filter(row=>row.kind==='disk'||row.kind==='logical').map(row=><Button key={row.id} variant={selected===row.id?'default':'outline'} onClick={()=>setSelected(row.id)}>{row.name}</Button>)}</div>
      <div className="storage-device-table"><table><thead><tr><th>Cihaz / bölüm</th><th>Bağlı olduğu cihaz</th><th>Kapasite</th><th>Okuma</th><th>Yazma</th><th>Dosya sistemi / erişim</th></tr></thead><tbody>{rows.filter(related).map(row=>{
        const mounts=volumes.filter(volume=>row.volumeIds.includes(volume.id));
        return <tr key={row.id}><td><strong>{row.name}</strong><small>{row.kind==='partition'?'Bölüm':row.kind==='logical'?'Mantıksal cihaz':row.kind==='disk'?'Disk':'Bilinmiyor'}{row.partitionStyle?` · ${row.partitionStyle}`:''}</small>{row.model&&<small>{row.model}</small>}</td><td>{row.parentIds.map(id=>rows.find(parent=>parent.id===id)?.name||id).join(', ')||'—'}</td><td>{storageBytes(row.sizeBytes)}</td><td>{row.readBytesPerSecond==null?'—':`${storageBytes(row.readBytesPerSecond)}/s`}</td><td>{row.writeBytesPerSecond==null?'—':`${storageBytes(row.writeBytesPerSecond)}/s`}</td><td>{mounts.length?mounts.map(volume=><div className="storage-device-mount" key={volume.id}><strong>{volume.mount} · {volume.filesystem}</strong><Button variant="outline" size="sm" onClick={()=>onInspect(volume.mount)}>Klasörleri incele</Button><Button variant="ghost" size="sm" onClick={()=>onFiles(volume.mount)}>Dosyalarda aç</Button></div>):<span>Bağlı dosya sistemi eşleşmesi yok</span>}</td></tr>;
      })}</tbody></table></div>
      <p className="storage-explanation">“—” ölçüm alınamadığını belirtir. Bağlanmamış, ayrılmış veya eşleştirilemeyen bölümlerde klasör açılamaz. Dosya gezgini mevcut erişim izinlerini uygular.</p>
    </>}
  </section>;
}
