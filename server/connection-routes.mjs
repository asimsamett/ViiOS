import express from 'express';
import { CONNECTION_ID, connectionError, createConnectionStore } from './connection-store.mjs';
import { bootstrapConnection } from './connection-bootstrap.mjs';
import { closeManagedConnection, configureManagedTransport, probeHost, shutdownManagedTransport } from './ssh-transport.mjs';

function sudoInput(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw connectionError('INVALID_SUDO_PASSWORD', 'Sudo şifresi geçersiz.');
  return value;
}

export function createConnectionManager({ dataDir, onReady = async () => {}, onRemove = async () => {}, store: providedStore, bootstrap = bootstrapConnection, probe = probeHost, maxConcurrent = 2 } = {}) {
  const store = providedStore || createConnectionStore({ dataDir });
  const jobs = new Map(), queue = [], operations = new Map();
  let closed = false, active = 0;
  const required = id => {
    const profile = CONNECTION_ID.test(id || '') ? store.get(id) : null;
    if (!profile) throw connectionError('CONNECTION_NOT_FOUND', 'Sunucu bağlantısı bulunamadı.', 404);
    return profile;
  };
  function serial(id, action) {
    const operation = (operations.get(id) || Promise.resolve()).catch(() => {}).then(() => {
      if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
      required(id);
      return action();
    });
    operations.set(id, operation);
    const clean = () => { if (operations.get(id) === operation) operations.delete(id); };
    operation.then(clean, clean);
    return operation;
  }
  async function run(job) {
    const { id, controller } = job;
    const current = () => jobs.get(id) === job && !controller.signal.aborted && !closed && !!store.get(id);
    try {
      const capabilities = await bootstrap(store.getSecret(id), {
        sudoPassword: job.sudoPassword,
        signal: controller.signal,
        onProgress: async progress => {
          if (!current()) return;
          await store.patch(id, { ...progress, errorCode: null }, { guard: current });
        },
      });
      if (!current()) return;
      const profile = await store.patch(id, { status: 'ready', phase: 'complete', message: 'Sunucu yönetim için hazır.', capabilities, errorCode: null }, { guard: current });
      if (!profile || !current()) return;
      await onReady(profile);
    } catch (error) {
      if (current()) {
        const known = /^[A-Z_]+$/.test(error.code || '') && Number.isInteger(error.status);
        await store.patch(id, { status: 'error', phase: 'failed', message: known ? error.message : 'Sunucu hazırlanamadı. Bağlantı ve kurulum izinlerini kontrol edin.', errorCode: known ? error.code : 'BOOTSTRAP_FAILED' }, { guard: current }).catch(() => {});
      }
    } finally {
      job.sudoPassword = undefined;
      if (jobs.get(id) === job) jobs.delete(id);
      active--; job.resolve(); pump();
    }
  }
  function pump() {
    while (!closed && active < maxConcurrent && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) continue;
      active++;
      void run(job);
    }
  }
  function start(id, sudoPassword) {
    if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
    if (jobs.has(id)) return;
    const job = { id, sudoPassword, controller: new AbortController() };
    job.completion = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(id, job); queue.push(job); pump();
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    job.controller.abort();
    const index = queue.indexOf(job);
    if (index >= 0) { queue.splice(index, 1); jobs.delete(id); job.sudoPassword = undefined; job.resolve(); }
  }
  return {
    store,
    async initialize() {
      await store.initialize();
      configureManagedTransport(store);
      for (const profile of store.list()) {
        if (profile.status === 'ready') await onReady(profile);
        else if (['pending', 'installing'].includes(profile.status)) await store.patch(profile.id, { status: 'error', phase: 'interrupted', message: 'ViiOS kapanırken kurulum yarıda kaldı. Yeniden deneyin.', errorCode: 'INTERRUPTED' });
      }
    },
    list: () => store.list(),
    get: required,
    probe: input => probe(input),
    async add(input) {
      const sudoPassword = sudoInput(input?.sudoPassword);
      if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
      const profile = await store.add(input);
      start(profile.id, sudoPassword);
      return profile;
    },
    update(id, input) {
      const sudoPassword = sudoInput(input?.sudoPassword);
      return serial(id, async () => {
        let original = required(id);
        const prepared = await store.prepareUpdate(id, input);
        let committed = false;
        try {
          const completion = jobs.get(id)?.completion;
          cancel(id); closeManagedConnection(id);
          await completion;
          original = store.get(id) || original;
          if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
          // onRemove only stops target workers/caches; the same id keeps all data.
          await onRemove(id);
          if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
          const profile = await prepared.commit();
          committed = true;
          start(id, sudoPassword);
          return profile;
        } catch (error) {
          // A failed disk write must not strand a previously healthy target.
          if (!committed && original.status === 'ready' && !closed) await Promise.resolve().then(() => onReady(original)).catch(() => {});
          throw error;
        } finally { prepared.cancel(); }
      });
    },
    retry(id, input = {}) {
      const password = sudoInput(input.sudoPassword);
      return serial(id, async () => {
        if (jobs.has(id)) return store.get(id);
        closeManagedConnection(id);
        await onRemove(id);
        if (closed) throw connectionError('SHUTTING_DOWN', 'ViiOS kapatılıyor.', 503);
        const profile = await store.patch(id, { status: 'pending', phase: 'queued', message: 'Kurulum yeniden hazırlanıyor.', errorCode: null, capabilities: {} });
        start(id, password);
        return profile;
      });
    },
    remove(id) {
      return serial(id, async () => {
        const completion = jobs.get(id)?.completion;
        cancel(id); closeManagedConnection(id);
        await completion;
        await onRemove(id);
        return store.remove(id);
      });
    },
    async shutdown() {
      closed = true;
      for (const id of jobs.keys()) cancel(id);
      shutdownManagedTransport();
      await Promise.allSettled([...jobs.values()].map(job => job.completion));
      await Promise.allSettled(operations.values());
      await store.shutdown();
    },
  };
}

export function connectionRouter(manager) {
  const router = express.Router();
  const requests = new Map();
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const now = Date.now(), key = req.ip || 'local';
    for (const [ip, bucket] of requests) if (bucket.start + 60000 < now) requests.delete(ip);
    const bucket = requests.get(key) || { start: now, count: 0 };
    if (++bucket.count > 20) return res.status(429).json({ error: 'Çok fazla bağlantı işlemi. Bir dakika sonra yeniden deneyin.', code: 'RATE_LIMIT' });
    requests.set(key, bucket);
    next();
  });
  router.get('/', (_req, res) => res.json({ servers: manager.list() }));
  router.post('/probe', async (req, res, next) => { try { res.json(await manager.probe(req.body)); } catch (error) { next(error); } });
  router.post('/', async (req, res, next) => { try { res.status(202).json({ server: await manager.add(req.body) }); } catch (error) { next(error); } });
  router.get('/:id', (req, res, next) => { try { res.json({ server: manager.get(req.params.id) }); } catch (error) { next(error); } });
  router.put('/:id', async (req, res, next) => { try { res.status(202).json({ server: await manager.update(req.params.id, req.body) }); } catch (error) { next(error); } });
  router.post('/:id/retry', async (req, res, next) => { try { res.status(202).json({ server: await manager.retry(req.params.id, req.body || {}) }); } catch (error) { next(error); } });
  router.delete('/:id', async (req, res, next) => { try { res.json(await manager.remove(req.params.id)); } catch (error) { next(error); } });
  router.use((error, _req, res, _next) => {
    const known = Number.isInteger(error.status) && /^[A-Z_]+$/.test(error.code || '');
    res.status(known ? error.status : 500).json({ error: known ? error.message : 'Sunucu bağlantı işlemi tamamlanamadı.', code: known ? error.code : 'CONNECTION_FAILED' });
  });
  return router;
}
