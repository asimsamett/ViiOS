'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowRight, Bot, Box, Check, ChevronDown, Clock3, Cpu, Database, FileCheck2, FolderOpen, HardDrive, Layers3, Network, RefreshCw, Search, Server, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTarget } from './target-context';
import ModelBenchmark from './model-benchmark';

type ModelStatus = 'running' | 'available' | 'installed' | 'configured' | 'unreachable';
type CatalogModel = {
  id: string; name: string; family: string; kind: string; host: string; runtime: string; status: ModelStatus;
  parameterSize: string | null; quantization: string | null; contextLength: number | null; sizeBytes: number | null;
  endpoint: string | null; paths: string[]; applications: { name: string; port?: number }[];
  evidence: { kind: string; source: string; detail: string }[]; checkedAt: string;
};
type CatalogHost = {
  id: string; name: string; host: string; status: string;
  gpus: { name: string; memoryTotalMiB: number | null; memoryUsedMiB: number | null; utilizationPercent: number | null }[];
  error?: string | null;
};
type Catalog = {
  scanning: boolean; stale?: boolean; scannedAt: string | null; lastAttemptAt: string | null; error: string | null;
  warnings: string[]; models: CatalogModel[]; hosts: CatalogHost[];
  coverage: { hostsChecked: number; endpointsChecked: number; filesChecked: number; notes: string[] };
};
type ConcurrencyService = {
  id: string; endpoint: string; host: string; runtime: string;
  status: 'ok' | 'partial' | 'unavailable' | 'unsupported'; checkedAt: string | null; stale?: boolean;
  running: number | null; waiting: number | null; configuredParallelism: number | null; configuredQueueLimit: number | null;
  configuredParallelismScope?: 'service' | 'per-model';
  scope: 'service' | 'model'; modelName: string | null;
  sources: { kind: 'metrics' | 'configuration'; source: string; detail: string }[];
  note: string | null; capacity: { status: 'not_tested' };
};
type ConcurrencySnapshot = {
  checkedAt: string | null; refreshing: boolean; stale: boolean; error: string | null; services: ConcurrencyService[];
};

const statusInfo: Record<ModelStatus, { label: string; explanation: string }> = {
  running: { label: 'Bellekte doğrulandı', explanation: 'Çalışma ortamının yüklü model listesinde görüldü. CPU/GPU dağılımı ayrıca doğrulanmalıdır.' },
  available: { label: 'Kullanılabilir', explanation: 'Model çalışma ortamının kataloğunda mevcut; belleğe yüklü olduğu doğrulanmadı.' },
  installed: { label: 'Diskte bulundu', explanation: 'Model dosyaları bulundu; çalışan bir servise bağlı olduğu doğrulanmadı.' },
  configured: { label: 'Yapılandırma kaydı', explanation: 'Model veya uygulama ayarlarında adı geçiyor; model dosyalarının tamamı ve çalışma durumu doğrulanmadı.' },
  unreachable: { label: 'Erişilemiyor', explanation: 'Tanımlı model adresine erişilemedi; güncel çalışma durumu doğrulanamadı.' },
};
const statusOrder: ModelStatus[] = ['running', 'available', 'installed', 'configured', 'unreachable'];
const normalize = (value: string) => value.toLocaleLowerCase('tr-TR');
const dateTime = (value: string | null | undefined) => {
  if (!value || Number.isNaN(Date.parse(value))) return 'Henüz taranmadı';
  return new Date(value).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const bytes = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'Belirlenemedi';
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** index).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
};
const gpuMemory = (value: number | null) => value == null ? '—' : `${(value / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} GB`;
const number = (value: number | null | undefined) => value == null ? 'Belirlenemedi' : value.toLocaleString('tr-TR');
const kindNames: Record<string, string> = { extraction: 'Bilgi çıkarımı', other: 'Diğer model bileşeni', llm: 'Dil modeli', language: 'Dil modeli', embedding: 'Embedding', encoder: 'Metin kodlayıcı', reranker: 'Yeniden sıralama', vision: 'Görüntü modeli', multimodal: 'Çok modlu', speech: 'Ses modeli', 'speech-recognition': 'Konuşma tanıma', asr: 'Konuşma tanıma', 'speech-synthesis': 'Ses üretimi', tts: 'Ses üretimi', unknown: 'Türü belirlenemedi' };
const evidenceNames: Record<string, string> = { 'last-seen': 'Önceki doğrulama', api: 'Model API', process: 'Çalışan süreç', config: 'Uygulama ayarı', configuration: 'Uygulama ayarı', file: 'Dosya', disk: 'Disk', filesystem: 'Dosya sistemi', runtime: 'Çalışma ortamı', gpu: 'GPU' };
const kindLabel = (kind: string) => kindNames[kind] || kind || 'Türü belirlenemedi';
const evidenceLabel = (kind: string) => evidenceNames[kind] || kind || 'Kaynak';

function StatusBadge({ status }: { status: ModelStatus }) {
  const info = statusInfo[status] || statusInfo.configured;
  return <span className={`mc-status mc-status-${status}`} title={info.explanation}><i aria-hidden="true"/>{info.label}</span>;
}

function HostCard({ host, modelCount }: { host: CatalogHost; modelCount: number }) {
  const unavailable = !!host.error || ['unreachable', 'error', 'offline'].includes(host.status);
  return <article className={`mc-host ${unavailable ? 'mc-host-unavailable' : ''}`}>
    <div className="mc-host-heading"><span className="mc-host-icon"><Server size={20}/></span><div><h3>{host.name || host.host}</h3><code>{host.host}</code></div><span className="mc-host-models">{modelCount} model</span></div>
    {host.gpus.length > 0 ? <div className="mc-gpus">{host.gpus.map((gpu, index) => {
      const usedPercent = gpu.memoryTotalMiB && gpu.memoryUsedMiB != null ? Math.min(100, Math.max(0, gpu.memoryUsedMiB / gpu.memoryTotalMiB * 100)) : null;
      return <div className="mc-gpu" key={`${gpu.name}-${index}`}>
        <div className="mc-gpu-title"><Cpu size={15}/><strong>{gpu.name}</strong>{host.gpus.length > 1 && <span>GPU {index + 1}</span>}</div>
        <div className="mc-gpu-memory"><span>GPU belleği</span><strong>{gpuMemory(gpu.memoryUsedMiB)} <small>/ {gpuMemory(gpu.memoryTotalMiB)}</small></strong></div>
        {usedPercent != null && <meter className="mc-meter" aria-label={`${gpu.name} bellek kullanımı`} value={Math.round(usedPercent)} min={0} max={100}>{Math.round(usedPercent)}%</meter>}
        <span className="mc-gpu-utilization">İşlem kullanımı: {gpu.utilizationPercent == null ? 'ölçülemedi' : `%${gpu.utilizationPercent}`}</span>
      </div>;
    })}</div> : <p className="mc-host-note"><Cpu size={15}/>{unavailable ? 'GPU bilgisi alınamadı.' : 'Bu taramada GPU bilgisi bulunamadı.'}</p>}
    {host.error && <p className="mc-host-error"><AlertCircle size={14}/>{host.error}</p>}
  </article>;
}

const concurrencyStatus = { ok: 'Metrikler alındı', partial: 'Kısmi ölçüm', unavailable: 'Ölçüm alınamadı', unsupported: 'Metrik sunulmuyor' };
const concurrencyNumber = (value: number | null) => value == null || !Number.isFinite(value) ? null : value.toLocaleString('tr-TR');
const measurementTime = (value: string | null) => !value || Number.isNaN(Date.parse(value)) ? 'Henüz ölçülmedi' : new Date(value).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const oldMeasurement = (value: string | null, now: number) => !!value && (!Number.isFinite(Date.parse(value)) || now - Date.parse(value) >= 30_000);
const endpointOrigin = (value: string | null) => {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
};

function ConcurrencySection({ models }: { models: CatalogModel[] }) {
  const { api } = useTarget();
  const [snapshot, setSnapshot] = useState<ConcurrencySnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [paused, setPaused] = useState(false);
  const [clock, setClock] = useState(0);
  const mounted = useRef(false), request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (document.hidden || request.current) return;
    setClock(Date.now());
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setBusy(true);
    try {
      const result = await api<ConcurrencySnapshot>('/models/concurrency', { signal: controller.signal });
      if (mounted.current && request.current === controller) { setSnapshot(result); setError(''); }
    } catch (reason) {
      if (mounted.current && request.current === controller) setError(controller.signal.aborted ? 'Canlı kullanım bilgisi zamanında alınamadı.' : reason instanceof Error ? reason.message : 'Canlı kullanım bilgisi alınamadı.');
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) { request.current = null; if (mounted.current) setBusy(false); }
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    const visibility = () => {
      setPaused(document.hidden);
      if (document.hidden) {
        const pending = request.current;
        request.current = null;
        pending?.abort();
        setBusy(false);
      } else void load();
    };
    const initial = window.setTimeout(visibility, 0);
    const interval = window.setInterval(() => void load(), 15_000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (!snapshot?.refreshing || busy || paused) return;
    const timer = window.setTimeout(() => void load(), 1_000);
    return () => window.clearTimeout(timer);
  }, [snapshot, busy, paused, load]);
  const stale = !!error || !!snapshot?.error || !!snapshot?.stale || paused || oldMeasurement(snapshot?.checkedAt || null, clock);
  const services = [...(snapshot?.services || [])].sort((a, b) => {
    const priority = (service: ConcurrencyService) => service.running != null || service.waiting != null ? 0 : service.configuredParallelism != null || service.configuredQueueLimit != null ? 1 : service.status === 'unavailable' ? 3 : 2;
    return priority(a) - priority(b) || a.endpoint.localeCompare(b.endpoint);
  });
  return <section className="mc-concurrency-section" id="model-concurrency" aria-label="Eşzamanlı kullanım">
    <div className="mc-section-heading"><div><h2><Activity size={19}/>Eşzamanlı kullanım</h2><p>Servisin işlediği ve sırada bekleyen istekler ile yapılandırılmış sınırlar.</p></div><Button variant="outline" className="mc-live-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? 'Alınıyor…' : 'Kullanımı yenile'}</Button></div>
    <div className="mc-concurrency-meta" aria-live="polite"><span><span className={`mc-pulse ${paused || stale ? 'mc-pulse-paused' : ''}`}/>{paused ? 'Sekme gizliyken takip duraklatılır' : '15 saniyede bir güncellenir'}</span><span><Clock3 size={13}/>{measurementTime(snapshot?.checkedAt || null)}</span>{snapshot?.refreshing && <span className="mc-live-updating">Yeni ölçüm alınıyor</span>}{stale && snapshot?.checkedAt && <span className="mc-stale">Son ölçüm gösteriliyor</span>}</div>
    {(error || snapshot?.error) && <div className="mc-concurrency-error" role="alert"><AlertCircle size={15}/><span>{error || snapshot?.error}{snapshot?.checkedAt ? ' Önceki ölçüm korunuyor.' : ''}</span></div>}
    {services.length ? <div className="mc-concurrency-grid">{services.map(service => {
      const measurementStale = stale || service.stale || oldMeasurement(service.checkedAt, clock);
      const origin = endpointOrigin(service.endpoint);
      const related = [...new Map(models.filter(model => origin && endpointOrigin(model.endpoint) === origin).map(model => [normalize(model.name), { name: model.name, family: model.family }])).values()];
      if (service.modelName && !related.some(model => normalize(model.name) === normalize(service.modelName!))) related.push({ name: service.modelName, family: '' });
      const modelLabel = (model: { name: string; family: string }) => model.family && !normalize(model.name).includes(normalize(model.family)) ? `${model.family} · ${model.name}` : model.name;
      return <article key={service.id} className={`mc-concurrency-card mc-concurrency-${service.status}`}>
      <header><span className="mc-concurrency-icon"><Network size={19}/></span><div><h3>{service.runtime || 'Model servisi'}{service.scope === 'model' && service.modelName ? ` · ${service.modelName}` : ''}</h3><code>{service.endpoint}</code></div><span className={`mc-concurrency-status mc-concurrency-status-${measurementStale ? 'stale' : service.status}`} title="Bu durum modelin çalışmasını değil, kullanım ölçümlerine erişimi belirtir.">{measurementStale ? 'Önceki ölçüm' : concurrencyStatus[service.status]}</span></header>
      <div className="mc-concurrency-scope"><Server size={12}/><span>{service.host}</span><span>{service.scope === 'model' ? 'Model kapsamı' : 'Servis kapsamı'}</span>{measurementStale && <span className="mc-stale">Ölçüm güncel değil</span>}</div>
      {related.length > 0 && <div className="mc-concurrency-models"><Bot size={14}/><div><span>Bağlı modeller</span><p>{related.slice(0, 2).map(modelLabel).join(' · ')}</p>{related.length > 2 && <details><summary>Diğer {related.length - 2} modeli göster<ChevronDown size={12}/></summary><ul>{related.slice(2).map(model => <li key={model.name}>{modelLabel(model)}</li>)}</ul></details>}</div></div>}
      <div className="mc-concurrency-values"><div className="mc-observed-count"><span><Activity size={13}/>İşlenen istek</span><strong className={concurrencyNumber(service.running) == null ? 'mc-value-unknown' : ''}>{concurrencyNumber(service.running) ?? 'Ölçülemedi'}</strong><small>Son ölçüm</small></div><div className="mc-observed-count"><span><Clock3 size={13}/>Bekleyen istek</span><strong className={concurrencyNumber(service.waiting) == null ? 'mc-value-unknown' : ''}>{concurrencyNumber(service.waiting) ?? 'Ölçülemedi'}</strong><small>Son ölçüm</small></div><div><span>{service.configuredParallelismScope === 'per-model' ? 'Model başına paralellik' : 'Paralellik ayarı'}</span><strong className={concurrencyNumber(service.configuredParallelism) == null ? 'mc-value-unknown' : ''}>{concurrencyNumber(service.configuredParallelism) ?? 'Belirlenemedi'}</strong><small>Yapılandırma değeri</small></div><div><span>Kuyruk sınırı</span><strong className={concurrencyNumber(service.configuredQueueLimit) == null ? 'mc-value-unknown' : ''}>{concurrencyNumber(service.configuredQueueLimit) ?? 'Belirlenemedi'}</strong><small>Yapılandırma değeri</small></div></div>
      <div className="mc-capacity-note"><ShieldCheck size={14}/><span>Test edilmiş kapasite: <strong>Henüz test edilmedi</strong></span></div>
      {service.note && <p className="mc-concurrency-note">{service.note}</p>}
      <details className="mc-concurrency-evidence"><summary><span><FileCheck2 size={13}/>Ölçüm kaynakları <small>{service.sources.length}</small></span><ChevronDown size={14}/></summary><div><p className="mc-measurement-time"><Clock3 size={12}/>{measurementTime(service.checkedAt)}</p>{service.sources.length ? <ul>{service.sources.map((source, index) => <li key={`${source.kind}-${index}`}><strong>{source.kind === 'metrics' ? 'Servis metriği' : 'Servis yapılandırması'}</strong><p>{source.detail}</p><code>{source.source}</code></li>)}</ul> : <p className="mc-muted">Bu servis için ölçüm veya yapılandırma kaynağı doğrulanamadı.</p>}</div></details>
    </article>; })}</div> : <div className="mc-concurrency-empty"><Activity size={22}/><div><strong>{error || snapshot?.error ? 'Kullanım bilgisi alınamadı' : !snapshot || snapshot.refreshing ? 'Servis kullanım bilgisi alınıyor' : 'Ölçülebilir model servisi bulunamadı'}</strong><p>{error || snapshot?.error ? 'Bir sonraki kontrolde yeniden denenecek.' : 'Model adresleri ve desteklenen servis metrikleri burada gösterilir.'}</p></div></div>}
    <p className="mc-concurrency-explanation"><ShieldCheck size={14}/><span>İstek sayıları servis kapsamındadır; aynı servisi paylaşan modeller için tekrar toplanmaz. Yapılandırma sınırları, test edilmiş kullanıcı kapasitesi değildir.</span></p>
  </section>;
}

function ModelCard({ model }: { model: CatalogModel }) {
  const [expanded, setExpanded] = useState(false);
  const info = statusInfo[model.status] || statusInfo.configured;
  return <article className={`mc-model mc-model-${model.status}`}>
    <div className="mc-model-topline"><span className="mc-model-family"><Layers3 size={13}/>{model.family || 'Diğer'}</span><StatusBadge status={model.status}/></div>
    <div className="mc-model-title"><span className="mc-model-icon"><Bot size={25}/></span><div><h3>{model.name}</h3><p>{kindLabel(model.kind)}<span aria-hidden="true"> · </span>{model.runtime || 'Çalışma ortamı belirsiz'}</p></div></div>
    <div className="mc-model-location"><Server size={14}/><span>{model.host}</span></div>
    <dl className="mc-model-specs"><div><dt>Parametre</dt><dd>{model.parameterSize || 'Belirlenemedi'}</dd></div><div><dt>Kuantizasyon</dt><dd>{model.quantization || 'Belirlenemedi'}</dd></div><div><dt>Dosya boyutu</dt><dd>{bytes(model.sizeBytes)}</dd></div></dl>
    <div className="mc-model-apps"><Network size={14}/>{model.applications.length ? <span>{model.applications.map(app => app.name).join(' · ')}</span> : <span className="mc-muted">Uygulama bağlantısı bulunamadı</span>}</div>
    <div className="mc-model-bottom"><span><FileCheck2 size={14}/>{model.evidence.length} kaynak</span><button className="mc-details-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Ayrıntıları kapat' : 'Ayrıntılar'}<ChevronDown size={16} className={expanded ? 'mc-rotated' : ''}/></button></div>
    {expanded && <div className="mc-model-details">
      <p className={`mc-state-explanation mc-state-${model.status}`}><ShieldCheck size={16}/>{info.explanation}</p>
      <dl className="mc-detail-fields"><div><dt>Bağlam uzunluğu</dt><dd>{model.contextLength == null ? 'Belirlenemedi' : `${number(model.contextLength)} token`}</dd></div><div><dt>Kontrol zamanı</dt><dd>{dateTime(model.checkedAt)}</dd></div></dl>
      {model.endpoint && <div className="mc-detail-block"><h4><Network size={14}/>Model adresi</h4><code className="mc-code">{model.endpoint}</code><a className="mc-concurrency-link" href="#model-concurrency">Servis kullanımını incele<ArrowRight size={12}/></a></div>}
      {model.paths.length > 0 && <div className="mc-detail-block"><h4><FolderOpen size={14}/>Model dosyaları</h4>{model.paths.map(path => <code className="mc-code" key={path}>{path}</code>)}</div>}
      {model.applications.length > 0 && <div className="mc-detail-block"><h4><Box size={14}/>Bağlı uygulamalar</h4><ul className="mc-application-list">{model.applications.map((app, index) => <li key={`${app.name}-${app.port || index}`}><span>{app.name}</span>{app.port != null && <code>:{app.port}</code>}</li>)}</ul></div>}
      <div className="mc-detail-block"><h4><FileCheck2 size={14}/>Tespit kaynakları</h4>{model.evidence.length ? <ul className="mc-evidence">{model.evidence.map((item, index) => <li key={`${item.kind}-${index}`}><span>{evidenceLabel(item.kind)}</span><p>{item.detail}</p><code>{item.source}</code></li>)}</ul> : <p className="mc-muted">Bu kayıt için ayrıntılı kaynak bilgisi yok.</p>}</div>
    </div>}
  </article>;
}

function ModelInventory() {
  const { api } = useTarget();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(true);
  const [pollLimitReached, setPollLimitReached] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ModelStatus | 'all'>('all');
  const [family, setFamily] = useState('all');
  const mounted = useRef(false), request = useRef<AbortController | null>(null), pollCount = useRef(0);

  const load = useCallback(async (refresh = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    setRequestBusy(true);
    if (refresh) { pollCount.current = 0; setPolling(true); setPollLimitReached(false); }
    try {
      const result = await api<Catalog>(refresh ? '/models/refresh' : '/models', { method: refresh ? 'POST' : 'GET', signal: controller.signal });
      if (mounted.current && request.current === controller) { setCatalog(result); setError(''); }
    } catch (reason) {
      if (mounted.current && request.current === controller) {
        setError(controller.signal.aborted ? 'Model envanteri yanıtı zamanında alınamadı. Yeniden deneyebilirsiniz.' : reason instanceof Error ? reason.message : 'Model envanteri alınamadı.');
        setPolling(false);
      }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && request.current === controller) setRequestBusy(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void load(), 0);
    return () => { mounted.current = false; window.clearTimeout(initial); request.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (!catalog?.scanning || requestBusy || !polling) return;
    const timer = window.setTimeout(() => {
      if (pollCount.current >= 120) { setPolling(false); setPollLimitReached(true); return; }
      pollCount.current += 1;
      void load();
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [catalog, requestBusy, polling, load]);

  const counts = useMemo(() => {
    const result = { running: 0, available: 0, installed: 0, configured: 0, unreachable: 0 };
    for (const model of catalog?.models || []) if (model.status in result) result[model.status] += 1;
    return result;
  }, [catalog]);
  const families = useMemo(() => [...new Set((catalog?.models || []).map(model => model.family || 'Diğer'))].sort((a, b) => a.localeCompare(b, 'tr')), [catalog]);
  const visible = useMemo(() => {
    const term = normalize(query.trim());
    return (catalog?.models || []).filter(model => (status === 'all' || status === model.status) && (family === 'all' || family === (model.family || 'Diğer')) && normalize([model.name, model.family, model.runtime, model.host, model.kind, model.endpoint, ...model.paths, ...model.applications.map(app => app.name)].join(' ')).includes(term)).sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || a.name.localeCompare(b.name, 'tr'));
  }, [catalog, query, family, status]);
  const scanning = !!catalog?.scanning && polling && !error;
  const hasFilters = !!query || status !== 'all' || family !== 'all';
  const resetFilters = () => { setQuery(''); setStatus('all'); setFamily('all'); };
  const warningItems = [...new Set([...(catalog?.warnings || []), ...(catalog?.coverage.notes || [])])];

  return <section className="model-catalog" aria-label="Model Merkezi">
    <header className="mc-heading"><div className="mc-heading-copy"><span className="mc-heading-icon"><Bot size={29}/></span><div><span className="mc-eyebrow">YAPAY ZEKA ENVANTERİ</span><h1>Model Merkezi</h1><p>Sunuculardaki modeller, GPU kaynakları ve uygulama bağlantıları.</p></div></div><div className="mc-heading-actions"><span className="mc-readonly"><ShieldCheck size={14}/>Salt okunur keşif</span><Button className="mc-refresh" disabled={requestBusy || scanning} onClick={() => void load(true)}><RefreshCw size={16} className={scanning || requestBusy ? 'spin' : ''}/>{scanning ? 'Taranıyor…' : requestBusy ? 'Yükleniyor…' : catalog?.scannedAt ? 'Envanteri yenile' : 'Modelleri tara'}</Button></div></header>

    <div className="mc-scan-line" aria-live="polite"><span><Clock3 size={14}/>{catalog?.scannedAt ? <>Son tarama: <strong>{dateTime(catalog.scannedAt)}</strong></> : 'Henüz tamamlanan tarama yok'}</span>{catalog?.scannedAt && <span><Server size={14}/>{catalog.coverage.hostsChecked} sunucu kontrol edildi</span>}{scanning && <span className="mc-scanning"><span className="mc-pulse"/>Model servisleri ve dosyaları kontrol ediliyor</span>}{(error || catalog?.error || catalog?.stale) && catalog?.scannedAt && <span className="mc-stale" title="Bilgiler son tarama zamanına aittir; güncel durum için envanteri yenileyin.">Son kayıt · Yenileme gerekli</span>}</div>

    {(error || catalog?.error) && <div className="mc-notice mc-notice-error" role="alert"><AlertCircle size={19}/><div><strong>Envanter tam olarak yenilenemedi</strong><p>{error || catalog?.error}</p>{catalog?.scannedAt && <p>Önceki tarama bilgileri korunuyor. Durumlar son kontrol zamanına aittir.</p>}</div><Button variant="outline" disabled={requestBusy} onClick={() => void load(true)}>Tekrar dene</Button></div>}
    {pollLimitReached && <div className="mc-notice" aria-live="polite"><Clock3 size={19}/><div><strong>Otomatik durum takibi duraklatıldı</strong><p>Tarama sunucuda sürüyor olabilir. Güncel durumu almak için envanteri yenileyin.</p></div></div>}

    {!catalog && !error ? <div className="mc-initial" aria-live="polite"><RefreshCw size={28} className="spin"/><h2>Model envanteri yükleniyor</h2><p>Kayıtlı model ve sunucu bilgileri alınıyor.</p></div> : <>
      <div className="mc-stats" aria-label="Model sayıları"><button className={`mc-stat mc-stat-total ${status === 'all' ? 'mc-stat-selected' : ''}`} aria-pressed={status === 'all'} onClick={() => setStatus('all')}><span><Layers3 size={17}/>Tüm modeller</span><strong>{catalog?.models.length || 0}</strong><small>Bulunan model kayıtları</small></button>{statusOrder.map(key => <button key={key} className={`mc-stat mc-stat-${key} ${status === key ? 'mc-stat-selected' : ''}`} aria-pressed={status === key} onClick={() => setStatus(key)} title={statusInfo[key].explanation}><span>{key === 'running' ? <Activity size={17}/> : key === 'available' ? <Check size={17}/> : key === 'installed' ? <HardDrive size={17}/> : key === 'configured' ? <FileCheck2 size={17}/> : <AlertCircle size={17}/>} {statusInfo[key].label}</span><strong>{counts[key]}</strong><small>{key === 'running' ? 'Yüklü model listesinde' : key === 'available' ? 'Çalışma ortamında kayıtlı' : key === 'installed' ? 'Dosyası tespit edildi' : key === 'configured' ? 'Model veya uygulama ayarı' : 'Durumu doğrulanamadı'}</small></button>)}</div>

      {!!catalog?.hosts.length && <section className="mc-host-section" aria-label="Sunucular ve GPU kaynakları"><div className="mc-section-heading"><div><h2><Cpu size={19}/>Sunucular ve GPU kaynakları</h2><p>Bellek ve kullanım değerleri tarama anındaki durumu gösterir.</p></div><span>{catalog.hosts.length} sunucu</span></div><div className="mc-host-grid">{catalog.hosts.map(host => <HostCard key={host.id} host={host} modelCount={catalog.models.filter(model => model.host === host.host || model.host === host.name || model.host === host.id).length}/>)}</div></section>}

      <ConcurrencySection models={catalog?.models || []}/>

      <section className="mc-model-section" aria-label="Modeller"><div className="mc-section-heading"><div><h2><Bot size={19}/>Model kataloğu <span className="mc-result-count">{visible.length}</span></h2><p>Bir modelin ayrıntılarından adresini, dosyalarını ve tespit kaynaklarını inceleyin.</p></div></div>
        <div className="mc-toolbar"><div className="mc-search"><Search size={17}/><Input aria-label="Model, sunucu veya uygulama ara" placeholder="Model, sunucu veya uygulama ara…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button onClick={() => setQuery('')} aria-label="Model aramasını temizle"><X size={15}/></button>}</div><div className="mc-filters"><label><span>Model ailesi</span><select value={family} onChange={event => setFamily(event.target.value)}><option value="all">Tüm aileler</option>{families.map(item => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Durum</span><select value={status} onChange={event => setStatus(event.target.value as ModelStatus | 'all')}><option value="all">Tüm durumlar</option>{statusOrder.map(key => <option key={key} value={key}>{statusInfo[key].label}</option>)}</select></label>{hasFilters && <Button className="mc-clear" variant="ghost" onClick={resetFilters}><X size={14}/>Temizle</Button>}</div></div>
        {visible.length > 0 ? <div className="mc-model-grid">{visible.map(model => <ModelCard key={model.id} model={model}/>)}</div> : <div className="mc-empty"><span>{hasFilters ? <Search size={27}/> : <Bot size={29}/>}</span><h3>{hasFilters ? 'Bu filtrelerle model bulunamadı' : scanning ? 'Modeller araştırılıyor' : catalog?.scannedAt ? 'Taranan kaynaklarda model bulunamadı' : 'Sunuculardaki modelleri keşfedin'}</h3><p>{hasFilters ? 'Aramayı değiştirin veya filtreleri temizleyerek tüm modelleri görüntüleyin.' : scanning ? 'Tarama tamamlandığında model kayıtları burada görünecek.' : catalog?.scannedAt ? 'Kontrol edilen kaynakları ve varsa erişim eksiklerini tarama kapsamından inceleyebilirsiniz.' : 'Model servisleri, kayıtlı model dosyaları ve uygulama bağlantıları bu ekranda bir araya gelir.'}</p>{hasFilters ? <Button variant="outline" onClick={resetFilters}>Filtreleri temizle</Button> : !scanning && !requestBusy && <Button variant="outline" onClick={() => void load(true)}>{catalog?.scannedAt ? 'Yeniden tara' : 'İlk taramayı başlat'}<ArrowRight size={15}/></Button>}</div>}
      </section>

      <details className="mc-coverage"><summary><span><Database size={17}/><strong>Tarama kapsamı ve kaynaklar</strong>{warningItems.length > 0 && <span className="mc-coverage-count">{warningItems.length} not</span>}</span><ChevronDown size={17}/></summary><div className="mc-coverage-body"><div className="mc-coverage-numbers"><span><strong>{number(catalog?.coverage.hostsChecked || 0)}</strong> sunucu</span><span><strong>{number(catalog?.coverage.endpointsChecked || 0)}</strong> model adresi</span><span><strong>{number(catalog?.coverage.filesChecked || 0)}</strong> dosya / ayar kaynağı</span></div><p>Bu envanter, tarayıcının erişebildiği sunucu ve kaynakları kapsar. Bir model adının ayarlarda veya diskte bulunması, o modelin GPU üzerinde çalıştığı anlamına gelmez.</p>{warningItems.length > 0 && <ul>{warningItems.map((note, index) => <li key={index}>{note}</li>)}</ul>}<p className="mc-coverage-safety"><ShieldCheck size={14}/>Tarama model çalıştırmaz; model yüklemez, indirmez veya servisleri değiştirmez.</p></div></details>
    </>}
  </section>;
}

export default function ModelCatalog() {
  const [section, setSection] = useState<'benchmark' | 'inventory'>('benchmark');
  return <div className="mc-center">
    <nav className="mc-center-nav" aria-label="Model Merkezi bölümleri">
      <button type="button" aria-pressed={section === 'benchmark'} onClick={() => setSection('benchmark')}><Activity size={17}/>Kapasite Testi</button>
      <button type="button" aria-pressed={section === 'inventory'} onClick={() => setSection('inventory')}><Bot size={17}/>Envanter ve canlı kullanım</button>
    </nav>
    {section === 'benchmark' ? <ModelBenchmark/> : <ModelInventory/>}
  </div>;
}
