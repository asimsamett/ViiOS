'use client';
import { useTarget } from './target-context';
import { useState } from 'react';
import { Bookmark, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { App } from './types';
export default function AnnotationDialog({app,onClose,onSaved}:{app:App;onClose:()=>void;onSaved:()=>void}) {
  const {api}=useTarget();
  const initial=app.annotation;
  const [name,setName]=useState(initial?.displayName || ''),[note,setNote]=useState(initial?.note || ''),[tags,setTags]=useState(initial?.tags.join(', ') || '');
  const [favorite,setFavorite]=useState(initial?.favorite || false),[expectedUp,setExpectedUp]=useState(initial?.expectedUp || false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(){setBusy(true);setError('');try{await api(`/apps/${app.port}/annotation`,{method:'PATCH',body:JSON.stringify({displayName:name,note,tags:tags.split(',').map(t=>t.trim()).filter(Boolean),favorite,expectedUp,revision:initial?.revision || 0})});onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Dialog open onOpenChange={open=>{if(!open && !busy)onClose();}}><DialogContent className="annotation-dialog"><DialogHeader><DialogTitle><Bookmark size={20}/>Port notu ve takip</DialogTitle><DialogDescription>:{app.port} · {app.originalName || app.name}. Bu bilgiler port numarasına bağlı saklanır.</DialogDescription></DialogHeader><form onSubmit={e=>{e.preventDefault();void save();}}><label htmlFor="annotation-name">Görünen ad<Input id="annotation-name" value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder={app.originalName || app.name}/></label><label htmlFor="annotation-tags">Etiketler<Input id="annotation-tags" value={tags} onChange={e=>setTags(e.target.value)} placeholder="Örn. api, üretim, ekip-a"/><small>Virgülle ayırın. En fazla 5 etiket, etiket başına 24 karakter.</small></label><label htmlFor="annotation-note">Port notu<Textarea id="annotation-note" value={note} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder="Uygulamanın amacı, sorumlu ekip veya bakım notları…" rows={5}/><small>{note.length} / 2000</small></label><label htmlFor="annotation-favorite" className="annotation-check"><Checkbox id="annotation-favorite" checked={favorite} onCheckedChange={setFavorite}/>Favorilere ekle</label><label htmlFor="annotation-expected" className="annotation-check"><Checkbox id="annotation-expected" checked={expectedUp} onCheckedChange={setExpectedUp}/>Bu uygulama sürekli çalışmalı</label><p className="annotation-hint">Sürekli çalışması beklenen bir port kapanırsa Sorunlu filtresine eklenir. Bu seçenek uygulamayı kendiliğinden yeniden başlatmaz.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="annotation-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" disabled={busy}><Save size={16}/>{busy?'Kaydediliyor…':'Kaydet'}</Button></div></form></DialogContent></Dialog>;
}
