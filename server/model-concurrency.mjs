import { spawn } from './ssh-transport.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const LIMIT = 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 503 });
const allowedStatuses = new Set(['ok', 'partial', 'unavailable', 'unsupported']);

export function validateConcurrency(value) {
  if (!value || !Array.isArray(value.services) || value.services.length > 32 || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) throw fail('Geçersiz eşzamanlılık yanıtı.');
  const services = value.services.map(service => {
    if (!service || typeof service.id !== 'string' || !allowedStatuses.has(service.status) || service.scope !== 'service' || !Array.isArray(service.sources) || service.sources.length > 16) throw fail('Geçersiz servis ölçümü.');
    const url = new URL(service.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('Geçersiz servis adresi.');
    for (const field of ['running', 'waiting', 'configuredParallelism', 'configuredQueueLimit']) {
      if (service[field] !== null && (!Number.isSafeInteger(service[field]) || service[field] < 0 || service[field] > 1e9)) throw fail('Geçersiz servis ölçümü.');
    }
    if (service.checkedAt !== null && (typeof service.checkedAt !== 'string' || !Number.isFinite(Date.parse(service.checkedAt)))) throw fail('Geçersiz ölçüm zamanı.');
    for (const source of service.sources) if (!['metrics', 'configuration'].includes(source.kind) || typeof source.source !== 'string' || typeof source.detail !== 'string' || source.source.length > 300 || source.detail.length > 1000) throw fail('Geçersiz ölçüm kaynağı.');
    // Explicit field projection prevents raw helper response/prompt fields from
    // accidentally propagating if the collector contract grows later.
    return { id: service.id, endpoint: service.endpoint, host: String(service.host).slice(0, 100), runtime: String(service.runtime).slice(0, 100), status: service.status,
      checkedAt: service.checkedAt, running: service.running, waiting: service.waiting,
      configuredParallelism: service.configuredParallelism, configuredQueueLimit: service.configuredQueueLimit,
      configuredParallelismScope: service.configuredParallelismScope === 'per-model' ? 'per-model' : 'service', scope: 'service',
      modelName: typeof service.modelName === 'string' ? service.modelName.slice(0, 200) : null,
      sources: service.sources.map(({ kind, source, detail }) => ({ kind, source, detail })),
      note: typeof service.note === 'string' ? service.note.slice(0, 1800) : null, capacity: { status: 'not_tested' } };
  });
  if (new Set(services.map(service => service.id)).size !== services.length) throw fail('Yinelenen servis ölçümü.');
  return { checkedAt: value.checkedAt, services, error: value.error ? 'Servislerin eşzamanlılık bilgileri şu anda doğrulanamadı.' : null };
}

export function createConcurrencyCollector({ mode = 'ssh', sshTarget = '', privileged = false, spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  return async function collect({ signal } = {}) {
    if (!['local', 'ssh'].includes(mode) || (mode === 'ssh' && (typeof sshTarget !== 'string' || !/^[a-zA-Z0-9_.@-]+$/.test(sshTarget) || sshTarget.startsWith('-')))) throw fail('Servis izleme bağlantısı geçersiz.');
    const command = mode === 'ssh' ? 'ssh' : privileged ? 'sudo' : '/usr/bin/python3';
    const args = mode === 'ssh'
      ? ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', sshTarget, 'sudo', '-n', '/usr/bin/python3', '-I', '/opt/viios-agent/model_concurrency.py']
      : [...(privileged ? ['-n', '/usr/bin/python3'] : []), '-I', path.join(directory, 'model_concurrency.py')];
    let output = '';
    await new Promise((resolve, reject) => {
      let child, finished = false;
      const abort = () => finish(fail('Servis izleme durduruldu.'));
      const finish = error => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { child?.kill(); output = ''; reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(fail('Servis izleme zaman aşımına uğradı.')), Math.min(timeoutMs, 20000));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try { child = spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { finish(fail('Servis izleme başlatılamadı.')); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (!finished) { output += chunk; if (Buffer.byteLength(output) > LIMIT) finish(fail('Servis izleme yanıtı sınırı aşıldı.')); } });
      child.stderr.resume();
      child.on('error', () => finish(fail('Servis izleme yardımcısına erişilemedi.')));
      child.on('close', code => finish(code === 0 ? null : fail('Servis izleme tamamlanamadı.')));
    });
    try { return validateConcurrency(JSON.parse(output)); }
    catch { throw fail('Servis izleme geçerli bir yanıt vermedi.'); }
    finally { output = ''; }
  };
}

/** Lazy light polling. No background timer, disk scan or model catalog refresh. */
export function createModelConcurrency({ mode = 'ssh', sshTarget = '', privileged = false, collect, now = () => Date.now(), ttlMs = 15000 } = {}) {
  const collector = collect || createConcurrencyCollector({ mode, sshTarget, privileged });
  const controller = new AbortController();
  let record = { checkedAt: null, error: null, services: [] }, pending = null, closed = false, lastAttemptAt = null;
  const snapshot = () => structuredClone({ ...record, refreshing: !!pending, stale: !record.checkedAt || !!record.error || now() - Date.parse(record.checkedAt) >= ttlMs });
  function refresh() {
    if (closed || pending) return snapshot();
    lastAttemptAt = now();
    pending = Promise.resolve().then(async () => {
      try {
        const result = validateConcurrency(await collector({ signal: controller.signal }));
        if (closed) return;
        const previous = new Map(record.services.map(service => [service.id, service]));
        result.services = result.services.map(service => ({ ...service,
          // Unknown current load stays null. Retain only the last successful
          // timestamp, explicitly marked stale, not the previous request count.
          checkedAt: service.checkedAt || previous.get(service.id)?.checkedAt || null,
          stale: !service.checkedAt,
        }));
        record = { ...result, checkedAt: result.error ? record.checkedAt : result.checkedAt };
      } catch {
        if (!closed) record = { ...record, error: 'Canlı kullanım bilgisi alınamadı. Önceki kontrol zamanı korunuyor.', services: record.services.map(service => ({ ...service, running: null, waiting: null, configuredParallelism: null, configuredQueueLimit: null, status: 'unavailable', stale: true, sources: [], note: 'Güncel ölçüm doğrulanamadı; eski sayılar canlı kullanım olarak gösterilmez.' })) };
      } finally { pending = null; }
    });
    return snapshot();
  }
  async function read() {
    if (!closed && !pending && (lastAttemptAt === null || now() - lastAttemptAt >= ttlMs)) return refresh();
    return snapshot();
  }
  async function waitForIdle() { await pending; return snapshot(); }
  async function shutdown() { closed = true; controller.abort(); await pending; }
  return { read, waitForIdle, shutdown };
}
