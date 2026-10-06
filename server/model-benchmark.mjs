import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const HISTORY_LIMIT = 30;
const HISTORY_BYTES = 2 * 1024 * 1024;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const EVENT_BYTES = 256 * 1024;
const RUN_DURATION_MS = 30 * 60 * 1000;
const STATES = new Set(['running', 'cancelling', 'completed', 'cancelled', 'failed']);
const SCENARIOS = new Set(['custom', 'short', 'long', 'sql']);
const CONFIG_KEYS = new Set(['modelId', 'prompt', 'scenario', 'stages', 'requestsPerStage', 'maxOutputTokens', 'timeoutMs', 'thresholds']);
const THRESHOLD_KEYS = new Set(['maxP95LatencyMs', 'maxP95TtftMs', 'maxErrorRate']);
const ERROR_CODES = new Set(['stream_unavailable', 'provider_error', 'invalid_stream', 'response_limit', 'aborted', 'incomplete_stream', 'no_visible_output', 'http_error', 'request_timeout', 'connection_error', 'request_error']);
const errorCode = value => typeof value === 'string' && (ERROR_CODES.has(value) || /^http_[1-5]\d{2}$/.test(value)) ? value : 'request_error';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const wireError = code => Object.assign(new Error(code), { benchmarkCode: code });
const copy = value => structuredClone(value);
const iso = milliseconds => new Date(milliseconds).toISOString();
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const nullableNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateBenchmarkConfig(value) {
  if (!isObject(value) || Object.keys(value).some(key => !CONFIG_KEYS.has(key))) throw failure('Test ayarları geçersiz; servis adresi istemciden gönderilemez.');
  if (typeof value.modelId !== 'string' || value.modelId.length < 1 || value.modelId.length > 256) throw failure('Kayıtlı bir model seçin.');
  // eslint-disable-next-line no-control-regex -- Intentionally reject controls before serializing a bounded request body.
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt, 'utf8') > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.prompt)) throw failure('Test metni boş olamaz; en fazla 6000 UTF-8 baytı içermeli.');
  if (!SCENARIOS.has(value.scenario ?? 'custom')) throw failure('Test senaryosu geçersiz.');
  if (!Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > 6 || value.stages.some((stage, index) => !integer(stage, 1, 32) || (index > 0 && stage <= value.stages[index - 1]))) throw failure('Eşzamanlılık adımları 1–32 arasında, artan ve benzersiz olmalı; en fazla 6 adım seçilebilir.');
  if (!integer(value.requestsPerStage, 10, 256) || value.requestsPerStage < 2 * value.stages.at(-1) || value.requestsPerStage * value.stages.length > 1024) throw failure('Adım başına 10–256 istek, en yüksek eşzamanlılığın en az iki katı örnek ve toplamda en fazla 1024 istek gerekir.');
  if (!integer(value.maxOutputTokens, 1, 2048) || !integer(value.timeoutMs, 1000, 180000)) throw failure('Yanıt sınırı 1–2048 token; istek zaman aşımı 1–180 saniye arasında olmalı.');
  const thresholds = value.thresholds;
  if (!isObject(thresholds) || Object.keys(thresholds).some(key => !THRESHOLD_KEYS.has(key)) || !integer(thresholds.maxP95LatencyMs, 1, 180000) || (thresholds.maxP95TtftMs !== null && !integer(thresholds.maxP95TtftMs, 1, 180000)) || typeof thresholds.maxErrorRate !== 'number' || !Number.isFinite(thresholds.maxErrorRate) || thresholds.maxErrorRate < 0 || thresholds.maxErrorRate > 1) throw failure('Gecikme ve hata oranı eşikleri geçersiz.');
  return { modelId: value.modelId, prompt: value.prompt, scenario: value.scenario ?? 'custom', stages: [...value.stages], requestsPerStage: value.requestsPerStage,
    maxOutputTokens: value.maxOutputTokens, timeoutMs: value.timeoutMs, thresholds: { ...thresholds } };
}

function resolveTarget(value) {
  // eslint-disable-next-line no-control-regex -- Provider model identities must not contain any control characters.
  if (!isObject(value) || typeof value.model !== 'string' || !value.model || value.model.length > 512 || /[\u0000-\u001f\u007f]/.test(value.model)) throw failure('Seçilen modelin servis kimliği doğrulanamadı.');
  const url = new URL(value.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('Kayıtlı model servisi adresi geçersiz.');
  const runtime = value.runtime === 'ollama' ? 'ollama' : value.runtime === 'openai' ? 'openai' : null;
  if (!runtime) throw failure('Bu modelin test bağlantısı desteklenmiyor.');
  const prefix = url.pathname.replace(/\/+$/, '');
  if (!['', '/v1', '/api', '/v1/chat/completions', '/api/chat'].includes(prefix)) throw failure('Kayıtlı model servisi yolu desteklenmiyor.');
  return { model: value.model, name: typeof value.name === 'string' ? value.name.slice(0, 300) : value.model, runtime,
    endpoint: url.origin, requestUrl: url.origin + (runtime === 'ollama' ? '/api/chat' : '/v1/chat/completions') };
}

function reportedUsage(value, runtime) {
  const token = item => integer(item, 0, Number.MAX_SAFE_INTEGER) ? item : null;
  if (runtime === 'ollama') {
    const inputTokens = token(value?.prompt_eval_count), outputTokens = token(value?.eval_count);
    return { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null && Number.isSafeInteger(inputTokens + outputTokens) ? inputTokens + outputTokens : null };
  }
  return { inputTokens: token(value?.prompt_tokens), outputTokens: token(value?.completion_tokens), totalTokens: token(value?.total_tokens) };
}

function visibleContent(value) {
  if (typeof value === 'string') return /\S/u.test(value);
  if (Array.isArray(value)) return value.some(part => isObject(part) && ['text', 'output_text'].includes(part.type) && typeof part.text === 'string' && /\S/u.test(part.text));
  return false;
}

/** Raw chunks remain local to a single request and are never included in records. */
async function consumeResponse(response, runtime, markVisible, signal) {
  if (!response.body?.getReader) throw wireError('stream_unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const contentType = response.headers.get('content-type') || '';
  const bufferedJson = /application\/json/i.test(contentType) && !/ndjson/i.test(contentType);
  let totalBytes = 0, pending = '', eventData = [], eventBytes = 0, terminal = false, streamDone = false, visible = false;
  let usage = { inputTokens: null, outputTokens: null, totalTokens: null };
  const payload = (value, streaming) => {
    if (!isObject(value) || value.error) throw wireError('provider_error');
    if (runtime === 'ollama') {
      if (visibleContent(value.message?.content)) { visible = true; if (streaming) markVisible(); }
      if (value.done === true) { terminal = true; streamDone = true; usage = reportedUsage(value, runtime); }
    } else {
      if (isObject(value.usage)) usage = reportedUsage(value.usage, runtime);
      for (const choice of Array.isArray(value.choices) ? value.choices : []) {
        if (visibleContent(streaming ? choice.delta?.content : choice.message?.content)) { visible = true; if (streaming) markVisible(); }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) terminal = true;
      }
      if (!streaming && Array.isArray(value.choices)) terminal = true;
    }
  };
  const json = (text, streaming = true) => {
    try { payload(JSON.parse(text), streaming); }
    catch (error) { throw error?.benchmarkCode ? error : wireError('invalid_stream'); }
  };
  const dispatch = () => {
    if (!eventData.length) return;
    const value = eventData.join('\n'); eventData = []; eventBytes = 0;
    if (value.trim() === '[DONE]') { terminal = true; streamDone = true; } else json(value);
  };
  const line = value => {
    if (runtime === 'ollama') { if (value.trim()) json(value); return; }
    if (!value) { dispatch(); return; }
    if (value.startsWith('data:')) {
      const data = value.slice(5).replace(/^ /, ''); eventBytes += Buffer.byteLength(data);
      if (eventBytes > EVENT_BYTES) throw wireError('response_limit');
      eventData.push(data);
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw wireError('aborted');
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > RESPONSE_BYTES) throw wireError('response_limit');
      pending += decoder.decode(chunk.value, { stream: true });
      if (bufferedJson) continue;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const next = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); line(next);
        if (streamDone) break;
      }
      if (streamDone) { pending = ''; break; }
      if (Buffer.byteLength(pending) > EVENT_BYTES) throw wireError('response_limit');
    }
    pending += decoder.decode();
    if (bufferedJson) json(pending, false);
    else { if (pending.trim()) line(pending.replace(/\r$/, '')); if (runtime !== 'ollama') dispatch(); }
    if (signal.aborted) throw wireError('aborted');
    if (!terminal) throw wireError('incomplete_stream');
    if (!visible) throw wireError('no_visible_output');
    return usage;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    pending = ''; eventData = [];
  }
}

async function requestOnce(job, fetchImpl, monotonicNow) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  job.controller.signal.addEventListener('abort', abort, { once: true });
  const started = monotonicNow();
  let firstVisible = null, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, job.config.timeoutMs);
  const target = job.target;
  try {
    if (job.controller.signal.aborted) throw wireError('aborted');
    const body = target.runtime === 'ollama'
      ? { model: target.model, messages: [{ role: 'user', content: job.prompt }], stream: true, options: { temperature: 0, num_predict: job.config.maxOutputTokens } }
      : { model: target.model, messages: [{ role: 'user', content: job.prompt }], stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: job.config.maxOutputTokens };
    // Only this explicit-start path can reach the injected network function.
    // Redirects and retries are forbidden; the resolver owns trusted endpoints.
    const response = await fetchImpl(target.requestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: target.runtime === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw wireError(integer(response.status, 100, 599) ? `http_${response.status}` : 'http_error');
    }
    const usage = await consumeResponse(response, target.runtime, () => { if (firstVisible === null) firstVisible = monotonicNow() - started; }, controller.signal);
    return { outcome: 'success', latencyMs: monotonicNow() - started, ttftMs: firstVisible, usage };
  } catch (error) {
    if (job.controller.signal.aborted) return { outcome: 'cancelled', code: job.stopReason === 'duration_limit' ? 'duration_limit' : 'cancelled' };
    return { outcome: 'error', code: timedOut ? 'request_timeout' : error?.benchmarkCode ? errorCode(error.benchmarkCode) : 'connection_error' };
  } finally { clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort); }
}

const percentile = (samples, fraction) => samples.length ? round([...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)]) : null;

function metricsFor(samples, elapsedMs, provisional) {
  const successful = samples.filter(sample => sample.outcome === 'success');
  const errors = samples.filter(sample => sample.outcome === 'error').length;
  const measured = successful.length + errors;
  const ttfts = successful.map(sample => sample.ttftMs).filter(value => nullableNumber(value) !== null);
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    const values = successful.map(sample => sample.usage[key]);
    // A failed/cancelled/in-flight request may also consume tokens. Do not label
    // the successful subset as a complete stage total or throughput measure.
    const completeUsage = !provisional && successful.length === samples.length && values.length && values.every(value => value !== null);
    const sum = completeUsage ? values.reduce((a, b) => a + b, 0) : null;
    usage[key] = Number.isSafeInteger(sum) ? sum : null;
  }
  return { p50LatencyMs: percentile(successful.map(sample => sample.latencyMs), 0.5), p95LatencyMs: percentile(successful.map(sample => sample.latencyMs), 0.95), p95TtftMs: percentile(ttfts, 0.95),
    errorRate: measured ? errors / measured : null, requestsPerSecond: elapsedMs > 0 && measured ? round(successful.length / (elapsedMs / 1000)) : null,
    outputTokensPerSecond: elapsedMs > 0 && usage.outputTokens !== null ? round(usage.outputTokens / (elapsedMs / 1000)) : null,
    usage, successfulRequests: successful.length, ttftSampleCount: ttfts.length,
    usageSampleCount: successful.filter(sample => sample.usage.inputTokens !== null && sample.usage.outputTokens !== null).length, provisional };
}

function evaluateStage(stage, thresholds) {
  const reasons = [], metrics = stage.metrics;
  if (stage.state !== 'completed' || stage.completedRequests !== stage.totalRequests) return { passed: null, reasons: [] };
  if (stage.peakInFlight < stage.concurrency) reasons.push('İstenen eşzamanlı istek düzeyine ulaşılamadı.');
  if (metrics.successfulRequests < Math.max(10, stage.concurrency)) reasons.push('Bu düzeyi değerlendirmek için yeterli başarılı örnek yok.');
  if (metrics.errorRate === null || metrics.errorRate > thresholds.maxErrorRate) reasons.push('Hata oranı eşiği aşıldı.');
  if (metrics.p95LatencyMs === null || metrics.p95LatencyMs > thresholds.maxP95LatencyMs) reasons.push('p95 yanıt süresi eşiği karşılanmadı.');
  if (thresholds.maxP95TtftMs !== null && (metrics.ttftSampleCount !== metrics.successfulRequests || metrics.p95TtftMs === null || metrics.p95TtftMs > thresholds.maxP95TtftMs)) reasons.push('p95 ilk görünür içerik süresi eşiği karşılanmadı veya tüm başarılı yanıtlarda ölçülemedi.');
  return { passed: reasons.length === 0, reasons };
}

const initialMetrics = () => metricsFor([], 0, true);
const note = 'Sonuç yalnızca seçilen model, test metni, çıktı sınırı, eşikler ve test anındaki yük için geçerlidir. En yüksek geçen adım ölçülmüş adımlar arasındadır; mutlak sunucu veya eşzamanlı kullanıcı kapasitesi değildir. Süreler istemci, ağ, kuyruk ve olası soğuk başlangıcı içerir. Gecikme yüzdelikleri başarılı yanıtlardan hesaplanır. Aynı metnin tekrarı önbellek etkisi yaratabilir. Token sayıları yalnızca servisin bildirdiği kullanım değerleridir; iç düşünme tokenlarını da içerebilir.';

function historyProjection(run) {
  // The sole disk representation: no prompt, response, request body or exception.
  return { id: run.id, modelId: run.modelId, modelName: run.modelName, endpoint: run.endpoint, runtime: run.runtime, state: run.state,
    startedAt: run.startedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt,
    config: { modelId: run.config.modelId, scenario: run.config.scenario, stages: [...run.config.stages], requestsPerStage: run.config.requestsPerStage,
      maxOutputTokens: run.config.maxOutputTokens, timeoutMs: run.config.timeoutMs, thresholds: { maxP95LatencyMs: run.config.thresholds.maxP95LatencyMs,
        maxP95TtftMs: run.config.thresholds.maxP95TtftMs, maxErrorRate: run.config.thresholds.maxErrorRate }, promptChars: run.config.promptChars, promptHash: run.config.promptHash },
    stages: run.stages.map(stage => ({ concurrency: stage.concurrency, state: stage.state, startedAt: stage.startedAt, finishedAt: stage.finishedAt,
      startedRequests: stage.startedRequests, completedRequests: stage.completedRequests, inFlight: stage.inFlight, peakInFlight: stage.peakInFlight,
      totalRequests: stage.totalRequests, errors: stage.errors, cancelledRequests: stage.cancelledRequests,
      errorCounts: Object.fromEntries(Object.entries(stage.errorCounts || {}).filter(([code, count]) => errorCode(code) === code && integer(count, 0, 256))),
      metrics: { p50LatencyMs: stage.metrics.p50LatencyMs,
        p95LatencyMs: stage.metrics.p95LatencyMs, p95TtftMs: stage.metrics.p95TtftMs, errorRate: stage.metrics.errorRate, requestsPerSecond: stage.metrics.requestsPerSecond,
        outputTokensPerSecond: stage.metrics.outputTokensPerSecond, usage: { inputTokens: stage.metrics.usage.inputTokens, outputTokens: stage.metrics.usage.outputTokens, totalTokens: stage.metrics.usage.totalTokens },
        successfulRequests: stage.metrics.successfulRequests, ttftSampleCount: stage.metrics.ttftSampleCount, usageSampleCount: stage.metrics.usageSampleCount, provisional: stage.metrics.provisional },
      passed: stage.passed, failureReasons: [...stage.failureReasons] })),
    report: { highestPassingConcurrency: run.report.highestPassingConcurrency, conditional: true, stoppedReason: run.report.stoppedReason, note }, error: run.error };
}

/**
 * Cached resolver contract: resolveModel(modelId) -> { model, name, endpoint,
 * runtime: 'openai'|'ollama' }. It must only consult trusted configuration/cache.
 * Constructor, list(), get(), cancel() and shutdown() never initiate a request.
 */
export function createModelBenchmark({ dataDir, resolveModel, fetchImpl = globalThis.fetch, now = () => Date.now(), monotonicNow = () => performance.now() } = {}) {
  if (!dataDir || typeof resolveModel !== 'function' || typeof fetchImpl !== 'function') throw new Error('Test motoru yapılandırması geçersiz.');
  const filename = path.join(dataDir, 'model-benchmarks.json');
  let runs = [], active = null, starting = false, closed = false, writes = Promise.resolve();
  const initialized = (async () => {
    try {
      if ((await stat(filename)).size > HISTORY_BYTES) return;
      const stored = JSON.parse(await readFile(filename, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.runs)) return;
      for (const raw of stored.runs.slice(0, HISTORY_LIMIT)) {
        try {
          if (!isObject(raw) || typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(raw.id) || !STATES.has(raw.state) || !Array.isArray(raw.stages) || raw.stages.length > 6 || !isObject(raw.config) || !/^[a-f0-9]{64}$/.test(raw.config.promptHash)) continue;
          const run = historyProjection(raw);
          if (run.state === 'running' || run.state === 'cancelling') {
            run.state = 'failed'; run.finishedAt = iso(now()); run.updatedAt = run.finishedAt;
            run.error = 'Uygulama yeniden başladığı için test tamamlanamadı; hiçbir istek otomatik olarak yeniden başlatılmadı.';
            run.report.stoppedReason = 'interrupted';
            for (const stage of run.stages) if (stage.state === 'running') { stage.state = 'cancelled'; stage.inFlight = 0; stage.passed = null; stage.finishedAt = run.finishedAt; }
          }
          runs.push(run);
        } catch { /* A malformed record does not revive or launch a run. */ }
      }
    } catch { /* No history, unreadable history, or invalid JSON: start empty. */ }
  })();

  function persist() {
    const text = JSON.stringify({ version: 1, runs: runs.slice(0, HISTORY_LIMIT).map(historyProjection) });
    if (Buffer.byteLength(text) > HISTORY_BYTES) return Promise.reject(new Error('history_limit'));
    const write = writes.catch(() => {}).then(async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(filename + '.tmp', text, { mode: 0o600 });
      await rename(filename + '.tmp', filename);
    });
    writes = write;
    return write;
  }
  const update = run => { run.updatedAt = iso(now()); };

  async function execute(job) {
    const run = job.run;
    const deadline = setTimeout(() => { job.stopReason = 'duration_limit'; job.controller.abort(); }, RUN_DURATION_MS);
    try {
      for (const stage of run.stages) {
        if (job.controller.signal.aborted) break;
        stage.state = 'running'; stage.startedAt = iso(now()); update(run);
        const samples = [], started = monotonicNow();
        let next = 0;
        const worker = async () => {
          while (!job.controller.signal.aborted && next < stage.totalRequests) {
            next += 1; stage.startedRequests += 1; stage.inFlight += 1; stage.peakInFlight = Math.max(stage.peakInFlight, stage.inFlight); update(run);
            let sample;
            try { sample = await requestOnce(job, fetchImpl, monotonicNow); }
            catch { sample = { outcome: 'error', code: 'request_error' }; }
            stage.inFlight -= 1; stage.completedRequests += 1;
            if (sample.outcome === 'error') { stage.errors += 1; const code = errorCode(sample.code); stage.errorCounts[code] = (stage.errorCounts[code] || 0) + 1; }
            if (sample.outcome === 'cancelled') stage.cancelledRequests += 1;
            samples.push(sample); stage.metrics = metricsFor(samples, monotonicNow() - started, true); update(run);
          }
        };
        await Promise.all(Array.from({ length: stage.concurrency }, worker));
        stage.finishedAt = iso(now()); stage.inFlight = 0;
        stage.state = job.controller.signal.aborted ? 'cancelled' : 'completed';
        stage.metrics = metricsFor(samples, monotonicNow() - started, stage.state !== 'completed');
        const evaluation = evaluateStage(stage, run.config.thresholds);
        stage.passed = evaluation.passed; stage.failureReasons = evaluation.reasons; update(run);
        if (stage.passed === true) run.report.highestPassingConcurrency = stage.concurrency;
        if (stage.passed === false) { run.report.stoppedReason = 'threshold_failed'; break; }
      }
      if (job.controller.signal.aborted) {
        run.state = job.stopReason === 'duration_limit' ? 'failed' : 'cancelled';
        run.report.stoppedReason = job.stopReason || 'cancelled';
        if (job.stopReason === 'duration_limit') run.error = '30 dakikalık toplam test süresi sınırına ulaşıldı.';
      } else {
        run.state = 'completed'; run.report.stoppedReason ||= 'all_stages_completed';
      }
    } catch {
      job.controller.abort(); run.state = 'failed'; run.error = 'Test tamamlanamadı; ham servis yanıtı kaydedilmedi.'; run.report.stoppedReason = 'engine_error';
      for (const stage of run.stages) if (stage.state === 'running') { stage.state = 'cancelled'; stage.inFlight = 0; stage.passed = null; stage.finishedAt = iso(now()); }
    } finally {
      clearTimeout(deadline); job.prompt = ''; run.finishedAt = iso(now()); update(run);
      try { await persist(); } catch { run.error = 'Sonuç bellekte görülebiliyor, ancak test geçmişi diske kaydedilemedi.'; }
      if (active === job) active = null;
    }
  }

  async function start(input) {
    await initialized;
    if (closed) throw failure('Test motoru kapalı.', 503);
    if (starting || active) throw failure('Bir kapasite testi zaten çalışıyor. Önce onu durdurun veya tamamlanmasını bekleyin.', 409);
    starting = true;
    let run;
    try {
      const config = validateBenchmarkConfig(input);
      let target;
      try { target = resolveTarget(await resolveModel(config.modelId)); }
      catch { throw failure('Seçilen modelin kayıtlı test bağlantısı kullanılamıyor.'); }
      if (closed) throw failure('Test motoru kapalı.', 503);
      const { prompt, ...settings } = config;
      const savedConfig = { ...settings, promptChars: [...prompt].length, promptHash: createHash('sha256').update(prompt).digest('hex') };
      const startedAt = iso(now());
      run = { id: randomUUID(), modelId: config.modelId, modelName: target.name, endpoint: target.endpoint, runtime: target.runtime, state: 'running', startedAt, finishedAt: null, updatedAt: startedAt,
        config: savedConfig, stages: settings.stages.map(concurrency => ({ concurrency, state: 'pending', startedAt: null, finishedAt: null, startedRequests: 0, completedRequests: 0,
          inFlight: 0, peakInFlight: 0, totalRequests: settings.requestsPerStage, errors: 0, cancelledRequests: 0, errorCounts: {}, metrics: initialMetrics(), passed: null, failureReasons: [] })),
        report: { highestPassingConcurrency: null, conditional: true, stoppedReason: null, note }, error: null };
      // Install cancellation before the record can be observed while its initial
      // disk write is pending. This promise also covers that startup interval.
      let finishJob;
      const done = new Promise(resolve => { finishJob = resolve; });
      const job = { run, target, config: settings, prompt, controller: new AbortController(), stopReason: null, promise: done };
      active = job;
      runs.unshift(run); runs = runs.slice(0, HISTORY_LIMIT);
      try { await persist(); }
      catch {
        runs = runs.filter(item => item.id !== run.id); job.prompt = '';
        if (active === job) active = null; finishJob();
        throw failure('Test geçmişi oluşturulamadı; modele hiçbir istek gönderilmedi.', 503);
      }
      if (closed || job.controller.signal.aborted) {
        run.state = 'cancelled'; run.finishedAt = iso(now()); update(run); run.report.stoppedReason = closed ? 'shutdown' : job.stopReason || 'cancelled';
        job.prompt = ''; await persist().catch(() => {});
        if (active === job) active = null; finishJob();
        return copy(run);
      }
      void Promise.resolve().then(() => execute(job)).then(finishJob, () => {
        // execute normally absorbs failures; this prevents an unexpected local
        // exception from leaving shutdown waiting on an unresolved job.
        job.prompt = ''; if (active === job) active = null; finishJob();
      });
      return copy(run);
    } finally { starting = false; }
  }
  async function list() { await initialized; return { active: active ? copy(active.run) : null, history: runs.map(copy) }; }
  async function get(id) { await initialized; const run = runs.find(item => item.id === id); return run ? copy(run) : null; }
  async function cancel(id) {
    await initialized;
    const run = runs.find(item => item.id === id);
    if (!run) return null;
    if (active?.run.id === id && run.state === 'running' && !active.controller.signal.aborted) { active.stopReason = 'cancelled'; run.state = 'cancelling'; update(run); active.controller.abort(); }
    return copy(run);
  }
  async function shutdown() {
    closed = true;
    if (active) { active.stopReason = 'shutdown'; active.controller.abort(); await active.promise; }
    await writes.catch(() => {});
  }
  return { list, get, start, cancel, shutdown };
}
