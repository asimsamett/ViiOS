import { readFile } from 'node:fs/promises';
import express from 'express';
import { createModelBenchmark } from './model-benchmark.mjs';

const rejected = (message, status = 400) => Object.assign(new Error(message), { status });

/** Pure matching: a disk artifact or a client-provided address is never a test target. */
export function benchmarkTargets(catalog, configuration) {
  const endpoints = new Map();
  const ids = new Map();
  for (const model of catalog?.models || []) ids.set(model.id, (ids.get(model.id) || 0) + 1);
  for (const item of configuration?.endpoints || []) {
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) continue;
      if (!configuration.allowedHosts?.includes(url.hostname)) continue;
      const runtime = item.runtime === 'Ollama' ? 'ollama' : item.runtime === 'OpenAI uyumlu' ? 'openai' : null;
      if (!runtime || !['', '/', '/v1', '/v1/'].includes(url.pathname)) continue;
      endpoints.set(url.origin, { endpoint: runtime === 'ollama' ? url.origin : `${url.origin}/v1`, runtime });
    } catch { /* Invalid administrator configuration is not a candidate. */ }
  }
  return (catalog?.models || []).flatMap(model => {
    if (ids.get(model.id) !== 1 || !['language', 'llm', 'multimodal'].includes(model.kind) || typeof model.id !== 'string' || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200) return [];
    try {
      const address = new URL(model.endpoint);
      if (address.username || address.password || address.search || address.hash || !['', '/', '/v1', '/v1/'].includes(address.pathname)) return [];
      const trusted = endpoints.get(address.origin);
      if (!trusted) return [];
      const sources = trusted.runtime === 'ollama' ? ['/api/tags', '/api/ps'] : ['/v1/models'];
      const verified = (model.evidence || []).some(item => item.kind === 'api' && sources.some(suffix => item.source === `${address.origin}${suffix}`));
      if (!verified) return [];
      return [{ id: model.id, name: model.name, model: model.name, status: model.status, ...trusted }];
    } catch { return []; }
  });
}

/** Construction, options and history only read local files. start is the sole inference entry. */
export function createCatalogBenchmark({ dataDir, readCatalog, mode = 'ssh', configFile = new URL('./model-catalog-targets.json', import.meta.url) }) {
  async function candidates() {
    let configuration;
    try { configuration = JSON.parse(await readFile(configFile, 'utf8')); }
    catch { throw rejected('Kayıtlı test hedefleri okunamadı.', 503); }
    const catalog = await readCatalog({ refreshStale: false });
    return { scannedAt: catalog.scannedAt, models: benchmarkTargets(catalog, configuration) };
  }
  const engine = createModelBenchmark({
    dataDir,
    resolveModel: async id => {
      // 127.0.0.1 belongs to the catalog's server, not an SSH-mode developer workstation.
      if (mode !== 'local') throw rejected('Bu dağıtımda model yük testi etkinleştirilmedi.', 409);
      const selected = (await candidates()).models.find(model => model.id === id);
      if (!selected) throw rejected('Model kayıtlı ve doğrulanmış test hedefleri arasında bulunamadı.');
      return selected;
    },
  });
  return {
    ...engine,
    async options() {
      const saved = await candidates();
      return {
        ...saved,
        canStart: mode === 'local',
        unavailableReason: mode === 'local' ? null : 'Bu dağıtımda model yük testi etkinleştirilmedi.',
      };
    },
  };
}

/** Mounted after existing session and same-origin write protections. No handler probes models. */
export function modelBenchmarkRouter(store) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'Test hedefi sorgu parametreleriyle değiştirilemez.' });
    next();
  });
  router.get('/options', async (_req, res) => res.json(await store.options()));
  router.get('/runs', async (_req, res) => res.json(await store.list()));
  router.get('/runs/:id', async (req, res) => {
    const run = await store.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Test kaydı bulunamadı.' });
    res.json(run);
  });
  router.post('/runs', async (req, res) => res.status(202).json(await store.start(req.body)));
  router.post('/runs/:id/cancel', async (req, res) => {
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) return res.status(400).json({ error: 'Durdurma isteği ek parametre içeremez.' });
    const run = await store.cancel(req.params.id);
    if (!run) return res.status(404).json({ error: 'Test kaydı bulunamadı.' });
    res.json(run);
  });
  router.use((error, _req, res, _next) => {
    const status = [400, 404, 409, 503].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Kapasite testi işlemi tamamlanamadı.' : error.message });
  });
  return router;
}
