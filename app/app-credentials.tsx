'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, CalendarClock, Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, PanelsTopLeft, Pencil, Plus, RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { copyText } from './api';
import { useTarget } from './target-context';
import { DEMO_MODE } from '@/lib/public-mode';

type Credential = { id: string; name: string; url: string; username: string; hasPassword: boolean; note: string; updatedAt: string };
type CredentialData = { revision: number; entries: Credential[] };
type CredentialSync = {
  enabled: boolean; disabledReason: string | null; scanning: boolean;
  timeZone: string; schedule: string; lastAttemptAt: string | null; lastSuccessAt: string | null;
  lastDailyDay: string | null; nextRunAt: string | null;
  lastResult: { added: number; updated: number; unchanged: number } | null;
  warnings: string[]; lastError: string | null;
};
const syncTime = (value: string | null | undefined, timeZone = 'Europe/Istanbul') => {
  if (!value) return 'Henüz kontrol edilmedi';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('tr-TR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function CredentialEditor({ entry, revision, onClose, onSaved, onConflict }: {
  entry: Credential | null; revision: number; onClose: () => void; onSaved: (data: CredentialData) => void; onConflict: () => void;
}) {
  const { api } = useTarget();
  const fieldId = useId();
  // Keep the revision from opening the form. Background sync must not allow
  // a draft based on an older record to silently overwrite a newer version.
  const [editingRevision] = useState(revision);
  const [name, setName] = useState(entry?.name || ''), [url, setUrl] = useState(entry?.url || '');
  const [username, setUsername] = useState(entry?.username || ''), [password, setPassword] = useState('');
  const [note, setNote] = useState(entry?.note || ''), [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try {
      const data = await api<CredentialData>(entry ? `/credentials/${encodeURIComponent(entry.id)}` : '/credentials', {
        method: entry ? 'PUT' : 'POST',
        body: JSON.stringify({ revision: editingRevision, name, url, username, note, ...(password || !entry ? { password } : {}) }),
      });
      setPassword(''); onSaved(data); onClose();
    } catch (reason) {
      setError((reason as Error).message);
      if ((reason as Error & { status?: number }).status === 409) { setConflict(true); onConflict(); }
    } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="credential-dialog" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{entry ? 'Erişim bilgilerini düzenle' : 'Uygulama ekle'}</DialogTitle><DialogDescription>Uygulamanın yönetim paneli adresini ve admin giriş bilgilerini kaydedin.</DialogDescription></DialogHeader>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label htmlFor={`${fieldId}-name`}> Uygulama adı<Input id={`${fieldId}-name`} required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="Örn. Uygulama · Yönetim"/></label>
        <label htmlFor={`${fieldId}-url`}> Yönetim paneli adresi<Input id={`${fieldId}-url`} required type="url" maxLength={2048} value={url} onChange={event => setUrl(event.target.value)} placeholder="http://sunucu:port/admin"/></label>
        <label htmlFor={`${fieldId}-username`}> Username / Kullanıcı adı<Input id={`${fieldId}-username`} maxLength={256} value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Admin kullanıcı adı veya e-posta"/></label>
        <label htmlFor={`${fieldId}-password`}>Password / Şifre<span className="credential-password-input"><Input id={`${fieldId}-password`} type={show ? 'text' : 'password'} maxLength={4096} autoComplete="new-password" spellCheck={false} value={password} onChange={event => setPassword(event.target.value)} placeholder={entry?.hasPassword ? 'Kayıtlı şifreyi korumak için boş bırakın' : 'Admin şifresi'}/><Button type="button" variant="ghost" size="icon" aria-label={show ? 'Girilen şifreyi gizle' : 'Girilen şifreyi göster'} onClick={() => setShow(!show)}>{show ? <EyeOff size={16}/> : <Eye size={16}/>}</Button></span>{entry?.hasPassword && <small>Boş bırakırsanız mevcut şifre korunur.</small>}</label>
        <label htmlFor={`${fieldId}-note`}> Not<Textarea id={`${fieldId}-note`} maxLength={2000} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Giriş yöntemi veya erişimle ilgili not…"/></label>
        {error && <p className="form-error" role="alert">{error}{conflict && ' Güncel kaydı açmak için bu pencereyi kapatıp tekrar Düzenle seçeneğine tıklayın.'}</p>}
        <div className="credential-form-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" disabled={busy || conflict}><Save size={15}/>{busy ? 'Kaydediliyor…' : 'Kaydet'}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}

export default function AppCredentials({ query }: { query: string }) {
  const { api } = useTarget();
  const [data, setData] = useState<CredentialData | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({}), [pending, setPending] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [sync, setSync] = useState<CredentialSync | null>(null), [syncError, setSyncError] = useState('');
  const [syncStarting, setSyncStarting] = useState(false), [syncRefresh, setSyncRefresh] = useState(0);
  const syncState = useRef<CredentialSync | null>(null), lastSuccess = useRef<string | null | undefined>(undefined);
  const mounted = useRef(false), syncSubmit = useRef<AbortController | null>(null);
  const generation = useRef(0), requestId = useRef(0), busy = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSecrets = useCallback(() => { generation.current++; setRevealed({}); setPending(null); busy.current = false; }, []);
  const reload = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true); setError(''); clearSecrets();
    try {
      const result = await api<CredentialData>('/credentials', { cache: 'no-store' });
      if (request === requestId.current) setData(result);
    } catch (reason) { if (request === requestId.current) setError((reason as Error).message); }
    finally { if (request === requestId.current) setLoading(false); }
  }, [api, clearSecrets]);
  const dispose = useCallback(() => { requestId.current++; generation.current++; if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => { if (active) void reload(); });
    const hide = () => { if (document.hidden) clearSecrets(); };
    document.addEventListener('visibilitychange', hide);
    return () => { active = false; mounted.current = false; syncSubmit.current?.abort(); dispose(); document.removeEventListener('visibilitychange', hide); };
  }, [reload, clearSecrets, dispose]);
  const acceptSync = useCallback((result: CredentialSync) => {
    const completed = lastSuccess.current !== undefined && result.lastSuccessAt !== null && result.lastSuccessAt !== lastSuccess.current;
    lastSuccess.current = result.lastSuccessAt; syncState.current = result; setSync(result);
    if (completed) void reload();
  }, [reload]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; controller?.abort(); };
    async function readStatus() {
      if (!active || document.hidden) return;
      const request = new AbortController(); controller = request;
      try {
        const result = await api<CredentialSync>('/credentials/sync', { cache: 'no-store', signal: request.signal });
        if (!active || request.signal.aborted || document.hidden) return;
        acceptSync(result); setSyncError('');
      } catch (reason) {
        if (active && !request.signal.aborted && !document.hidden) setSyncError((reason as Error).message);
      } finally {
        if (controller === request) controller = null;
        if (active && !request.signal.aborted && !document.hidden) timer = setTimeout(() => void readStatus(), syncState.current?.scanning ? 1500 : 30000);
      }
    }
    const visibility = () => { cancel(); if (!document.hidden) void readStatus(); };
    document.addEventListener('visibilitychange', visibility);
    void readStatus();
    return () => { active = false; cancel(); document.removeEventListener('visibilitychange', visibility); };
  }, [api, acceptSync, syncRefresh]);
  async function checkNow() {
    if (syncSubmit.current || syncState.current?.scanning || !syncState.current?.enabled) return;
    const controller = new AbortController(); syncSubmit.current = controller;
    setSyncStarting(true); setSyncError(''); clearSecrets();
    try {
      const result = await api<CredentialSync>('/credentials/sync', { method: 'POST', body: '{}', signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      acceptSync(result); setSyncRefresh(value => value + 1);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setSyncError((reason as Error).message);
    } finally {
      if (syncSubmit.current === controller) syncSubmit.current = null;
      if (mounted.current) setSyncStarting(false);
    }
  }
  async function copy(value: string, key: string) {
    await copyText(value); setCopied(key); setMessage('Panoya kopyalandı.');
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => { setCopied(''); setMessage(''); }, 2500);
  }
  async function access(entry: Credential, action: 'show' | 'copy') {
    if (action === 'show' && Object.hasOwn(revealed, entry.id)) {
      setRevealed(current => { const next = { ...current }; delete next[entry.id]; return next; }); return;
    }
    if (busy.current) return;
    busy.current = true; setPending(entry.id); setError('');
    const current = generation.current;
    try {
      const value = revealed[entry.id] ?? (await api<{ password: string }>(`/credentials/${encodeURIComponent(entry.id)}/reveal`, { method: 'POST', body: '{}' })).password;
      if (current !== generation.current || document.hidden) return;
      if (action === 'show') setRevealed(previous => ({ ...previous, [entry.id]: value }));
      else await copy(value, `${entry.id}:password`);
    } catch (reason) { if (current === generation.current) setError((reason as Error).message); }
    finally { if (current === generation.current) { busy.current = false; setPending(null); } }
  }
  const normalized = query.trim().toLocaleLowerCase('tr-TR');
  const entries = (data?.entries || []).filter(entry => `${entry.name} ${entry.url} ${entry.username} ${entry.note}`.toLocaleLowerCase('tr-TR').includes(normalized));
  const copyField = (value: string, key: string) => { void copy(value, key).catch(reason => setError((reason as Error).message)); };
  const copyIcon = (key: string) => copied === key ? <Check size={15}/> : <Copy size={15}/>;
  const scanning = syncStarting || sync?.scanning;
  const resultSummary = sync?.lastResult ? `${sync.lastResult.added} eklendi · ${sync.lastResult.updated} güncellendi · ${sync.lastResult.unchanged} değişmedi` : 'İlk kontrol bekleniyor.';
  return <section className="app-credentials" aria-label="Uygulamalar ve Şifreler">
    <div className="credential-heading"><span className="credential-heading-icon" aria-hidden="true"><KeyRound size={23}/></span><div className="credential-heading-copy"><h3>Uygulamalar ve Şifreler <span>{data?.entries.length ?? '—'}</span></h3><p>Yönetim panelleri ve admin giriş bilgileri tek yerde.</p></div><div className="credential-heading-actions"><Button variant="ghost" size="icon" disabled={loading} aria-label="Erişim bilgilerini yenile" onClick={() => void reload()}><RefreshCw size={16} className={loading ? 'spin' : ''}/></Button><Button variant="outline" className="credential-add" disabled={!data || loading || DEMO_MODE} title={DEMO_MODE ? "Demo gerçek giriş bilgisi kaydetmez." : undefined} onClick={() => { clearSecrets(); setEditing('new'); }}><Plus size={16}/>Uygulama ekle</Button></div></div>
    <div className="credential-sync" aria-label="Uygulama erişim bilgilerini otomatik kontrol">
      <div className="credential-sync-heading"><span className="credential-sync-icon" aria-hidden="true"><CalendarClock size={20}/></span><div><strong>Otomatik kontrol</strong><span>{sync ? sync.enabled ? `Her gece ${sync.schedule} · ${sync.timeZone}` : sync.disabledReason || 'Bu sunucuda otomatik kontrol kullanılamıyor.' : 'Kontrol durumu alınıyor…'}</span></div><Button variant="outline" disabled={!sync?.enabled || !!scanning} onClick={() => void checkNow()}><RefreshCw size={15} className={scanning ? 'spin' : ''}/>{scanning ? 'Kontrol ediliyor…' : 'Şimdi kontrol et'}</Button></div>
      {sync && <div className="credential-sync-details"><p><span>Son kontrol</span><time dateTime={sync.lastAttemptAt || undefined}>{syncTime(sync.lastAttemptAt, sync.timeZone)}</time></p><p><span>Sonraki kontrol</span><time dateTime={sync.nextRunAt || undefined}>{sync.nextRunAt ? syncTime(sync.nextRunAt, sync.timeZone) : 'Planlanmadı'}</time></p><p className="credential-sync-summary" aria-live="polite"><span>{scanning ? 'Durum' : 'Son başarılı kontrol'}</span><strong>{scanning ? 'Kontrol sürüyor; kayıtlı bilgiler kullanılabilir.' : resultSummary}</strong>{!scanning && sync.lastSuccessAt && <small>{syncTime(sync.lastSuccessAt, sync.timeZone)}</small>}</p></div>}
      {(syncError || sync?.lastError) && <div className="credential-sync-error" role="alert"><span>{syncError || sync?.lastError} Kayıtlı bilgiler korunuyor.</span>{syncError && <Button variant="ghost" onClick={() => setSyncRefresh(value => value + 1)}>Durumu yenile</Button>}</div>}
      {!!sync?.warnings.length && <ul className="credential-sync-warnings">{sync.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
    </div>
    <output className="credential-feedback" aria-live="polite">{message}</output>
    {error && <div className="notice error-notice" role="alert">{error}<Button variant="outline" onClick={() => void reload()}>Yeniden dene</Button></div>}
    {loading && !data ? <div className="log-empty"><LoaderCircle size={25}/><strong>Erişim bilgileri yükleniyor…</strong></div> : data && <>
      <div className="credential-table-scroll"><table className="credential-table"><thead><tr><th>Uygulama</th><th>Yönetim paneli adresi</th><th>Username</th><th>Password</th><th><span className="sr-only">İşlemler</span></th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}>
        <td><div className="credential-entry"><span className="credential-entry-icon" aria-hidden="true"><PanelsTopLeft size={17}/></span><strong>{entry.name}</strong>{entry.note && <p className="credential-note">{entry.note}</p>}</div></td>
        <td><div className="credential-value"><a href={entry.url} target="_blank" rel="noopener noreferrer" className="credential-url" aria-label={`${entry.name} yönetim panelini aç`}><span>{entry.url}</span><ArrowUpRight size={15}/></a><Button variant="ghost" size="icon" aria-label={`${entry.name} adresini kopyala`} onClick={() => copyField(entry.url, `${entry.id}:url`)}>{copyIcon(`${entry.id}:url`)}</Button></div></td>
        <td><div className="credential-value">{entry.username ? <><code>{entry.username}</code><Button variant="ghost" size="icon" aria-label={`${entry.name} kullanıcı adını kopyala`} onClick={() => copyField(entry.username, `${entry.id}:username`)}>{copyIcon(`${entry.id}:username`)}</Button></> : <span className="credential-missing">Kayıtlı değil</span>}</div></td>
        <td><div className="credential-value">{entry.hasPassword ? <><code className={Object.hasOwn(revealed, entry.id) ? 'credential-secret' : 'credential-mask'}>{revealed[entry.id] ?? '••••••••••'}</code><Button variant="ghost" size="icon" disabled={pending !== null} aria-label={`${entry.name} şifresini ${Object.hasOwn(revealed, entry.id) ? 'gizle' : 'göster'}`} onClick={() => void access(entry, 'show')}>{pending === entry.id ? <LoaderCircle size={15}/> : Object.hasOwn(revealed, entry.id) ? <EyeOff size={15}/> : <Eye size={15}/>}</Button><Button variant="ghost" size="icon" disabled={pending !== null} aria-label={`${entry.name} şifresini kopyala`} onClick={() => void access(entry, 'copy')}>{copyIcon(`${entry.id}:password`)}</Button></> : <span className="credential-missing">Kayıtlı değil</span>}</div></td>
        <td><Button variant="ghost" size="icon" disabled={DEMO_MODE} aria-label={`${entry.name} erişim bilgilerini düzenle`} onClick={() => { clearSecrets(); setEditing(entry); }}><Pencil size={15}/></Button></td>
      </tr>)}</tbody></table></div>
      {!entries.length && <div className="log-empty"><KeyRound size={28}/><strong>{normalized ? 'Aramanızla eşleşen erişim kaydı yok.' : 'Henüz erişim bilgisi eklenmedi.'}</strong><p>{normalized ? 'Uygulama adı, adres veya kullanıcı adıyla arayabilirsiniz.' : 'Uygulama ekle ile yönetim panelini ve giriş bilgilerini kaydedin.'}</p></div>}
      <p className="credential-footer">{entries.length} / {data.entries.length} kayıt<span>Şifreyi görmek için göz simgesini kullanın.</span></p>
    </>}
    {editing && data && <CredentialEditor key={typeof editing === 'string' ? 'new' : editing.id} entry={editing === 'new' ? null : editing} revision={data.revision} onClose={() => setEditing(null)} onConflict={() => void reload()} onSaved={result => { clearSecrets(); setData(result); setMessage('Erişim bilgileri kaydedildi.'); }}/>}
  </section>;
}

