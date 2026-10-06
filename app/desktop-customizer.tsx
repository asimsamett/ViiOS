'use client';

import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Link, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cleanLaunchItem, newLinkId, type LaunchItem } from './launcher-data';
import type { DesktopLayoutLists } from './desktop-layout';
import './desktop-customizer.css';

type DesktopLayoutValue = DesktopLayoutLists;
type Surface = keyof DesktopLayoutValue;
const limits = { dock: 32, desktop: 16 };
export default function DesktopCustomizer({ initial, defaults, available, unavailable, saving, error, onSave, onReload, onClose }: {
  initial: DesktopLayoutValue;
  defaults: { dock: LaunchItem[]; desktop: LaunchItem[] };
  available: LaunchItem[];
  unavailable: (item: LaunchItem) => string;
  saving: boolean;
  error: string;
  onSave: (value: DesktopLayoutValue) => Promise<boolean>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DesktopLayoutValue>(() => structuredClone(initial));
  const [surface, setSurface] = useState<Surface>('dock');
  const [choice, setChoice] = useState(available[0]?.id || '');
  const [label, setLabel] = useState(''), [url, setUrl] = useState(''), [localError, setLocalError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const items = draft[surface] ?? defaults[surface];
  function change(next: LaunchItem[]) { setDraft(value => ({ ...value, [surface]: next })); setLocalError(''); }
  function add(item: LaunchItem) {
    if (items.length >= limits[surface]) { setLocalError(`Bu alana en fazla ${limits[surface]} kısayol eklenebilir.`); return false; }
    if (items.some(current => current.id === item.id)) { setLocalError('Bu kısayol zaten listede.'); return false; }
    change([...items, { ...item }]);
    return true;
  }
  function addLink() {
    const item = cleanLaunchItem({ id: newLinkId(), kind: 'link', label: label.trim(), url: url.trim() });
    if (!item || item.kind !== 'link') { setLocalError('Bir ad ve geçerli http:// veya https:// adresi girin.'); return; }
    if (add(item)) { setLabel(''); setUrl(''); }
  }
  function validate(value: unknown): DesktopLayoutValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Geçerli bir düzen dosyası seçin.');
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !Object.hasOwn(data, 'dock') || !Object.hasOwn(data, 'desktop')) throw new Error('Bu düzen dosyasının biçimi desteklenmiyor.');
    const result: DesktopLayoutValue = { dock: null, desktop: null };
    for (const target of ['dock', 'desktop'] as const) {
      const list = data[target];
      if (list === null) continue;
      if (!Array.isArray(list) || list.length > limits[target]) throw new Error('Düzen dosyasındaki kısayol sayısı veya liste biçimi geçersiz.');
      const cleaned = list.map(cleanLaunchItem);
      if (cleaned.some(item => !item) || new Set(cleaned.map(item => item?.id)).size !== cleaned.length) throw new Error('Düzen dosyasında geçersiz veya tekrarlanan kısayol var.');
      result[target] = cleaned as LaunchItem[];
    }
    return result;
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('Düzen dosyası en fazla 256 KB olabilir.');
      setDraft(validate(JSON.parse(await file.text()))); setLocalError('');
    } catch (reason) { setLocalError(reason instanceof SyntaxError ? 'JSON dosyası okunamadı.' : (reason as Error).message); }
  }
  function exportFile() {
    try {
      const value = validate({ version: 1, ...draft });
      const download = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, ...value }, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = download; anchor.download = 'viios-masaustu-duzeni.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(download), 1000); setLocalError('');
    } catch (reason) { setLocalError((reason as Error).message); }
  }
  async function save() {
    try { const value = validate({ version: 1, ...draft }); if (await onSave(value)) onClose(); }
    catch (reason) { setLocalError((reason as Error).message); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="desktop-customizer">
      <DialogHeader><DialogTitle>Masaüstünü düzenle</DialogTitle><DialogDescription>Dock ve masaüstü kısayollarını seçin. Kaydedilen düzen bu sunucuyu açan diğer tarayıcılarda da görünür.</DialogDescription></DialogHeader>
      <div className="desktop-customizer-toolbar"><div className="desktop-customizer-tabs">
        {(['dock', 'desktop'] as const).map(target => <Button key={target} variant={surface === target ? 'secondary' : 'ghost'} aria-pressed={surface === target} onClick={() => { setSurface(target); setLocalError(''); }}>{target === 'dock' ? 'Dock' : 'Masaüstü'}</Button>)}
      </div><span>{items.length} / {limits[surface]}</span><Button variant="ghost" disabled={saving} title="Seçili alanı varsayılan düzene döndür" onClick={() => { setDraft(value => ({ ...value, [surface]: null })); setLocalError(''); }}><RotateCcw size={15}/>Varsayılan</Button></div>
      <div className="desktop-customizer-body"><fieldset disabled={saving} className="desktop-customizer-add"><legend>Kısayol ekle</legend>
        <label htmlFor="desktop-shortcut-choice">Uygulama, araç veya klasör</label><div className="desktop-customizer-add-row"><select id="desktop-shortcut-choice" value={choice} onChange={event => setChoice(event.target.value)}>{available.map(item => <option key={item.id} value={item.id}>{item.label}{item.path ? ` · ${item.path}` : ''}</option>)}</select><Button variant="outline" disabled={!choice} onClick={() => { const item = available.find(entry => entry.id === choice); if (item) add(item); }}><Plus size={15}/>Ekle</Button></div>
        <div className="desktop-customizer-link-title"><Link size={15}/>Web adresi</div><Input aria-label="Yeni kısayol adı" placeholder="Kısayol adı" maxLength={255} value={label} onChange={event => setLabel(event.target.value)}/><div className="desktop-customizer-add-row"><Input aria-label="Yeni kısayol adresi" placeholder="https://…" maxLength={2048} value={url} onChange={event => setUrl(event.target.value)}/><Button variant="outline" onClick={addLink} disabled={!label.trim() || !url.trim()}><Plus size={15}/>Ekle</Button></div>
      </fieldset>
      <ol className="desktop-customizer-list">{items.map((item, index) => <li key={item.id}>
        <div className="desktop-customizer-fields">
          <Input aria-label={`${index + 1}. kısayol adı`} value={item.label} maxLength={255} disabled={saving} onChange={event => change(items.map((entry, position) => position === index ? { ...entry, label: event.target.value } : entry))}/>
          {item.kind === 'link' ? <Input aria-label={`${index + 1}. kısayol adresi`} value={item.url || ''} maxLength={2048} disabled={saving} onChange={event => change(items.map((entry, position) => position === index ? { ...entry, url: event.target.value } : entry))}/> : <small>{item.detail || item.path || (item.kind === 'project' ? 'Uygulama penceresi' : 'Yönetim aracı')}</small>}
          {unavailable(item) && <small className="desktop-customizer-unavailable">{unavailable(item)}</small>}
        </div>
        <div className="desktop-customizer-row-actions">
          <Button variant="ghost" size="icon" disabled={saving || index === 0} aria-label={`${item.label} yukarı taşı`} onClick={() => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; change(next); }}><ArrowUp size={16}/></Button>
          <Button variant="ghost" size="icon" disabled={saving || index === items.length - 1} aria-label={`${item.label} aşağı taşı`} onClick={() => { const next = [...items]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; change(next); }}><ArrowDown size={16}/></Button>
          <Button variant="ghost" size="icon" disabled={saving} aria-label={`${item.label} kaldır`} onClick={() => change(items.filter((_, position) => position !== index))}><Trash2 size={16}/></Button>
        </div>
      </li>)}</ol>{!items.length && <p className="desktop-customizer-empty">Bu alanda kısayol yok. Yukarıdan ekleyebilirsiniz.</p>}</div>
      {(localError || error) && <p className="form-error" role="alert">{localError || error}</p>}
      <footer className="desktop-customizer-footer"><div><input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }}/><Button variant="outline" disabled={saving} onClick={exportFile}><Download size={15}/>Dışa aktar</Button><Button variant="outline" disabled={saving} onClick={() => importInput.current?.click()}><Upload size={15}/>İçe aktar</Button>{error && <Button variant="ghost" disabled={saving} onClick={() => { void onReload().then(onClose); }}>Yeniden yükle</Button>}</div><div><Button variant="ghost" disabled={saving} onClick={onClose}>Vazgeç</Button><Button disabled={saving} onClick={() => void save()}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</Button></div></footer>
    </DialogContent>
  </Dialog>;
}
