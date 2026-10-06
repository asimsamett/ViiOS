import { spawn } from './ssh-transport.mjs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createModelConcurrency } from './model-concurrency.mjs';
import { createCatalogBenchmark, modelBenchmarkRouter } from './model-benchmark-routes.mjs';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const failure = message => Object.assign(new Error(message), { status: 503 });
const MAX_OUTPUT = 8 * 1024 * 1024;
const STATUSES = new Set(['running', 'available', 'installed', 'configured', 'unreachable']);

/** No request URL, shell command, file path or model prompt enters this runner. */
export function createModelCollector({ mode = 'ssh', sshTarget = '', privileged = false, spawnProcess = spawn, timeoutMs = 120000 } = {}) {
  return async function collect({ signal } = {}) {
    if (!['local', 'ssh'].includes(mode)) throw failure('Model envanteri bu sunucuda kullanılamıyor.');
    if (mode === 'ssh' && (typeof sshTarget !== 'string' || !/^[a-zA-Z0-9_.@-]+$/.test(sshTarget) || sshTarget.startsWith('-'))) throw failure('Model envanteri bağlantısı geçersiz.');
    const executable = mode === 'ssh' ? 'ssh' : privileged ? 'sudo' : '/usr/bin/python3';
    const args = mode === 'ssh'
      ? ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', sshTarget, 'sudo', '-n', '/usr/bin/python3', '-I', '/opt/viios-agent/model_catalog.py']
      : [...(privileged ? ['-n', '/usr/bin/python3'] : []), '-I', path.join(serverDirectory, 'model_catalog.py')];
    let output = '';
    await new Promise((resolve, reject) => {
      let child, finished = false;
      const abort = () => finish(failure('Model envanteri taraması durduruldu.'));
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { child?.kill(); output = ''; reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(failure('Model envanteri zaman aşımına uğradı. Son başarılı kayıt korundu.')), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try { child = spawnProcess(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { finish(failure('Model envanteri yardımcısı başlatılamadı.')); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (finished) return;
        output += chunk;
        if (Buffer.byteLength(output) > MAX_OUTPUT) finish(failure('Model envanteri yanıtı sınırı aşıldı.'));
      });
      // stderr can contain remote paths/configuration. Never forward it to the API.
      child.stderr.resume();
      child.on('error', () => finish(failure('Model envanteri sunucusuna bağlanılamadı.')));
      child.on('close', code => finish(code === 0 ? null : failure('Model envanteri alınamadı. Son başarılı kayıt korundu.')));
    });
    try { return validateResult(JSON.parse(output)); }
    catch { throw failure('Model envanteri geçerli bir yanıt vermedi. Son başarılı kayıt korundu.'); }
    finally { output = ''; }
  };
}

export function validateResult(value) {
  if (!value || !Array.isArray(value.models) || value.models.length > 2000 || !Array.isArray(value.hosts) || value.hosts.length > 32 || !Array.isArray(value.warnings) || value.warnings.length > 200 || !value.coverage || !Number.isInteger(value.coverage.hostsChecked)) throw failure('Geçersiz model envanteri.');
  for (const model of value.models) {
    if (!model || typeof model.id !== 'string' || typeof model.name !== 'string' || model.name.length > 200 || !STATUSES.has(model.status) || !Array.isArray(model.evidence) || !Array.isArray(model.paths) || !Array.isArray(model.applications)) throw failure('Geçersiz model kaydı.');
  }
  if (value.warnings.some(message => typeof message !== 'string' || message.length > 600)) throw failure('Geçersiz envanter notu.');
  if (value.error !== null && value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 600)) throw failure('Geçersiz envanter hatası.');
  return { models: value.models, hosts: value.hosts, warnings: value.warnings, coverage: value.coverage, error: value.error || null };
}

export function createModelCatalog({ dataDir, mode = 'ssh', sshTarget = '', privileged = false, collect, concurrencyCollect, now = () => Date.now(), ttlMs = 300000 } = {}) {
  if (!dataDir) throw new Error('Model envanteri kayıt dizini gerekli.');
  const filename = path.join(dataDir, 'model-catalog.json');
  const collector = collect || createModelCollector({ mode, sshTarget, privileged });
  const concurrency = createModelConcurrency({ mode, sshTarget, privileged, collect: concurrencyCollect, now });
  let record = { scannedAt: null, lastAttemptAt: null, error: null, warnings: [], models: [], hosts: [], coverage: { hostsChecked: 0, endpointsChecked: 0, filesChecked: 0, notes: [] } };
  let pending = null, scanning = false, closed = false;
  const controller = new AbortController();
  const initialized = (async () => {
    try {
      const input = await readFile(filename, 'utf8');
      if (Buffer.byteLength(input) > MAX_OUTPUT) return;
      const saved = JSON.parse(input);
      if (!saved.scannedAt || !Number.isFinite(Date.parse(saved.scannedAt))) return;
      record = { ...validateResult(saved), scannedAt: saved.scannedAt, lastAttemptAt: saved.lastAttemptAt || saved.scannedAt };
    } catch { /* First use or invalid snapshot: perform a fresh scan. */ }
  })();
  const benchmark = createCatalogBenchmark({ dataDir, readCatalog: read, mode });
  function snapshot() {
    return structuredClone({ ...record, scanning, stale: !record.scannedAt || !!record.error || now() - Date.parse(record.scannedAt) >= ttlMs });
  }
  async function persist(next) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(filename + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(filename + '.tmp', filename);
  }
  async function refresh() {
    await initialized;
    if (closed || pending) return snapshot();
    scanning = true;
    record.lastAttemptAt = new Date(now()).toISOString();
    pending = (async () => {
      try {
        const result = validateResult(await collector({ signal: controller.signal }));
        if (closed) return;
        const failedEndpoints = new Set((result.coverage.endpoints || []).filter(endpoint => endpoint.status === 'unreachable').map(endpoint => endpoint.endpoint));
        const currentIds = new Set(result.models.map(model => model.id));
        for (const previous of record.models) {
          if (currentIds.has(previous.id) || !failedEndpoints.has(previous.endpoint)) continue;
          result.models.push({ ...previous, status: 'unreachable', loadedFromAPI: false, lastSeenAt: previous.lastSeenAt || previous.checkedAt,
            evidence: [...previous.evidence.filter(item => item.kind !== 'last-seen'), { kind: 'last-seen', source: previous.endpoint, detail: 'Son taramada bu servis yanıt vermedi. Önceki doğrulanmış model kaydı korunuyor.' }] });
        }
        // An unavailable collector must never turn a previous inventory into a
        // successful empty list. Keep its last known models and timestamp.
        if (result.error && !result.models.length && record.models.length) {
          record = { ...record, error: result.error, warnings: result.warnings, hosts: result.hosts, coverage: result.coverage };
        } else {
          record = { ...result, scannedAt: new Date(now()).toISOString(), lastAttemptAt: record.lastAttemptAt };
        }
        try { await persist(record); }
        catch { record.warnings = [...record.warnings, 'Envanter görülebiliyor, ancak diske kaydedilemedi.']; }
      } catch {
        if (!closed) record.error = 'Model envanteri taraması tamamlanamadı. Son başarılı kayıt varsa gösteriliyor.';
      } finally { scanning = false; pending = null; }
    })();
    return snapshot();
  }
  async function read({ refreshStale = true } = {}) {
    await initialized;
    // Back off on failed attempts too; polling does not create a retry storm.
    if (refreshStale && !closed && !pending && (!record.lastAttemptAt || now() - Date.parse(record.lastAttemptAt) >= ttlMs)) return refresh();
    return snapshot();
  }
  async function waitForIdle() { await initialized; await pending; return snapshot(); }
  async function shutdown() { closed = true; controller.abort(); await Promise.all([pending, concurrency.shutdown(), benchmark.shutdown()]); }
  return { read, refresh, waitForIdle, shutdown, readConcurrency: concurrency.read, benchmark };
}

/** Mount behind the application's existing authentication and CSRF middleware. */
export function modelCatalogRouter(store) {
  const router = express.Router();
  router.use('/benchmark', modelBenchmarkRouter(store.benchmark));
  router.get('/', async (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(await store.read()); });
  router.get('/concurrency', async (req, res) => {
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'İzlenecek servisler istemciden değiştirilemez.' });
    res.set('Cache-Control', 'no-store'); res.json(await store.readConcurrency());
  });
  router.post('/refresh', async (req, res) => {
    if (Object.keys(req.query || {}).length || (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) return res.status(400).json({ error: 'Tarama hedefi ve komutlar istemciden değiştirilemez.' });
    res.set('Cache-Control', 'no-store');
    res.status(202).json(await store.refresh());
  });
  return router;
}
