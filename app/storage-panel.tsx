'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Boxes, ChevronRight, Clock3, Database, File, Folder, FolderOpen, HardDrive, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTarget } from './target-context';
import { storageBytes, storagePercent } from './storage-format';

type Capacity = {
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
  reservedBytes: number | null;
  percent: number | null;
};
type Volume = Capacity & { id: string; source: string; mount: string; filesystem: string; reason?: string };
type Overview = {
  available: boolean;
  sampledAt: number | string | null;
  hostname: string;
  summary: (Capacity & { volumeCount: number }) | null;
  volumes: Volume[];
  reason?: string;
};
type Scan = {
  status: 'scanning' | 'ready' | 'error';
  scannedAt: number | string | null;
  partial: boolean;
  reason?: string;
  error?: string;
};
type FolderEntry = { name: string; path: string; kind: 'directory' | 'file'; bytes: number | null; partial?: boolean; mount?: boolean; navigable?: boolean; reason?: string };
type FolderUsage = Scan & { path: string; totalBytes: number | null; entries: FolderEntry[] };
type AppUsage = Scan & { applications: { id: string; name: string; path: string | null; bytes: number | null; partial?: boolean; reason?: string }[] };
type Tab = 'volumes' | 'folders' | 'applications';

function measuredBytes(value: number | null | undefined, partial?: boolean) {
  return `${partial && value != null ? 'En az ' : ''}${storageBytes(value)}`;
}

function volumePressure(volume: Capacity): 'normal' | 'warning' | 'critical' {
  const available = volume.availableBytes;
  const used = volume.usedBytes;
  if (available != null && used != null && used + available > 0) {
    const remaining = available / (used + available);
    return remaining <= .05 ? 'critical' : remaining <= .15 ? 'warning' : 'normal';
  }
  return volume.percent != null && volume.percent >= 95 ? 'critical' : volume.percent != null && volume.percent >= 85 ? 'warning' : 'normal';
}

function sampledTime(value: number | string | null | undefined) {
  if (value == null) return 'Henüz ölçülmedi';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Ölçüm zamanı bilinmiyor' : date.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Only the active panel polls; hide/unmount cancels both the timer and request. */
function useStorageRead<T>(endpoint: string, visible: boolean, overview = false) {
  const { api, id } = useTarget();
  const key = `${id}:${endpoint}`;
  const [snapshot, setSnapshot] = useState<{ key: string; data?: T; error?: string; fetching: boolean }>({ key, fetching: true });
  const [revision, setRevision] = useState(0);
  const forcedRevision = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const cancel = () => { clearTimeout(timer); timer = undefined; request?.abort(); request = null; };
    async function read() {
      if (!active || document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      const force = !overview && revision > forcedRevision.current;
      setSnapshot(previous => ({ key, data: previous.key === key ? previous.data : undefined, fetching: true }));
      let delay: number | undefined = overview ? 15000 : undefined;
      try {
        const result = await api<T>(`${endpoint}${force ? `${endpoint.includes('?') ? '&' : '?'}refresh=1` : ''}`, { cache: 'no-store', signal: controller.signal });
        if (!active || controller.signal.aborted || document.hidden) return;
        if (force) forcedRevision.current = revision;
        setSnapshot({ key, data: result, fetching: false });
        if (!overview && (result as Scan).status === 'scanning') delay = 2000;
      } catch (reason) {
        if (active && !controller.signal.aborted && !document.hidden) {
          setSnapshot(previous => ({ key, data: previous.key === key ? previous.data : undefined, error: (reason as Error).message, fetching: false }));
        }
      } finally {
        if (request === controller) request = null;
        if (active && !controller.signal.aborted && !document.hidden && delay !== undefined) timer = setTimeout(() => void read(), delay);
      }
    }
    const visibility = () => { cancel(); if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visibility);
    timer = setTimeout(() => void read(), 0);
    return () => { active = false; cancel(); document.removeEventListener('visibilitychange', visibility); };
  }, [api, endpoint, id, key, overview, revision, visible]);
  return {
    data: snapshot.key === key ? snapshot.data : undefined,
    error: snapshot.key === key ? snapshot.error : undefined,
    fetching: snapshot.key !== key || snapshot.fetching,
    reload: () => setRevision(value => value + 1),
  };
}

function CapacityBar({ value, label, pressure }: { value: number | null | undefined; label: string; pressure?: 'normal' | 'warning' | 'critical' }) {
  const known = value != null && Number.isFinite(value);
  return <><span className="sr-only">{label}: {storagePercent(value)} kullanılıyor</span><div className={`storage-capacity ${pressure || ''}${!known ? ' unknown' : ''}`} aria-hidden="true">
    {known && <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />}
  </div></>;
}

function EmptyState({ title, detail, busy = false }: { title: string; detail?: string; busy?: boolean }) {
  return <div className="storage-empty" aria-live="polite">{busy ? <LoaderCircle className="spin" size={29} aria-hidden="true"/> : <HardDrive size={29} aria-hidden="true"/>}<strong>{title}</strong>{detail && <p>{detail}</p>}</div>;
}

function ScanNotice({ data, error }: { data?: Scan; error?: string }) {
  const failure = error || (data?.status === 'error' ? data.error || data.reason || 'Tarama tamamlanamadı.' : undefined);
  if (failure) return <div className="storage-notice error" role="alert"><AlertCircle size={17} aria-hidden="true"/><p>{failure}{data?.scannedAt ? ' Son başarılı taramanın sonuçları gösteriliyor.' : ''}</p></div>;
  if (data?.partial) return <div className="storage-notice" aria-live="polite"><Info size={17} aria-hidden="true"/><p>{data.reason || 'Bazı dizinlere erişilemedi veya tarama sınırına ulaşıldı. Boyutlar eksik olabilir.'}</p></div>;
  return null;
}

function ScanToolbar({ data, fetching, reload, children }: { data?: Scan; fetching: boolean; reload: () => void; children: React.ReactNode }) {
  const scanning = data?.status === 'scanning';
  return <div className="storage-scan-toolbar"><div>{children}<span className="storage-scan-time"><Clock3 size={13} aria-hidden="true"/>{scanning ? 'Tarama sürüyor' : 'Son tarama'} · {sampledTime(data?.scannedAt)}</span></div><Button variant="outline" disabled={fetching || scanning} onClick={reload}><RefreshCw size={15} className={scanning || fetching ? 'spin' : ''}/>{scanning ? 'Taranıyor…' : 'Yeniden tara'}</Button></div>;
}

function FolderDetails({ path, visible, onPath }: { path: string; visible: boolean; onPath: (path: string) => void }) {
  const { data, error, fetching, reload } = useStorageRead<FolderUsage>(`/storage/usage?path=${encodeURIComponent(path)}`, visible);
  const parts = path.split('/').filter(Boolean);
  const entries = [...(data?.entries || [])].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name, 'tr'));
  return <>
    <nav className="storage-breadcrumbs" aria-label="Depolama klasör yolu"><Button variant="ghost" onClick={() => onPath('/')} aria-current={path === '/' ? 'location' : undefined}><HardDrive size={15}/>Kök /</Button>{parts.map((part, index) => { const target = `/${parts.slice(0, index + 1).join('/')}`; return <span key={target}><ChevronRight size={13} aria-hidden="true"/><Button variant="ghost" onClick={() => onPath(target)} aria-current={target === path ? 'location' : undefined}>{part}</Button></span>; })}</nav>
    <ScanToolbar data={data} fetching={fetching} reload={reload}><h3><FolderOpen size={18} aria-hidden="true"/><span>{path}</span></h3><p>Ölçülen alan <strong>{measuredBytes(data?.totalBytes, data?.partial)}</strong>{data?.partial ? ' · Kısmi ölçüm' : ''}</p></ScanToolbar>
    <ScanNotice data={data} error={error}/>
    {!data && !error ? <EmptyState busy title="Klasör boyutları hesaplanıyor…" detail="Büyük dizinlerin taranması zaman alabilir."/> : entries.length ? <div className="storage-entry-list" aria-label={`${path} içindeki alan kullanımı`}>{entries.map(entry => {
      const relative = !entry.mount && entry.bytes != null && data?.totalBytes != null && data.totalBytes > 0 ? entry.bytes / data.totalBytes * 100 : null;
      return <article className="storage-entry" key={entry.path}><span className="storage-entry-icon" aria-hidden="true">{entry.mount ? <HardDrive size={19}/> : entry.kind === 'directory' ? <Folder size={19}/> : <File size={19}/>}</span><div className="storage-entry-body">{entry.kind === 'directory' && entry.navigable !== false ? <button className="storage-path-link" onClick={() => onPath(entry.path)} aria-label={`${entry.path} klasörünü aç`}>{entry.name}<ChevronRight size={14} aria-hidden="true"/></button> : <strong>{entry.name}</strong>}<code>{entry.path}</code>{entry.mount && <span className="storage-small-badge">{entry.navigable === false ? 'Sanal dosya sistemi · üst klasöre dahil değil' : 'Ayrı disk bölümü · üst klasöre dahil değil'}</span>}{entry.reason && <p className="storage-entry-reason">{entry.reason}</p>}{relative != null && <CapacityBar value={relative} label={entry.path}/>}</div><div className="storage-entry-size"><strong>{measuredBytes(entry.bytes, entry.partial)}</strong><small>{entry.mount ? entry.navigable === false ? 'Kapsam dışı' : 'Ayrı bölüm' : entry.partial ? 'Kısmi ölçüm' : entry.bytes == null ? 'Ölçülemedi' : storagePercent(relative)}</small></div></article>;
    })}</div> : <EmptyState busy={data?.status === 'scanning'} title={data?.status === 'scanning' ? 'Klasörler taranıyor…' : error || data?.status === 'error' ? 'Klasör kullanımı alınamadı' : 'Bu klasörde gösterilecek kayıt yok'} detail={data?.status === 'scanning' ? 'Sonuçlar tarama tamamlandığında görünür.' : undefined}/>}
    <p className="storage-explanation"><Info size={15} aria-hidden="true"/>Klasörler diskte ayrılan alanla ölçülür. Dosya sistemi üstverisi, erişilemeyen dosyalar ve silinmiş ancak açık tutulan dosyalar nedeniyle toplam, disk bölümünün kullanılan alanından farklı olabilir. Ayrı bağlı disk bölümleri üst klasörün toplamına katılmaz.</p>
  </>;
}

function ApplicationDetails({ visible, onPath }: { visible: boolean; onPath: (path: string) => void }) {
  const { data, error, fetching, reload } = useStorageRead<AppUsage>('/storage/apps', visible);
  const applications = [...(data?.applications || [])].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name, 'tr'));
  return <>
    <ScanToolbar data={data} fetching={fetching} reload={reload}><h3><Boxes size={18} aria-hidden="true"/>Uygulama klasörleri</h3><p>{data ? `${applications.length} uygulama` : 'Kayıtlı uygulamaların disk kullanımı'}</p></ScanToolbar>
    <ScanNotice data={data} error={error}/>
    {!data && !error ? <EmptyState busy title="Uygulama boyutları hesaplanıyor…"/> : applications.length ? <div className="storage-entry-list" aria-label="Uygulama alan kullanımı">{applications.map(app => <article className="storage-entry" key={app.id}><span className="storage-entry-icon" aria-hidden="true"><Boxes size={19}/></span><div className="storage-entry-body">{app.path?.startsWith('/') ? <button className="storage-path-link" onClick={() => onPath(app.path!)} aria-label={`${app.name} uygulamasının klasörünü aç`}>{app.name}<ChevronRight size={14} aria-hidden="true"/></button> : <strong>{app.name}</strong>}<code>{app.path || 'Klasör bilinmiyor'}</code>{app.reason && <p className="storage-entry-reason">{app.reason}</p>}</div><div className="storage-entry-size"><strong>{measuredBytes(app.bytes, app.partial)}</strong><small>{app.partial ? 'Kısmi ölçüm' : app.bytes == null ? 'Ölçülemedi' : 'Klasör boyutu'}</small></div></article>)}</div> : <EmptyState busy={data?.status === 'scanning'} title={data?.status === 'scanning' ? 'Uygulama klasörleri taranıyor…' : error || data?.status === 'error' ? 'Uygulama kullanımı alınamadı' : 'Ölçülebilecek uygulama bulunamadı'} detail={data?.status === 'scanning' ? 'Sonuçlar tarama tamamlandığında görünür.' : undefined}/>}
    <p className="storage-explanation"><Info size={15} aria-hidden="true"/>Boyutlar uygulamaların bilinen klasörlerine aittir. Ortak veya iç içe klasörler aynı dosyaları içerebilir; uygulama boyutları birbirine eklenmemelidir. Başka dizinlerdeki veri dosyaları bu ölçüme dahil olmayabilir. “—” ölçüm alınamadığını belirtir.</p>
  </>;
}

export default function StoragePanel({ visible }: { visible: boolean }) {
  const { id } = useTarget();
  const { data, error, fetching, reload } = useStorageRead<Overview>('/storage', visible, true);
  const [tab, setTab] = useState<Tab>('volumes');
  const [path, setPath] = useState('/');
  const summary = data?.summary || undefined;
  const volumes = data?.volumes || [];
  const highUsage = volumes.filter(volume => volumePressure(volume) !== 'normal');
  const inspect = (next: string) => { setPath(next); setTab('folders'); };
  return <section className="storage-panel" aria-label="Depolama">
    <header className="storage-heading"><span className="storage-heading-icon" aria-hidden="true"><HardDrive size={25}/></span><div><h2>Depolama</h2><p>{data?.hostname || id} · Diskler, klasörler ve uygulamalar</p></div><Button variant="outline" onClick={reload} disabled={fetching} aria-label="Depolama ölçümünü yenile"><RefreshCw size={15} className={fetching ? 'spin' : ''}/>Yenile</Button></header>
    {error && <div className="storage-notice error" role="alert"><AlertCircle size={17} aria-hidden="true"/><p>{error}{data?.sampledAt ? ' Son başarılı ölçüm gösteriliyor.' : ''}</p></div>}
    {data && !data.available && data.volumes.length > 0 && <div className="storage-notice" aria-live="polite"><Info size={17} aria-hidden="true"/><p>{data.reason || 'Bazı disk bölümleri ölçülemedi. Bilinen bölümler gösteriliyor; sunucu toplamı hesaplanamadı.'}</p></div>}
    {data && !data.available && !data.volumes.length ? <EmptyState title="Depolama bilgisi alınamıyor" detail={data.reason || 'Bu sunucu disk ölçümlerini sağlayamıyor.'}/> : <>
      <div className="storage-summary">
        <article><span><HardDrive size={16} aria-hidden="true"/>Toplam kapasite</span><strong>{storageBytes(summary?.totalBytes)}</strong><small>{summary ? `${summary.volumeCount} disk bölümü · Sunucu toplamı` : 'Ölçüm bekleniyor'}</small></article>
        <article><span><Database size={16} aria-hidden="true"/>Kullanılan</span><strong>{storageBytes(summary?.usedBytes)}</strong><small>{summary ? `${storagePercent(summary.percent)} doluluk` : 'Ölçüm bekleniyor'}</small></article>
        <article><span><FolderOpen size={16} aria-hidden="true"/>Kullanılabilir</span><strong>{storageBytes(summary?.availableBytes)}</strong><small>Uygulamaların yazabileceği alan</small></article>
        <article><span><HardDrive size={16} aria-hidden="true"/>Sisteme ayrılan</span><strong>{storageBytes(summary?.reservedBytes)}</strong><small>{summary ? `${storageBytes(summary.freeBytes)} toplam boş alan içinde` : 'Ayrılmış boş alan'}</small></article>
      </div>
      {!!highUsage.length && <div className={`storage-notice ${highUsage.some(volume => volumePressure(volume) === 'critical') ? 'error' : ''}`}><AlertCircle size={17} aria-hidden="true"/><p><strong>Kullanılabilir alan az:</strong> {highUsage.map(volume => `${volume.mount} (${storageBytes(volume.availableBytes)} kullanılabilir)`).join(' · ')}. Sunucu toplamındaki boş alan bu bölümlerin doluluğunu azaltmaz.</p></div>}
      <nav className="storage-tabs" aria-label="Depolama görünümleri">{([{ id: 'volumes', label: 'Disk bölümleri', Icon: HardDrive }, { id: 'folders', label: 'Klasörler', Icon: Folder }, { id: 'applications', label: 'Uygulamalar', Icon: Boxes }] as const).map(item => <Button key={item.id} variant="ghost" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}><item.Icon size={16}/>{item.label}</Button>)}</nav>
      {tab === 'volumes' && <div className="storage-volumes">{!data && !error ? <EmptyState busy title="Disk bölümleri ölçülüyor…"/> : volumes.length ? volumes.map(volume => <article className="storage-volume" key={volume.id}><header><span className="storage-entry-icon" aria-hidden="true"><HardDrive size={21}/></span><div><h3>{volume.mount}</h3><p><code>{volume.source}</code><span>{volume.filesystem}</span></p></div><strong className={volumePressure(volume) === 'critical' ? 'storage-critical-text' : volumePressure(volume) === 'warning' ? 'storage-warning-text' : ''}>{storagePercent(volume.percent)}</strong></header><CapacityBar value={volume.percent} label={volume.mount} pressure={volumePressure(volume)}/>{volume.reason && <p className="storage-entry-reason">{volume.reason}</p>}<dl><div><dt>Kullanılan / kapasite</dt><dd>{storageBytes(volume.usedBytes)} <span>/ {storageBytes(volume.totalBytes)}</span></dd></div><div><dt>Kullanılabilir</dt><dd>{storageBytes(volume.availableBytes)}</dd></div><div><dt>Sisteme ayrılan</dt><dd>{storageBytes(volume.reservedBytes)}</dd></div></dl><footer><span>{volumePressure(volume) === 'critical' ? 'Kullanılabilir alan kritik' : volumePressure(volume) === 'warning' ? 'Kullanılabilir alan az' : volume.percent == null ? 'Ölçüm alınamadı' : 'Bağlı disk bölümü'}</span><Button variant="ghost" onClick={() => inspect(volume.mount)} aria-label={`${volume.mount} klasörlerini incele`}>Klasörleri incele<ArrowRight size={14}/></Button></footer></article>) : <EmptyState title={error ? 'Disk ölçümü alınamadı' : 'Bağlı disk bölümü bulunamadı'} detail={error ? 'Yenile ile tekrar deneyebilirsiniz.' : undefined}/>}</div>}
      {tab === 'folders' && <FolderDetails key={`${id}:${path}`} path={path} visible={visible} onPath={setPath}/>}
      {tab === 'applications' && <ApplicationDetails key={id} visible={visible} onPath={inspect}/>}
      <footer className="storage-footer"><span><Clock3 size={13} aria-hidden="true"/>Disk ölçümü · {sampledTime(data?.sampledAt)}</span><span>1 GiB = 1024 MiB · 1 TiB = 1024 GiB</span></footer>
      {tab === 'volumes' && <p className="storage-explanation"><Info size={15} aria-hidden="true"/>Sunucu toplamı bağlı kalıcı disk bölümlerini kapsar. Kullanılabilir alan, sisteme ayrılan boş alanı içermez; toplam boş alan bu ikisinin toplamıdır. Klasörleri inceleyerek bölümün içinde hangi dosyaların yer kapladığını görebilirsiniz.</p>}
    </>}
  </section>;
}
