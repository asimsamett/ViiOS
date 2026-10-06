'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowRight, BarChart3, Bot, Check, ChevronDown, Clock3, FileText, Gauge, History, Layers3, ListChecks, LoaderCircle, Play, RefreshCw, Square, Target, Timer, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTarget } from './target-context';

type Scenario = 'custom' | 'short' | 'long' | 'sql';
type RunState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
type ModelOption = { id: string; name: string; runtime: string; endpoint: string; status: string };
type ModelOptions = { scannedAt: string | null; models: ModelOption[]; canStart: boolean; unavailableReason: string | null };
type TestConfig = {
  modelId: string; prompt: string; scenario: Scenario; stages: number[]; requestsPerStage: number;
  maxOutputTokens: number; timeoutMs: number;
  thresholds: { maxP95LatencyMs: number; maxP95TtftMs: number | null; maxErrorRate: number };
};
type Stage = {
  concurrency: number; state: 'pending' | 'running' | 'completed' | 'cancelled';
  startedAt: string | null; finishedAt: string | null; startedRequests: number; completedRequests: number;
  inFlight: number; peakInFlight: number; totalRequests: number; errors: number; passed: boolean | null; failureReasons: string[];
  errorCounts?: Record<string, number>;
  metrics: {
    p50LatencyMs: number | null; p95LatencyMs: number | null; p95TtftMs: number | null; errorRate: number | null;
    requestsPerSecond: number | null; outputTokensPerSecond: number | null;
    usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
    successfulRequests: number; ttftSampleCount: number; usageSampleCount: number;
  };
};
type BenchmarkRun = {
  id: string; modelId: string; modelName: string; endpoint: string; runtime: string; state: RunState;
  startedAt: string; finishedAt: string | null; updatedAt: string; error: string | null;
  config: Omit<TestConfig, 'prompt'> & { promptChars: number; promptHash: string };
  stages: Stage[];
  report: { highestPassingConcurrency: number | null; conditional: true; stoppedReason: string | null; note: string } | null;
};
type RunList = { active: BenchmarkRun | null; history: BenchmarkRun[] };

const concurrencyChoices = [1, 2, 4, 8, 16, 32];
const runLabels: Record<RunState, string> = { running: 'Çalışıyor', cancelling: 'Durduruluyor', completed: 'Tamamlandı', cancelled: 'Durduruldu', failed: 'Başarısız' };
const modelStateLabels: Record<string, string> = { running: 'Önceki kayıtta bellekte', available: 'Önceki kayıtta erişilebilir', unreachable: 'Önceki kontrolde erişilemedi', configured: 'Yapılandırma kaydı', installed: 'Diskte bulundu' };
const stopReasons: Record<string, string> = { threshold_failed: 'Bir aşama ölçüm hedeflerini karşılamadığı için daha yüksek düzeylere geçilmedi.', all_stages_completed: 'Planlanan aşamalar tamamlandı.', cancelled: 'Test kullanıcı isteğiyle durduruldu.', duration_limit: '30 dakikalık toplam süre sınırına ulaşıldı.', shutdown: 'Test hizmet kapanışı sırasında durduruldu.', engine_error: 'Test çalıştırılırken bir hata oluştu.', interrupted: 'Test kesintiye uğradı; kalan aşamalar çalıştırılmadı.' };
const requestErrorLabels: Record<string, string> = { stream_unavailable: 'Akış yanıtı desteklenmedi', provider_error: 'Model servisi hatası', invalid_stream: 'Geçersiz yanıt akışı', response_limit: 'Yanıt boyutu sınırı', aborted: 'İstek iptal edildi', incomplete_stream: 'Yanıt akışı tamamlanmadı', no_visible_output: 'Görünür yanıt üretilmedi', http_error: 'HTTP isteği başarısız', request_timeout: 'İstek zaman aşımı', connection_error: 'Bağlantı kurulamadı', request_error: 'İstek hatası' };
const requestErrorLabel = (code: string) => requestErrorLabels[code] || (/^http_[1-5]\d{2}$/.test(code) ? `HTTP ${code.slice(5)}` : 'İstek hatası');
const scenarioInfo: Record<Scenario, { title: string; description: string }> = {
  custom: { title: 'Serbest senaryo', description: 'Kendi iş yükünüzü temsil eden bir soru veya görev yazın.' },
  short: { title: 'Kısa yanıt', description: 'Kısa cevap bekleyen sorularla gecikmeyi karşılaştırın.' },
  long: { title: 'Uzun yanıt', description: 'Ayrıntılı üretim görevleriyle yanıt süresini ve token hızını inceleyin.' },
  sql: { title: 'SQL üretimi', description: 'Gerekli şema bilgisini prompta ekleyerek sorgu üretimini ölçün. Üretilen SQL çalıştırılmaz.' },
};
const active = (run: BenchmarkRun | null) => run?.state === 'running' || run?.state === 'cancelling';
const displayNumber = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('tr-TR', { maximumFractionDigits: digits });
const milliseconds = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'Ölçülemedi' : `${displayNumber(value / 1000, 2)} sn`;
const timestamp = (value: string | null | undefined) => !value || Number.isNaN(Date.parse(value)) ? '—' : new Date(value).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const message = (error: unknown) => error instanceof Error ? error.message : 'İşlem tamamlanamadı.';

function StageResult({ stage, finished }: { stage: Stage; finished: boolean }) {
  const label = stage.state === 'pending' ? finished ? 'Çalıştırılmadı' : 'Sırada' : stage.state === 'running' ? 'Ölçülüyor' : stage.state === 'cancelled' ? 'Durduruldu' : stage.passed === true ? 'Hedefleri karşıladı' : stage.passed === false ? 'Hedef dışı' : 'Tamamlandı';
  const measured = stage.completedRequests > 0;
  return <article className={`mb-stage-result mb-stage-${stage.state} ${stage.passed === false ? 'mb-stage-failed' : ''}`}>
    <div className="mb-stage-title"><span className="mb-stage-level">{stage.concurrency}<small>eşzamanlı</small></span><div><h4>{label}</h4><p>{stage.completedRequests} / {stage.totalRequests} istek tamamlandı{stage.state === 'running' ? ` · ${stage.inFlight} istek sürüyor` : ''}</p></div>{stage.passed === true ? <Check size={19}/> : stage.state === 'running' ? <LoaderCircle size={18} className="spin"/> : stage.passed === false ? <AlertCircle size={18}/> : null}</div>
    <dl className="mb-stage-metrics"><div><dt>P50 yanıt</dt><dd>{measured ? milliseconds(stage.metrics.p50LatencyMs) : '—'}</dd></div><div><dt>P95 yanıt</dt><dd>{measured ? milliseconds(stage.metrics.p95LatencyMs) : '—'}</dd></div><div><dt>P95 ilk token</dt><dd>{measured ? milliseconds(stage.metrics.p95TtftMs) : '—'}</dd></div><div><dt>Hata oranı</dt><dd>{measured && stage.metrics.errorRate != null ? `%${displayNumber(stage.metrics.errorRate * 100)}` : '—'}</dd></div><div><dt>İstek / saniye</dt><dd>{measured ? displayNumber(stage.metrics.requestsPerSecond, 2) : '—'}</dd></div><div><dt>Çıktı tokenı / sn</dt><dd>{measured ? displayNumber(stage.metrics.outputTokensPerSecond, 2) : '—'}</dd></div></dl>
    {stage.failureReasons.length > 0 && <ul className="mb-stage-failures">{stage.failureReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <details className="mb-stage-evidence"><summary>Ölçüm ayrıntıları<ChevronDown size={13}/></summary><dl><div><dt>Başarılı / hatalı istek</dt><dd>{stage.metrics.successfulRequests} / {stage.errors}</dd></div><div><dt>Gözlenen en yüksek eşzamanlılık</dt><dd>{displayNumber(stage.peakInFlight, 0)}</dd></div><div><dt>İlk token ölçümü bulunan istek</dt><dd>{stage.metrics.ttftSampleCount}</dd></div><div><dt>Token kullanımı bildiren istek</dt><dd>{stage.metrics.usageSampleCount}</dd></div><div><dt>Girdi / çıktı tokenı</dt><dd>{displayNumber(stage.metrics.usage.inputTokens, 0)} / {displayNumber(stage.metrics.usage.outputTokens, 0)}</dd></div><div><dt>Başlangıç / bitiş</dt><dd>{timestamp(stage.startedAt)} / {timestamp(stage.finishedAt)}</dd></div></dl>{stage.errorCounts && Object.keys(stage.errorCounts).length > 0 && <ul className="mb-request-errors">{Object.entries(stage.errorCounts).map(([code, count]) => <li key={code}><span>{requestErrorLabel(code)}</span><strong>{count}</strong></li>)}</ul>}</details>
  </article>;
}

export default function ModelBenchmark() {
  const { api } = useTarget();
  const fieldId = useId();
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [modelId, setModelId] = useState(''), [prompt, setPrompt] = useState('');
  const [scenario, setScenario] = useState<Scenario>('custom');
  const [method, setMethod] = useState<'staged' | 'fixed'>('staged');
  const [stages, setStages] = useState([1, 2, 4, 8]);
  const [fixedConcurrency, setFixedConcurrency] = useState('1');
  const [requests, setRequests] = useState('20'), [maxOutput, setMaxOutput] = useState('128'), [timeout, setTimeoutValue] = useState('30000');
  const [p95Target, setP95Target] = useState('10000'), [ttftTarget, setTtftTarget] = useState('3000'), [errorTarget, setErrorTarget] = useState('5');
  const [checkTtft, setCheckTtft] = useState(true);
  const [run, setRun] = useState<BenchmarkRun | null>(null), [history, setHistory] = useState<RunList | null>(null);
  const [activeRun, setActiveRun] = useState<BenchmarkRun | null>(null);
  const [busyAction, setBusyAction] = useState<'options' | 'start' | 'cancel' | 'history' | null>(null);
  const [error, setError] = useState(''), [pollError, setPollError] = useState('');
  const [watching, setWatching] = useState(false), [watchPaused, setWatchPaused] = useState(false), [pollBusy, setPollBusy] = useState(false);
  const mounted = useRef(false), actionRequest = useRef<AbortController | null>(null), pollRequest = useRef<AbortController | null>(null);
  const selectedModel = options?.models.find(model => model.id === modelId);
  const plannedStages = useMemo(() => method === 'fixed' ? [Number(fixedConcurrency)] : stages, [method, fixedConcurrency, stages]);
  const maxConcurrency = plannedStages.length ? Math.max(...plannedStages) : 0;
  const requestCount = Number(requests), outputCount = Number(maxOutput);
  const totalRequests = requestCount * plannedStages.length;
  const promptBytes = useMemo(() => new TextEncoder().encode(prompt).length, [prompt]);
  const minimumRequests = Math.max(10, 2 * maxConcurrency);
  const isRunning = active(run);
  const watchedRunId = run?.id;
  const anotherRunActive = !!activeRun && active(activeRun) && activeRun.id !== run?.id;
  const formLocked = !!busyAction || isRunning || anotherRunActive;

  const validation = useMemo(() => {
    if (!options) return 'Önce kayıtlı model listesini yükleyin.';
    if (!options.canStart) return options.unavailableReason || 'Bu ortamda kapasite testi başlatılamıyor.';
    if (!selectedModel) return 'Test edilecek bir model seçin.';
    if (!prompt.trim()) return 'Modele gönderilecek promptu yazın.';
    if (promptBytes > 6000) return 'Prompt en fazla 6.000 UTF-8 bayt olabilir.';
    // eslint-disable-next-line no-control-regex -- Intentionally reject controls while allowing normal whitespace.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(prompt)) return 'Prompt görünmeyen kontrol karakterleri içeriyor. Metni temizleyerek yeniden deneyin.';
    if (!plannedStages.length || plannedStages.length > 6 || plannedStages.some(value => !Number.isInteger(value) || value < 1 || value > 32)) return '1 ile 32 arasında eşzamanlılık düzeyleri seçin.';
    if (!Number.isInteger(requestCount) || requestCount < minimumRequests || requestCount > 256) return `Aşama başına ${minimumRequests}–256 arasında istek belirleyin.`;
    if (totalRequests > 1024) return 'Bir testte toplam istek sayısı 1.024 değerini aşamaz.';
    if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 2048) return 'Çıktı sınırı 1–2.048 token arasında olmalı.';
    if (!Number.isInteger(Number(timeout)) || Number(timeout) < 1000 || Number(timeout) > 180000) return 'İstek zaman aşımı 1.000–180.000 ms arasında olmalı.';
    if (!Number.isInteger(Number(p95Target)) || Number(p95Target) < 1 || Number(p95Target) > 180000) return 'P95 yanıt hedefi 1–180.000 ms arasında bir tam sayı olmalı.';
    if (checkTtft && (!Number.isInteger(Number(ttftTarget)) || Number(ttftTarget) < 1 || Number(ttftTarget) > 180000)) return 'İlk token hedefi 1–180.000 ms arasında bir tam sayı olmalı.';
    if (errorTarget.trim() === '' || !Number.isFinite(Number(errorTarget)) || Number(errorTarget) < 0 || Number(errorTarget) > 100) return 'Hata oranı hedefi %0–100 arasında olmalı.';
    return '';
  }, [options, selectedModel, prompt, promptBytes, plannedStages, requestCount, minimumRequests, totalRequests, outputCount, timeout, p95Target, checkTtft, ttftTarget, errorTarget]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; actionRequest.current?.abort(); pollRequest.current?.abort(); };
  }, []);

  const userRequest = async <T,>(action: 'options' | 'start' | 'cancel' | 'history', path: string, init?: RequestInit): Promise<T | null> => {
    if (actionRequest.current) return null;
    const controller = new AbortController();
    actionRequest.current = controller;
    setBusyAction(action); setError('');
    const timeoutId = window.setTimeout(() => controller.abort(), 25_000);
    try {
      const result = await api<T>(path, { ...init, signal: controller.signal });
      return mounted.current ? result : null;
    } catch (reason) {
      if (mounted.current) setError(controller.signal.aborted ? action === 'start' ? 'Başlatma yanıtı zamanında alınamadı. Testin başlamış olup olmadığını kayıtlı testlerden kontrol edin.' : 'İstek zamanında yanıtlanmadı. Yeniden deneyebilirsiniz.' : message(reason));
      return null;
    } finally {
      window.clearTimeout(timeoutId);
      if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setBusyAction(null); }
    }
  };

  const loadOptions = async () => {
    const result = await userRequest<ModelOptions>('options', '/models/benchmark/options');
    if (!result) return;
    setOptions(result);
    setModelId(current => result.models.some(model => model.id === current) ? current : '');
  };
  const loadHistory = async () => {
    const result = await userRequest<RunList>('history', '/models/benchmark/runs');
    if (result) { setHistory(result); setActiveRun(result.active); }
  };
  const start = async () => {
    if (validation || formLocked) { if (validation) setError(validation); return; }
    const config: TestConfig = { modelId, prompt, scenario, stages: plannedStages, requestsPerStage: requestCount, maxOutputTokens: outputCount, timeoutMs: Number(timeout), thresholds: { maxP95LatencyMs: Number(p95Target), maxP95TtftMs: checkTtft ? Number(ttftTarget) : null, maxErrorRate: Number(errorTarget) / 100 } };
    const result = await userRequest<BenchmarkRun>('start', '/models/benchmark/runs', { method: 'POST', body: JSON.stringify(config) });
    if (result) { setRun(result); setActiveRun(active(result) ? result : null); setPollError(''); setWatching(active(result)); setWatchPaused(false); }
  };
  const cancel = async (current: BenchmarkRun) => {
    if (!active(current)) return;
    pollRequest.current?.abort(); pollRequest.current = null; setPollBusy(false);
    const result = await userRequest<BenchmarkRun>('cancel', `/models/benchmark/runs/${encodeURIComponent(current.id)}/cancel`, { method: 'POST' });
    if (result) { setRun(result); setActiveRun(active(result) ? result : null); setWatching(active(result)); setPollError(''); if (history?.active?.id === result.id) setHistory(value => value ? { ...value, active: active(result) ? result : null } : value); }
  };
  const readRun = useCallback(async (id: string) => {
    if (pollRequest.current || actionRequest.current || document.hidden) return;
    const controller = new AbortController();
    pollRequest.current = controller; setPollBusy(true);
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const result = await api<BenchmarkRun>(`/models/benchmark/runs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (mounted.current && pollRequest.current === controller) {
        setRun(result); setPollError(''); setActiveRun(current => active(result) ? result : current?.id === result.id ? null : current);
        setHistory(current => current?.active?.id === result.id ? { ...current, active: active(result) ? result : null } : current);
        if (!active(result)) setWatching(false);
      }
    } catch (reason) {
      if (mounted.current && pollRequest.current === controller) { setPollError(controller.signal.aborted ? 'Test durumunun yanıtı zamanında alınamadı.' : message(reason)); setWatching(false); }
    } finally {
      window.clearTimeout(timeoutId);
      if (pollRequest.current === controller) { pollRequest.current = null; if (mounted.current) setPollBusy(false); }
    }
  }, [api]);

  // No requests are made until the user has started a test or selected a run to follow.
  useEffect(() => {
    if (!watching || !watchedRunId || !isRunning) return;
    const id = watchedRunId;
    const visibility = () => {
      setWatchPaused(document.hidden);
      if (document.hidden) { const current = pollRequest.current; pollRequest.current = null; current?.abort(); setPollBusy(false); }
      else void readRun(id);
    };
    const initial = window.setTimeout(visibility, 0);
    const interval = window.setInterval(() => void readRun(id), 2_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); };
  }, [watching, watchedRunId, isRunning, readRun]);

  const selectRun = (value: BenchmarkRun) => { pollRequest.current?.abort(); pollRequest.current = null; setPollBusy(false); setRun(value); if (active(value)) setActiveRun(value); setPollError(''); setWatching(active(value)); setWatchPaused(false); };
  const completed = run?.stages.reduce((sum, stage) => sum + stage.completedRequests, 0) || 0;
  const planned = run?.stages.reduce((sum, stage) => sum + stage.totalRequests, 0) || 0;
  const errors = run?.stages.reduce((sum, stage) => sum + stage.errors, 0) || 0;
  const inFlight = run?.stages.reduce((sum, stage) => sum + stage.inFlight, 0) || 0;
  const finishedStages = run?.stages.filter(stage => stage.state === 'completed').length || 0;

  return <section className="model-benchmark" aria-label="Kapasite Testi">
    <header className="mb-heading"><div className="mb-heading-copy"><span className="mb-heading-icon"><Gauge size={28}/></span><div><span className="mb-eyebrow">ÖLÇ · KARŞILAŞTIR · DEĞERLENDİR</span><h1>Kapasite Testi</h1><p>Seçtiğiniz prompt ile eşzamanlı istek düzeylerini karşılaştırın.</p></div></div><span className="mb-manual-badge"><Play size={13}/>Yalnız siz başlatınca çalışır</span></header>
    <div className="mb-intro"><ListChecks size={18}/><p>Bu ekran açıldığında modele istek gönderilmez. Test, <strong>Kapasite testini başlat</strong> düğmesine bastığınızda gerçek üretim istekleri gönderir. Sonuçlar seçilen model, prompt ve çıktı sınırı için geçerlidir.</p></div>
    {error && <div className="mb-error" role="alert"><AlertCircle size={17}/><span>{error}</span></div>}

    <div className="mb-setup-grid"><form className="mb-form" onSubmit={event => event.preventDefault()}>
      <section className="mb-form-section"><div className="mb-section-title"><span>1</span><div><h2>Model ve senaryo</h2><p>Kayıtlı envanterden model seçin; test promptunu siz belirleyin.</p></div></div>
        <div className="mb-model-loader"><Button type="button" variant="outline" disabled={!!busyAction || isRunning} onClick={() => void loadOptions()}>{busyAction === 'options' ? <RefreshCw size={14} className="spin"/> : <Bot size={15}/>}Kayıtlı modelleri yükle</Button><span>{options ? `${options.models.length} kayıt · ${timestamp(options.scannedAt)}` : 'Envanter henüz yüklenmedi'}</span></div>
        <label className="mb-field" htmlFor={`${fieldId}-model`}><span>Test edilecek model</span><select id={`${fieldId}-model`} value={modelId} disabled={formLocked || !options?.models.length} onChange={event => setModelId(event.target.value)} required><option value="">{options ? 'Bir model seçin' : 'Önce kayıtlı modelleri yükleyin'}</option>{options?.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.runtime} · {modelStateLabels[model.status] || 'Durumu doğrulanmadı'}</option>)}</select></label>
        {selectedModel && <div className="mb-selected-model-note"><code className="mb-model-endpoint">{selectedModel.endpoint}</code><span className={selectedModel.status === 'unreachable' ? 'mb-field-warning' : ''}>{modelStateLabels[selectedModel.status] || 'Durumu doğrulanmadı'} · Güncel bağlantı kontrolü yapılmadı.</span></div>}
        {options && !options.canStart && <p className="mb-field-note mb-field-warning">{options.unavailableReason || 'Bu ortamda test başlatma kullanılamıyor.'}</p>}
        {options && options.models.length === 0 && <p className="mb-field-note">Kayıtlı envanterde test edilebilir bir model adresi yok. Envanter taraması bu ekrandan otomatik başlatılmaz.</p>}
        <div className="mb-scenarios" aria-label="Test senaryosu">{(Object.entries(scenarioInfo) as [Scenario, { title: string; description: string }][]).map(([key, info]) => <button key={key} type="button" aria-pressed={scenario === key} className={scenario === key ? 'mb-selected' : ''} disabled={formLocked} onClick={() => setScenario(key)}>{key === 'sql' ? <FileText size={14}/> : key === 'long' ? <Layers3 size={14}/> : key === 'short' ? <Zap size={14}/> : <Bot size={14}/>}<span>{info.title}</span></button>)}</div>
        <label className="mb-field" htmlFor={`${fieldId}-prompt`}><span>Modele gönderilecek prompt</span><Textarea id={`${fieldId}-prompt`} value={prompt} onChange={event => setPrompt(event.target.value)} disabled={formLocked} placeholder="Gerçek iş yükünüzü temsil eden soru veya görevi buraya yazın…" required rows={6}/></label><div className="mb-prompt-footer"><p>{scenarioInfo[scenario].description}</p><span className={promptBytes > 6000 ? 'mb-invalid' : ''}>{displayNumber(prompt.length, 0)} karakter · {displayNumber(promptBytes, 0)} / 6.000 bayt</span></div>
      </section>

      <section className="mb-form-section"><div className="mb-section-title"><span>2</span><div><h2>Test yöntemi ve yük</h2><p>İstekler seçilen düzeylerde gönderilir; hedef dışı ilk aşamadan sonra yük artırılmaz.</p></div></div><div className="mb-methods"><button type="button" className={method === 'staged' ? 'mb-selected' : ''} aria-pressed={method === 'staged'} disabled={formLocked} onClick={() => setMethod('staged')}><BarChart3 size={19}/><span><strong>Kademeli karşılaştırma</strong><small>Birden fazla eşzamanlılık düzeyini sırayla ölçer.</small></span></button><button type="button" className={method === 'fixed' ? 'mb-selected' : ''} aria-pressed={method === 'fixed'} disabled={formLocked} onClick={() => setMethod('fixed')}><Target size={19}/><span><strong>Sabit eşzamanlılık</strong><small>Seçtiğiniz tek düzeyde aynı iş yükünü tekrarlar.</small></span></button></div>
        {method === 'staged' ? <fieldset className="mb-concurrency-choices" disabled={formLocked}><legend>Eşzamanlı istek aşamaları</legend><div>{concurrencyChoices.map(value => <button key={value} type="button" aria-pressed={stages.includes(value)} className={stages.includes(value) ? 'mb-selected' : ''} onClick={() => { const next = stages.includes(value) ? stages.filter(item => item !== value) : [...stages, value].sort((a, b) => a - b); setStages(next); const needed = Math.max(10, 2 * Math.max(0, ...next)); if (Number(requests) < needed) setRequests(String(needed)); }}>{value}<span>istek</span>{stages.includes(value) && <Check size={12}/>}</button>)}</div></fieldset> : <label className="mb-field" htmlFor={`${fieldId}-fixed`}><span>Eşzamanlı istek sayısı</span><Input id={`${fieldId}-fixed`} type="number" min={1} max={32} step={1} value={fixedConcurrency} disabled={formLocked} onChange={event => { setFixedConcurrency(event.target.value); const needed = Math.max(10, Number(event.target.value) * 2); if (Number.isInteger(needed) && needed <= 64 && Number(requests) < needed) setRequests(String(needed)); }}/></label>}
        <div className="mb-field-grid"><label className="mb-field" htmlFor={`${fieldId}-requests`}><span>Aşama başına istek</span><Input id={`${fieldId}-requests`} type="number" min={minimumRequests} max={256} step={1} value={requests} onChange={event => setRequests(event.target.value)} disabled={formLocked} required/><small>En az {displayNumber(minimumRequests, 0)}; her düzeyde aynı adet.</small></label><label className="mb-field" htmlFor={`${fieldId}-tokens`}><span>İstek başına çıktı sınırı</span><Input id={`${fieldId}-tokens`} type="number" min={1} max={2048} step={1} value={maxOutput} onChange={event => setMaxOutput(event.target.value)} disabled={formLocked} required/><small>En fazla 2.048 çıktı tokenı.</small></label><label className="mb-field" htmlFor={`${fieldId}-timeout`}><span>İstek zaman aşımı · ms</span><Input id={`${fieldId}-timeout`} type="number" min={1000} max={180000} step={1000} value={timeout} onChange={event => setTimeoutValue(event.target.value)} disabled={formLocked} required/><small>Testin toplam süre sınırı 30 dakika.</small></label></div>
      </section>

      <section className="mb-form-section"><div className="mb-section-title"><span>3</span><div><h2>Başarı hedefleri</h2><p>Bir düzeyin geçti sayılması için seçtiğiniz hedeflerin birlikte karşılanması gerekir.</p></div></div><div className="mb-field-grid"><label className="mb-field" htmlFor={`${fieldId}-p95`}><span>P95 yanıt süresi · ms</span><Input id={`${fieldId}-p95`} type="number" min={1} max={180000} step={1} value={p95Target} onChange={event => setP95Target(event.target.value)} disabled={formLocked} required/><small>Yanıtların %95’i için süre hedefi.</small></label><label className="mb-field" htmlFor={`${fieldId}-ttft`}><span>P95 ilk token · ms</span><Input id={`${fieldId}-ttft`} type="number" min={1} max={180000} step={1} value={ttftTarget} onChange={event => setTtftTarget(event.target.value)} disabled={formLocked || !checkTtft} required={checkTtft}/><small>İlk görünür yanıt içeriği; reasoning hariç.</small></label><label className="mb-field" htmlFor={`${fieldId}-error`}><span>En yüksek hata oranı · %</span><Input id={`${fieldId}-error`} type="number" min={0} max={100} step={0.5} value={errorTarget} onChange={event => setErrorTarget(event.target.value)} disabled={formLocked} required/><small>Zaman aşımı ve başarısız istekler dahil.</small></label></div><label className="mb-checkbox"><input type="checkbox" checked={checkTtft} disabled={formLocked} onChange={event => setCheckTtft(event.target.checked)}/><span>İlk token hedefini değerlendirmeye dahil et</span></label><p className="mb-field-note">Servis ilk token veya token kullanımı bildirmiyorsa ilgili ölçüm eksik olarak gösterilir; tahminle doldurulmaz.</p></section>

      <div className="mb-start-row"><div><strong>{validation ? 'Test planını tamamlayın' : 'Test planı hazır'}</strong><p>{validation || 'Başlat düğmesi seçili modele gerçek istekler gönderir.'}</p></div><Button type="button" className="mb-start" disabled={!!validation || formLocked} onClick={() => void start()}>{busyAction === 'start' ? <RefreshCw size={16} className="spin"/> : <Play size={16}/>}Kapasite testini başlat</Button></div>
    </form>

    <aside className="mb-plan" aria-label="Test planı önizlemesi"><div className="mb-plan-title"><ListChecks size={20}/><div><span>ÖNİZLEME</span><h2>Gönderilecek iş yükü</h2></div></div><div className="mb-plan-model"><Bot size={18}/><div><strong>{selectedModel?.name || 'Henüz model seçilmedi'}</strong><span>{selectedModel?.runtime || 'Kayıtlı model listesinden seçin'}</span></div></div><div className="mb-plan-stages">{plannedStages.length ? plannedStages.map((value, index) => <span key={`${value}-${index}`}>{index > 0 && <ArrowRight size={12}/>}<b>{Number.isFinite(value) && value >= 1 ? value : '—'}</b></span>) : <span>Aşama seçilmedi</span>}</div><p className="mb-plan-stage-label">İstemcinin aynı anda göndereceği istek sayısı</p><dl className="mb-plan-numbers"><div><dt>Aşama</dt><dd>{plannedStages.length}</dd></div><div><dt>Her aşamada</dt><dd>{Number.isInteger(requestCount) && requestCount >= 0 ? displayNumber(requestCount, 0) : '—'} istek</dd></div><div className="mb-plan-total"><dt>Planlanan toplam</dt><dd>{Number.isInteger(totalRequests) && totalRequests >= 0 ? displayNumber(totalRequests, 0) : '—'} istek</dd></div><div><dt>İstek başına çıktı</dt><dd>≤ {Number.isInteger(outputCount) && outputCount > 0 ? displayNumber(outputCount, 0) : '—'} token</dd></div><div><dt>Toplam çıktı üst sınırı</dt><dd>{Number.isInteger(totalRequests * outputCount) && totalRequests * outputCount > 0 ? displayNumber(totalRequests * outputCount, 0) : '—'} token</dd></div></dl><div className="mb-plan-note"><Timer size={16}/><p>Aynı prompt her istekte kullanılır. Önbellek, prompt uzunluğu, mevcut sunucu yükü ve çıktı uzunluğu sonucu etkiler.</p></div><div className="mb-plan-note"><Gauge size={16}/><p><strong>Bu, kullanıcı kapasitesi garantisi değildir.</strong> Test edilen düzeyler ve hedefler için gözlenen sonuçtur.</p></div></aside></div>

    {activeRun && active(activeRun) && activeRun.id !== run?.id && <div className="mb-existing-run"><Activity size={19}/><div><strong>Devam eden bir test var: {activeRun.modelName}</strong><p>{timestamp(activeRun.startedAt)} · {runLabels[activeRun.state]}</p></div><Button variant="outline" onClick={() => selectRun(activeRun)}>Testi izle</Button><Button variant="outline" className="mb-stop" disabled={!!busyAction || activeRun.state === 'cancelling'} onClick={() => void cancel(activeRun)}><Square size={13}/>Durdur</Button></div>}

    {run && <section className="mb-run" aria-label="Test sonuçları"><header className="mb-results-heading"><div><span className="mb-eyebrow">TEST SONUCU</span><h2>{run.modelName}<span className={`mb-run-state mb-run-${run.state}`}>{runLabels[run.state]}</span></h2><p>{timestamp(run.startedAt)} · {run.runtime}<code>{run.endpoint}</code></p></div><div className="mb-results-actions">{isRunning && <Button variant="outline" className="mb-stop" disabled={!!busyAction || run.state === 'cancelling'} onClick={() => void cancel(run)}>{busyAction === 'cancel' ? <RefreshCw size={14} className="spin"/> : <Square size={14}/>}Testi durdur</Button>}{isRunning && (!watching || pollError) && <Button variant="outline" disabled={pollBusy || !!busyAction} onClick={() => { setWatching(true); void readRun(run.id); }}><RefreshCw size={14}/>Durumu güncelle</Button>}</div></header>
      {isRunning && <div className="mb-progress"><div><span>{completed} / {planned} istek tamamlandı</span><strong>{planned ? displayNumber(completed / planned * 100, 0) : '0'}%</strong></div><progress max={Math.max(1, planned)} value={completed} aria-label="Test ilerlemesi"/><p>{watchPaused ? 'Sekme gizliyken durum takibi duraklatıldı.' : watching ? 'Test durumu izleniyor.' : 'Otomatik durum takibi durdu.'} Ekrandan ayrılmak testi durdurmaz; durdurmak için Testi durdur düğmesini kullanın.</p><p>Durdur, yeni istekleri keser ve açık HTTP isteklerini iptal eder. Model sunucusunda başlamış üretimin durması sağlayıcının davranışına bağlıdır.</p></div>}
      {(run.error || pollError) && <div className="mb-error" role="alert"><AlertCircle size={16}/><span>{pollError || run.error}{pollError ? ' Son alınan sonuçlar gösteriliyor; test sunucuda devam ediyor olabilir.' : ''}</span></div>}
      <div className="mb-result-stats"><div><span><Check size={15}/>Tamamlanan</span><strong>{completed}<small> / {planned}</small></strong></div><div><span><Activity size={15}/>Süren istek</span><strong>{inFlight}</strong></div><div><span><AlertCircle size={15}/>Hatalı istek</span><strong>{errors}</strong></div><div><span><Layers3 size={15}/>Ölçülen aşama</span><strong>{finishedStages}<small> / {run.stages.length}</small></strong></div></div>
      {run.report && !isRunning && <div className="mb-report"><span><Gauge size={23}/></span><div><h3>{run.report.highestPassingConcurrency != null ? `Hedefleri karşılayan en yüksek düzey: ${run.report.highestPassingConcurrency} eşzamanlı istek` : 'Hedefleri karşılayan bir düzey doğrulanmadı'}</h3><p>{run.report.note}</p>{run.report.stoppedReason && <p>{stopReasons[run.report.stoppedReason] || 'Test sonlandı.'}</p>}<p className="mb-report-scope">Bu sonuç yalnız bu testin promptu, çıktı sınırı ve ölçüm hedefleri için geçerlidir.</p></div></div>}
      <details className="mb-run-config"><summary><FileText size={14}/>Bu testin kaydedilmiş ayarları<ChevronDown size={14}/></summary><dl><div><dt>Senaryo</dt><dd>{scenarioInfo[run.config.scenario]?.title || run.config.scenario}</dd></div><div><dt>Prompt uzunluğu</dt><dd>{displayNumber(run.config.promptChars, 0)} karakter</dd></div><div><dt>Aşamalar / aşama başına istek</dt><dd>{run.config.stages.join(' → ')} / {run.config.requestsPerStage}</dd></div><div><dt>Çıktı sınırı / zaman aşımı</dt><dd>{run.config.maxOutputTokens} token / {milliseconds(run.config.timeoutMs)}</dd></div><div><dt>P95 yanıt / ilk token hedefi</dt><dd>{milliseconds(run.config.thresholds.maxP95LatencyMs)} / {run.config.thresholds.maxP95TtftMs == null ? 'Değerlendirmeye dahil değil' : milliseconds(run.config.thresholds.maxP95TtftMs)}</dd></div><div><dt>En yüksek hata oranı</dt><dd>%{displayNumber(run.config.thresholds.maxErrorRate * 100)}</dd></div><div className="mb-config-hash"><dt>Prompt özeti (hash)</dt><dd><code>{run.config.promptHash}</code></dd></div></dl><p>Bu ayarlar kaydedilmiş koşuya aittir. Yukarıdaki form değişiklikleri geçmiş ölçümün koşullarını değiştirmez; prompt metni bu kayıtta saklanmaz.</p></details>
      <div className="mb-stage-results">{run.stages.map(stage => <StageResult key={stage.concurrency} stage={stage} finished={!isRunning}/>)}</div><footer className="mb-result-footer"><span><Clock3 size={13}/>Son kayıt: {timestamp(run.updatedAt)}</span><code>Test: {run.id}</code></footer>
    </section>}

    <section className="mb-history" aria-label="Kayıtlı kapasite testleri"><header><div><History size={18}/><div><h2>Kayıtlı testler</h2><p>Önceki ölçümleri görüntüleyin veya devam eden testi izleyin.</p></div></div><Button type="button" variant="outline" disabled={!!busyAction} onClick={() => void loadHistory()}>{busyAction === 'history' ? <RefreshCw size={14} className="spin"/> : <History size={14}/>}Kayıtlı testleri yükle</Button></header>{history ? history.history.length ? <div className="mb-history-list">{history.history.map(item => <button key={item.id} type="button" className={item.id === run?.id ? 'mb-history-selected' : ''} onClick={() => selectRun(item)}><span className="mb-history-icon"><BarChart3 size={17}/></span><span className="mb-history-copy"><strong>{item.modelName}</strong><small>{timestamp(item.startedAt)} · {item.config.stages.join(' → ')} istek</small></span><span className={`mb-run-state mb-run-${item.state}`}>{runLabels[item.state]}</span><span className="mb-history-result">{item.report?.highestPassingConcurrency != null ? `${item.report.highestPassingConcurrency} eşzamanlı` : 'Sonucu incele'}<ArrowRight size={14}/></span></button>)}</div> : <p className="mb-history-empty">Henüz kayıtlı tamamlanmış test bulunmuyor.</p> : <p className="mb-history-empty">Geçmiş, yalnız bu düğmeye bastığınızda okunur. Sayfa açılışında tarama veya model isteği yapılmaz.</p>}</section>
  </section>;
}
