'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleCheck, CircleHelp, Fingerprint, KeyRound, LoaderCircle, Monitor, Pencil, Plus, RefreshCw, Server, ShieldCheck, Terminal, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from './api';
import { DEMO_MODE } from '@/lib/public-mode';

type Capability = 'inventory' | 'resources' | 'storage' | 'files' | 'control' | 'versions' | 'models';
export type Connection = {
  id: string; name: string; host: string; port: number; username: string;
  platform: 'linux' | 'windows'; authType: 'password' | 'key'; fingerprint: string;
  status: 'pending' | 'installing' | 'ready' | 'error'; phase: string; message?: string;
  capabilities?: Partial<Record<Capability, boolean>> & { reasons?: Partial<Record<Capability, string>>; aclTools?: boolean };
  updatedAt?: string;
  configRevision?: number;
};
const capabilityNames: Record<Capability, string> = { inventory: 'Uygulamalar ve portlar', resources: 'CPU ve bellek', storage: 'Depolama', files: 'Dosyalar', control: 'Servis yönetimi', versions: 'Git / sürümler', models: 'Model keşfi' };
const statusNames = { pending: 'Sırada', installing: 'Kuruluyor', ready: 'Hazır', error: 'Kontrol gerekli' };
const phaseNames: Record<string, string> = { queued: 'Kurulum sırada', connecting: 'SSH bağlantısı kuruluyor', authenticating: 'Kimlik doğrulanıyor', checking: 'Gereksinimler kontrol ediliyor', dependencies: 'Gerekli bileşenler hazırlanıyor', uploading: 'ViiOS bileşenleri aktarılıyor', installing: 'ViiOS hazırlanıyor', verifying: 'Kurulum doğrulanıyor', ready: 'Sunucu hazır', complete: 'Kurulum tamamlandı', error: 'Kurulum tamamlanamadı', failed: 'Kurulum tamamlanamadı', interrupted: 'Kurulum yarıda kaldı' };
export const connectionsChanged = () => window.dispatchEvent(new Event('viios-connections-changed'));

function AclInstallationNotice({ missing = false }: { missing?: boolean }) {
  return <aside className="connection-acl-note" aria-label="ACL kurulumu hakkında">
    <CircleHelp size={17} aria-hidden="true"/>
    <div><strong>{missing ? 'ACL komut araçları doğrulanamadı · Kurulumu engellemez' : 'ACL paketi isteğe bağlıdır'}</strong>
      <p>ViiOS dosya izinlerini Python üzerinden yönetir; <code>acl</code> paketini zorunlu tutmaz. Paket olmadan komut satırındaki <code>getfacl</code> / <code>setfacl</code> araçları kullanılamayabilir.</p>
      <p>Dosya sistemi ACL desteklemiyorsa veya izin değişikliğini reddederse, bazı proje klasörlerinde sürüm yönetimi için ek erişim hazırlama işlemi yapılamaz. Böyle bir durumda ViiOS açıklayıcı bir popup gösterir. İzleme ve mevcut izinlerle yapılabilen dosya işlemleri kullanılmaya devam eder.</p>
    </div>
  </aside>;
}

export function ServerConnectionWizard({ open, connection, onClose, onCreated }: { open: boolean; connection?: Connection; onClose: () => void; onCreated?: (server: Connection) => void }) {
  const [busy, setBusy] = useState(false);
  if (DEMO_MODE) return null;
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}><DialogContent className="connection-dialog" showCloseButton={false}>{open && <ConnectionForm key={connection?.id || 'new'} connection={connection} onClose={onClose} onCreated={onCreated} onBusy={setBusy}/>}</DialogContent></Dialog>;
}

function ConnectionForm({ connection, onClose, onCreated, onBusy }: { connection?: Connection; onClose: () => void; onCreated?: (server: Connection) => void; onBusy: (busy: boolean) => void }) {
  const field = useId();
  const request = useRef<AbortController | null>(null);
  const [step, setStep] = useState<'target' | 'verify' | 'credentials'>('target');
  const [platform, setPlatform] = useState<'linux' | 'windows'>(connection?.platform || 'linux');
  const [name, setName] = useState(connection?.name || ''), [host, setHost] = useState(connection?.host || ''), [port, setPort] = useState(String(connection?.port || 22));
  const [probe, setProbe] = useState<{ fingerprint: string; algorithm: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [username, setUsername] = useState(connection?.username || ''), [authType, setAuthType] = useState<'password' | 'key'>(connection?.authType || 'password');
  const [keepCredentials, setKeepCredentials] = useState(!!connection);
  const keepingCredentials = !!connection && keepCredentials && authType === connection.authType;
  const [password, setPassword] = useState(''), [privateKey, setPrivateKey] = useState(''), [passphrase, setPassphrase] = useState(''), [sudoPassword, setSudoPassword] = useState('');
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const clearSecrets = () => { setPassword(''); setPrivateKey(''); setPassphrase(''); setSudoPassword(''); };
  async function inspect() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setProbe(null); setConfirmed(false); clearSecrets();
    try {
      const result = await api<{ fingerprint: string; algorithm: string }>('/connections/probe', { method: 'POST', body: JSON.stringify({ host: host.trim(), port: Number(port), platform }), signal: controller.signal });
      if (!controller.signal.aborted) { setProbe(result); setStep('verify'); }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  async function connect() {
    if (request.current || !probe || !confirmed) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const { server } = await api<{ server: Connection }>(connection ? `/connections/${encodeURIComponent(connection.id)}` : '/connections', { method: connection ? 'PUT' : 'POST', body: JSON.stringify({ name: name.trim() || host.trim(), host: host.trim(), port: Number(port), platform, username: username.trim(), authType, ...(!keepingCredentials ? authType === 'password' ? { password } : { privateKey, ...(passphrase ? { passphrase } : {}) } : {}), ...(platform === 'linux' && sudoPassword ? { sudoPassword } : {}), fingerprint: probe.fingerprint, ...(connection ? { keepCredentials: keepingCredentials, expectedRevision: connection.configRevision ?? 0 } : {}) }), signal: controller.signal });
      if (controller.signal.aborted) return;
      clearSecrets(); connectionsChanged(); onCreated?.(server); onClose();
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  return <>
    <DialogHeader><div className="connection-dialog-title"><span className="onboarding-small-icon"><Server size={21}/></span><DialogTitle>{connection ? 'Sunucuyu düzenle' : 'Sunucu ekle'}</DialogTitle><Button type="button" variant="ghost" size="icon" aria-label={connection ? 'Sunucu düzenlemeyi kapat' : 'Sunucu eklemeyi kapat'} disabled={busy} onClick={onClose}><X size={18}/></Button></div><DialogDescription>{connection ? 'Bağlantı bilgilerini güncelleyin, SSH kimliğini yeniden doğrulayın ve aynı sunucu kaydına yeniden bağlanın.' : 'Hedefi seçin, SSH kimliğini doğrulayın ve ViiOS bağlantısını hazırlayın.'}</DialogDescription></DialogHeader>
    <ol className="connection-steps" aria-label="Bağlantı adımları">{(['target', 'verify', 'credentials'] as const).map((value, index) => <li key={value} aria-current={step === value ? 'step' : undefined}><span>{index + 1}</span>{['Sunucu', 'Kimlik', 'Bağlantı'][index]}</li>)}</ol>
    {step === 'target' && <form className="connection-form" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <fieldset disabled={busy}><legend>Hedef işletim sistemi</legend><div className="connection-platforms"><button type="button" aria-pressed={platform === 'linux'} onClick={() => setPlatform('linux')}><Terminal size={25}/><strong>Linux</strong><span>SSH üzerinden bağlantı</span>{platform === 'linux' && <Check size={15}/>}</button><button type="button" aria-pressed={platform === 'windows'} onClick={() => setPlatform('windows')}><Monitor size={25}/><strong>Windows</strong><span>OpenSSH Server üzerinden</span>{platform === 'windows' && <Check size={15}/>}</button></div></fieldset>
      <label htmlFor={`${field}-name`}>Görünen ad<Input id={`${field}-name`} value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="Örn. Üretim sunucusu" disabled={busy}/></label>
      <div className="connection-address"><label htmlFor={`${field}-host`}>IP adresi veya sunucu adı<Input id={`${field}-host`} value={host} onChange={event => setHost(event.target.value)} autoComplete="off" spellCheck={false} maxLength={253} required placeholder="sunucu.example.com" disabled={busy}/></label><label htmlFor={`${field}-port`}>SSH portu<Input id={`${field}-port`} type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} required disabled={busy}/></label></div>
      <p className="connection-info"><CircleHelp size={16}/>{platform === 'windows' ? 'Hedef Windows sunucusunda OpenSSH Server etkin olmalı. Kullanacağınız hesabın kurulum için gereken yetkilere sahip olması gerekir.' : 'Hedef Linux sunucusunda SSH erişimi açık olmalı. Kurulum adımı gerekli bileşenleri ve hesap yetkilerini kontrol eder.'}</p>
      {platform === 'linux' && <AclInstallationNotice/>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <div className="connection-form-actions"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Vazgeç</Button><Button type="submit" disabled={busy || !host.trim()}>{busy ? <LoaderCircle className="spin" size={15}/> : <Fingerprint size={15}/>}SSH kimliğini kontrol et</Button></div>
    </form>}
    {step === 'verify' && probe && <div className="connection-form"><div className="connection-verified-target"><ShieldCheck size={24}/><div><strong>{name || host}</strong><span>{host}:{port} · {platform === 'windows' ? 'Windows' : 'Linux'}</span></div></div><div className="connection-fingerprint"><span>SSH SUNUCU PARMAK İZİ</span><code>{probe.fingerprint}</code><small>{probe.algorithm}</small></div><p className="connection-info"><Fingerprint size={16}/>Bu parmak izini sunucu konsolundaki veya yöneticinizden aldığınız değerle karşılaştırın. Devam ettiğinizde yalnızca bu SSH kimliğine sahip sunucuya bağlanılır.</p><label className="connection-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Parmak izini doğruladım ve bu sunucuya güveniyorum.</label><div className="connection-form-actions"><Button type="button" variant="outline" onClick={() => { setStep('target'); setProbe(null); setConfirmed(false); }}><ArrowLeft size={15}/>Geri</Button><Button type="button" disabled={!confirmed} onClick={() => { setError(''); setStep('credentials'); }}>Doğrula ve devam et<ArrowRight size={15}/></Button></div></div>}
    {step === 'credentials' && <form className="connection-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <div className="connection-verified-target"><ShieldCheck size={22}/><div><strong>{name || host}</strong><span>{host}:{port} · SSH kimliği doğrulandı</span></div></div>
      <label htmlFor={`${field}-username`}>SSH kullanıcı adı<Input id={`${field}-username`} value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} required disabled={busy} placeholder={platform === 'windows' ? 'Kullanıcı adı' : 'Kullanıcı adı'}/></label>
      <fieldset disabled={busy}><legend>Kimlik doğrulama</legend><div className="connection-auth-tabs"><Button type="button" variant="outline" aria-pressed={authType === 'password'} onClick={() => { setAuthType('password'); setKeepCredentials(connection?.authType === 'password'); clearSecrets(); }}>Şifre</Button><Button type="button" variant="outline" aria-pressed={authType === 'key'} onClick={() => { setAuthType('key'); setKeepCredentials(connection?.authType === 'key'); clearSecrets(); }}><KeyRound size={14}/>Özel anahtar</Button></div></fieldset>
      {connection && <div className="connection-credential-choice">{authType === connection.authType ? <label className="connection-confirm"><input type="checkbox" checked={keepingCredentials} disabled={busy} onChange={event => { setKeepCredentials(event.target.checked); clearSecrets(); }}/>Kayıtlı SSH kimlik bilgilerini kullan</label> : <p className="connection-info">Kimlik doğrulama yöntemini değiştirdiniz. Yeni yöntemin bilgilerini girin.</p>}<p className="connection-info">Kayıtlı şifre ve özel anahtar gösterilmez.{authType === connection.authType ? ' Değiştirmek için kayıtlı bilgileri kullan seçeneğini kaldırın.' : ''}</p></div>}
      {authType === 'password' ? <label htmlFor={`${field}-password`}>{connection ? 'Yeni SSH şifresi' : 'SSH şifresi'}<Input id={`${field}-password`} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required={!keepingCredentials} disabled={busy || keepingCredentials} placeholder={keepingCredentials ? 'Kayıtlı şifre korunacak' : undefined}/></label> : <><label htmlFor={`${field}-key`}>{connection ? 'Yeni SSH özel anahtarı' : 'SSH özel anahtarı'}<Textarea id={`${field}-key`} value={privateKey} onChange={event => setPrivateKey(event.target.value)} autoComplete="off" spellCheck={false} rows={5} required={!keepingCredentials} disabled={busy || keepingCredentials} placeholder={keepingCredentials ? 'Kayıtlı özel anahtar korunacak' : '-----BEGIN OPENSSH PRIVATE KEY-----'}/></label><label htmlFor={`${field}-passphrase`}>Anahtar parolası <small>İsteğe bağlı</small><Input id={`${field}-passphrase`} type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} disabled={busy || keepingCredentials}/></label></>}
      {platform === 'linux' && <label htmlFor={`${field}-sudo`}>sudo şifresi <small>Gerekiyorsa, yalnızca kurulum için</small><Input id={`${field}-sudo`} type="password" autoComplete="new-password" value={sudoPassword} onChange={event => setSudoPassword(event.target.value)} disabled={busy}/><small>Hesap parolasız sudo kullanabiliyorsa veya ek yetki gerekmiyorsa boş bırakın.</small></label>}
      <p className="connection-info"><ShieldCheck size={16}/>ViiOS seçili sunucuda bağlantı bileşenlerini hazırlar ve desteklenen özellikleri doğrular. Kurulumun ilerleyişini Sunucular ekranından izleyebilirsiniz.</p>
      {platform === 'linux' && <AclInstallationNotice/>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <div className="connection-form-actions"><Button type="button" variant="outline" disabled={busy} onClick={() => { clearSecrets(); setError(''); setStep('verify'); }}><ArrowLeft size={15}/>Geri</Button><Button type="submit" disabled={busy || !username.trim() || (!keepingCredentials && (authType === 'password' ? !password : !privateKey.trim()))}>{busy ? <LoaderCircle className="spin" size={15}/> : <Server size={15}/>}{busy ? 'Bağlantı hazırlanıyor…' : connection ? 'Kaydet ve yeniden bağlan' : 'Bağlan ve kurulumu başlat'}</Button></div>
    </form>}
  </>;
}

export default function ServerConnections({ onSelect, disabled = false, showAdd = true }: { onSelect: (id: string) => void; disabled?: boolean; showAdd?: boolean }) {
  const [servers, setServers] = useState<Connection[] | null>(null), [error, setError] = useState('');
  const [adding, setAdding] = useState(false), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null), [retrying, setRetrying] = useState<Connection | null>(null);
  const [sudoPassword, setSudoPassword] = useState(''), [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  const mutation = useRef<AbortController | null>(null);
  const field = useId();
  const refresh = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const cancel = () => { clearTimeout(timer); request?.abort(); request = null; };
    async function load() {
      if (!active || document.hidden || request) return;
      const controller = new AbortController(); request = controller;
      let delay = 10000;
      try {
        const result = await api<{ servers: Connection[] }>('/connections', { signal: controller.signal, cache: 'no-store' });
        if (!active || controller.signal.aborted) return;
        setServers(result.servers); setError('');
        if (result.servers.some(server => ['pending', 'installing'].includes(server.status))) delay = 2000;
      } catch (reason) { if (active && !controller.signal.aborted) setError((reason as Error).message); }
      finally { if (request === controller) request = null; if (active && !controller.signal.aborted && !document.hidden) timer = setTimeout(() => void load(), delay); }
    }
    const wake = () => { cancel(); if (!document.hidden) void load(); };
    timer = setTimeout(() => void load(), 0);
    document.addEventListener('visibilitychange', wake); window.addEventListener('viios-connections-changed', wake);
    return () => { active = false; cancel(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('viios-connections-changed', wake); };
  }, [reload]);
  useEffect(() => () => mutation.current?.abort(), []);
  async function mutate(action: 'retry' | 'remove', server: Connection) {
    if (mutation.current) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setActionError('');
    try {
      await api(`/connections/${encodeURIComponent(server.id)}${action === 'retry' ? '/retry' : ''}`, { method: action === 'retry' ? 'POST' : 'DELETE', ...(action === 'retry' ? { body: JSON.stringify(sudoPassword ? { sudoPassword } : {}) } : {}), signal: controller.signal });
      if (controller.signal.aborted) return;
      setSudoPassword(''); setRetrying(null); setRemoving(null); connectionsChanged(); refresh();
    } catch (reason) { if (!controller.signal.aborted) setActionError((reason as Error).message); }
    finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(false); } }
  }
  return <section className="connection-manager" aria-label="Sunucu bağlantıları">
    {DEMO_MODE && <p className="connection-info">Bunlar örnek sunuculardır. Gerçek bağlantı bilgileri istenmez; kendi sunucunuzu eklemek için ViiOS kurulumunu kullanın.</p>}
    <header><div><h2>Sunucularınız</h2><p>Bağlantılar, kurulum durumu ve kullanılabilir özellikler.</p></div><div><Button variant="ghost" size="icon" aria-label="Sunucu bağlantılarını yenile" disabled={busy} onClick={refresh}><RefreshCw size={16}/></Button>{showAdd && <Button disabled={disabled || DEMO_MODE} title={DEMO_MODE ? "Sunucu eklemek için ViiOS kurulumu gerekir." : undefined} onClick={() => setAdding(true)}><Plus size={16}/>Sunucu ekle</Button>}</div></header>
    {error && <p className="onboarding-error" role="alert">{error}</p>}
    {!servers && !error ? <div className="connection-empty"><LoaderCircle className="spin"/><p>Sunucu bağlantıları alınıyor…</p></div> : !servers?.length ? <div className="connection-empty"><Server size={32}/><h3>İlk sunucunuzu bağlayın.</h3><p>Windows veya Linux hedefi seçin. SSH kimliğini doğruladıktan sonra ViiOS bağlantıyı sizin için hazırlasın.</p>{showAdd && <Button variant="outline" disabled={disabled || DEMO_MODE} title={DEMO_MODE ? "Sunucu eklemek için ViiOS kurulumu gerekir." : undefined} onClick={() => setAdding(true)}><Plus size={16}/>İlk sunucuyu ekle</Button>}</div> : <div className="connection-grid">{servers.map(server => <article className="connection-card" key={server.id}>
      <header><span className="onboarding-small-icon" aria-hidden="true">{server.platform === 'windows' ? <Monitor size={22}/> : <Terminal size={22}/>}</span><div><h3>{server.name}</h3><span>{server.host}:{server.port} · {server.platform === 'windows' ? 'Windows' : 'Linux'}</span></div><span className={`connection-status ${server.status}`}>{server.status === 'ready' ? <Check size={13}/> : server.status === 'installing' || server.status === 'pending' ? <LoaderCircle className="spin" size={13}/> : <CircleHelp size={13}/>} {statusNames[server.status]}</span></header>
      <div className="connection-progress" aria-live="polite"><strong>{phaseNames[server.phase] || statusNames[server.status]}</strong>{server.message && <p>{server.message}</p>}{(server.status === 'installing' || server.status === 'pending') && <span className="connection-progress-line" aria-hidden="true"/>}</div>
      {server.capabilities && <ul className="connection-capabilities" aria-label={`${server.name} özellikleri`}>{(Object.keys(capabilityNames) as Capability[]).filter(key => typeof server.capabilities?.[key] === 'boolean').map(key => <li className={server.capabilities?.[key] ? 'available' : 'unavailable'} key={key} title={server.capabilities?.reasons?.[key]}>{server.capabilities?.[key] ? <CircleCheck size={13}/> : <X size={13}/>}<span>{capabilityNames[key]}{!server.capabilities?.[key] && <small>{server.capabilities?.reasons?.[key] || 'Kullanılamıyor'}</small>}</span></li>)}</ul>}
      {server.platform === 'linux' && server.capabilities?.aclTools === false && <AclInstallationNotice missing/>}
      <footer><span>{server.username} · {server.authType === 'key' ? 'SSH anahtarı' : 'SSH şifresi'}</span><div>{server.status === 'ready' && <Button size="sm" disabled={disabled} onClick={() => onSelect(server.id)}>Masaüstünü aç<ArrowRight size={14}/></Button>}{server.status === 'error' && <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setActionError(''); setSudoPassword(''); setRetrying(server); }}><RefreshCw size={14}/>Tekrar dene</Button>}<Button size="sm" variant="outline" disabled={disabled || busy || DEMO_MODE} aria-label={`${server.name} bağlantısını düzenle`} onClick={() => setEditing(server)}><Pencil size={14}/>Düzenle</Button><Button variant="ghost" size="icon-sm" disabled={disabled || busy || DEMO_MODE || server.status === 'installing' || server.status === 'pending'} aria-label={`${server.name} bağlantısını kaldır`} onClick={() => { setActionError(''); setRemoving(server); }}><Trash2 size={14}/></Button></div></footer>
    </article>)}</div>}
    <ServerConnectionWizard open={adding} onClose={() => setAdding(false)} onCreated={refresh}/>
    <ServerConnectionWizard open={!!editing} connection={editing || undefined} onClose={() => setEditing(null)} onCreated={refresh}/>
    <Dialog open={!!removing} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}><DialogContent className="connection-action-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>Bağlantı kaldırılsın mı?</DialogTitle><DialogDescription>{removing?.name} · {removing?.host}</DialogDescription></DialogHeader><p>Bu bağlantı ViiOS’tan kaldırılır. Sunucudaki dosyalar ve ViiOS bileşenleri silinmez.</p>{actionError && <p className="onboarding-error" role="alert">{actionError}</p>}<div className="connection-form-actions"><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>Vazgeç</Button><Button variant="destructive" disabled={busy} onClick={() => { if (removing) void mutate('remove', removing); }}>{busy ? 'Kaldırılıyor…' : 'Bağlantıyı kaldır'}</Button></div></DialogContent></Dialog>
    <Dialog open={!!retrying} onOpenChange={open => { if (!open && !busy) { setRetrying(null); setSudoPassword(''); } }}><DialogContent className="connection-action-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>Kurulumu yeniden dene</DialogTitle><DialogDescription>{retrying?.name} · {retrying?.host}</DialogDescription></DialogHeader><p>Kayıtlı bağlantı bilgileri ve doğrulanmış SSH kimliği kullanılır.</p>{retrying?.platform === 'linux' && <AclInstallationNotice/>}{retrying?.platform === 'linux' && <label htmlFor={`${field}-retry-sudo`}>sudo şifresi · Gerekiyorsa<Input id={`${field}-retry-sudo`} type="password" autoComplete="new-password" value={sudoPassword} onChange={event => setSudoPassword(event.target.value)} disabled={busy}/></label>}{actionError && <p className="onboarding-error" role="alert">{actionError}</p>}<div className="connection-form-actions"><Button variant="outline" disabled={busy} onClick={() => { setRetrying(null); setSudoPassword(''); }}>Vazgeç</Button><Button disabled={busy} onClick={() => { if (retrying) void mutate('retry', retrying); }}>{busy ? 'Başlatılıyor…' : 'Kurulumu yeniden başlat'}</Button></div></DialogContent></Dialog>
  </section>;
}
