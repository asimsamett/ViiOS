import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const MAX_BYTES = 256 * 1024;
const stores = new Map();
const views = new Set(['managed', 'apps', 'ports', 'reports', 'help', 'endpoints', 'people', 'models', 'servers', 'credentials', 'storage', 'overview', 'processes', 'services', 'history', 'notifications', 'versions', 'guide', 'appearance', 'features']);
const fixedKinds = new Set(['applications', 'trash', 'tasks', 'repo', 'knowledge']);
const uuidId = /^link:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw fail('Masaüstü düzeninin alanları geçersiz.');
  }
}

function string(value, max, label, { trim = false, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail(`${label} geçersiz veya çok uzun.`);
  const result = trim ? value.trim() : value;
  if (!empty && !result.length) throw fail(`${label} boş bırakılamaz.`);
  return result;
}

function item(value) {
  fields(value, ['id', 'kind', 'label'], ['detail', 'openedAt', 'port', 'path', 'projectId', 'view', 'url']);
  string(value.id, 4110, 'Kısayol kimliği');
  const result = { id: '', kind: value.kind, label: string(value.label, 255, 'Kısayol adı', { trim: true }) };
  let payload;
  if (fixedKinds.has(value.kind)) result.id = value.kind;
  else if (value.kind === 'app') {
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw fail('Uygulama portu geçersiz.');
    result.port = value.port;
    result.id = `app:${value.port}`;
    payload = 'port';
  } else if (value.kind === 'folder' || value.kind === 'file') {
    result.path = string(value.path, 4096, 'Dosya yolu');
    if (!path.posix.isAbsolute(result.path) && !/^[a-z]:[\\/]/i.test(result.path) && !/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(result.path)) throw fail('Dosya yolu mutlak bir Linux veya Windows yolu olmalıdır.');
    result.id = `${value.kind}:${result.path}`;
    payload = 'path';
  } else if (value.kind === 'project') {
    result.projectId = string(value.projectId, 4096, 'Proje kimliği');
    result.id = `project:${result.projectId}`;
    payload = 'projectId';
  } else if (value.kind === 'action') {
    if (!views.has(value.view)) throw fail('Kısayol görünümü geçersiz.');
    result.view = value.view;
    result.id = `action:${value.view}`;
    payload = 'view';
  } else if (value.kind === 'link') {
    if (!uuidId.test(value.id)) throw fail('Bağlantı kimliği geçersiz.');
    const source = string(value.url, 2048, 'Bağlantı adresi', { trim: true });
    let url;
    try { url = new URL(source); } catch { throw fail('Geçerli bir HTTP veya HTTPS adresi girin.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\p{Cc}/u.test(source)) throw fail('Bağlantı yalnızca kullanıcı bilgisi içermeyen HTTP veya HTTPS adresi olabilir.');
    result.url = string(url.href, 2048, 'Bağlantı adresi');
    result.id = value.id.toLowerCase();
    payload = 'url';
  } else throw fail('Kısayol türü geçersiz.');
  if (['port', 'path', 'projectId', 'view', 'url'].some(key => Object.hasOwn(value, key) && key !== payload)) throw fail('Kısayol türüyle uyuşmayan alan bulundu.');
  if (Object.hasOwn(value, 'detail')) result.detail = string(value.detail, 4096, 'Kısayol açıklaması', { empty: true });
  if (Object.hasOwn(value, 'openedAt')) {
    if (typeof value.openedAt !== 'number' || !Number.isFinite(value.openedAt) || value.openedAt < 0) throw fail('Kısayol zamanı geçersiz.');
    result.openedAt = value.openedAt;
  }
  return result;
}

function list(value, max) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > max) throw fail(`Kısayol listesi en fazla ${max} kayıt içerebilir.`);
  const result = value.map(item);
  if (new Set(result.map(entry => entry.id)).size !== result.length) throw fail('Aynı listede yinelenen kısayol kimliği var.');
  return result;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Masaüstü düzeni sürümü geçersiz.');
  return value;
}

function serialized(state) {
  const raw = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw fail('Masaüstü düzeni toplam 256 KB sınırını aşıyor.');
  return raw;
}

export function createDesktopLayoutStore({ dataDir }) {
  const filename = path.resolve(dataDir, 'desktop-layout.json');
  // Primary and named target routers share both the store and its write queue.
  if (stores.has(filename)) return stores.get(filename);
  let pending = Promise.resolve();
  const enqueue = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };

  async function readState() {
    let handle;
    try {
      handle = await open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid layout file size');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > MAX_BYTES) throw new Error('Invalid layout file size');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      fields(value, ['version', 'revision', 'dock', 'desktop']);
      if (value.version !== 1) throw new Error('Unsupported layout version');
      const state = { version: 1, revision: revision(value.revision), dock: list(value.dock, 32), desktop: list(value.desktop, 16) };
      for (const key of ['dock', 'desktop']) {
        if (state[key]?.some((entry, index) => Object.entries(entry).some(([field, content]) => value[key][index][field] !== content))) throw new Error('Noncanonical layout item');
      }
      return state;
    } catch (error) {
      if (!handle && error.code === 'ENOENT') return { version: 1, revision: 0, dock: null, desktop: null };
      throw fail('Kayıtlı masaüstü düzeni okunamadı. Mevcut dosya korunuyor.', 503);
    } finally { await handle?.close(); }
  }

  async function writeState(state) {
    const raw = serialized(state);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
      // POSIX modes restrict new files; Windows uses inherited directory permissions.
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, filename);
    } catch { throw fail('Masaüstü düzeni kaydedilemedi. Yeniden deneyin.', 503); }
    finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  const store = {
    read: () => enqueue(readState),
    async save(body) {
      fields(body, ['revision', 'dock', 'desktop']);
      const expected = revision(body.revision);
      const dock = list(body.dock, 32), desktop = list(body.desktop, 16);
      return enqueue(async () => {
        const current = await readState();
        if (current.revision !== expected) throw fail('Masaüstü düzeni başka bir oturumda değişti. Güncel düzeni yükleyip yeniden deneyin.', 409);
        if (current.revision === Number.MAX_SAFE_INTEGER) throw fail('Masaüstü düzeni sürüm sınırına ulaştı.', 503);
        const state = { version: 1, revision: current.revision + 1, dock, desktop };
        await writeState(state);
        return state;
      });
    },
  };
  stores.set(filename, store);
  return store;
}

export function desktopLayoutRouter(store) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const respond = action => async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Masaüstü düzenine erişilemiyor.' }); }
  };
  router.get('/', respond(() => store.read()));
  router.put('/', respond(req => store.save(req.body)));
  return router;
}
