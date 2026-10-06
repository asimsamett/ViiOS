import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const queues = new Map();
const MAX_BYTES = 16 * 1024 * 1024;
const AAD = Buffer.from('all-management/application-credentials/v1');
const IMPORT_FIELDS = ['name', 'url', 'username', 'password', 'note'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const unavailable = () => fail('Uygulama şifreleri okunamadı veya kaydedilemedi. Mevcut kayıtlar korunuyor; şifre dosyası ve anahtarını kontrol edin.', 503);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    fail('Eksik veya beklenmeyen uygulama bilgisi.');
}
function field(value, limit, label, { empty = false, multiline = false, trim = true } = {}) {
  if (typeof value !== 'string' || value.length > limit || /\p{Cc}/u.test(multiline ? value.replace(/[\r\n\t]/g, '') : value)) fail(`Geçersiz ${label}.`);
  const result = trim ? value.trim() : value;
  if (!empty && !result) fail(`Geçersiz ${label}.`);
  return result;
}
function password(value) {
  // Passwords are opaque: preserve whitespace and Unicode exactly.
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) fail('Geçersiz şifre.');
  return value;
}
function address(value) {
  const result = field(value, 2048, 'yönetim paneli adresi');
  try {
    const url = new URL(result);
    if (!/^https?:\/\//i.test(result) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
  } catch { fail('Yönetim paneli adresi kullanıcı bilgisi içermeyen bir HTTP veya HTTPS adresi olmalı.'); }
  return result;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Geçersiz uygulama şifreleri sürümü.');
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('Geçersiz uygulama kimliği.');
  return value;
}
function details(body) {
  keys(body, ['revision', 'name', 'url', 'username'], ['password', 'note']);
  revision(body.revision);
  return {
    name: field(body.name, 200, 'uygulama adı'),
    url: address(body.url),
    username: field(body.username, 256, 'kullanıcı adı', { empty: true }),
    ...(Object.hasOwn(body, 'password') ? { password: password(body.password) } : {}),
    note: field(Object.hasOwn(body, 'note') ? body.note : '', 2000, 'not', { empty: true, multiline: true }),
  };
}
function panelAccount(entry) {
  const url = new URL(entry.url);
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return JSON.stringify([url.href, entry.username]);
}
function importedEntry(value) {
  keys(value, ['name', 'url', 'username'], ['sourceId', 'password', 'note']);
  const { sourceId, ...body } = value;
  const entry = details({ revision: 0, ...body });
  // A scanner that cannot recover a secret omits it. Empty discovered values
  // are also treated as unknown; only an explicit user edit can clear a secret.
  if (!entry.password) delete entry.password;
  if (!Object.hasOwn(value, 'note')) delete entry.note;
  const identity = panelAccount(entry);
  return {
    ...entry,
    sourceId: sourceId === undefined ? `panel:${createHash('sha256').update(identity).digest('hex')}` : field(sourceId, 512, 'kaynak kimliği'),
    identity,
  };
}
function validateSource(value) {
  keys(value, ['id', 'lastImported', 'overrides']);
  if (field(value.id, 512, 'kaynak kimliği') !== value.id) fail('Geçersiz kaynak kimliği.');
  keys(value.lastImported, ['name', 'url', 'username'], ['password', 'note']);
  const normalized = details({ revision: 0, ...value.lastImported });
  if (Object.keys(value.lastImported).some(key => normalized[key] !== value.lastImported[key])) fail('Geçersiz kaynak kaydı.');
  validateOverrides(value.overrides);
}
function validateOverrides(value) {
  if (!Array.isArray(value) || value.some(key => !IMPORT_FIELDS.includes(key)) || new Set(value).size !== value.length) fail('Geçersiz elle düzenleme kaydı.');
}
function validateState(state) {
  keys(state, ['revision', 'entries']); revision(state.revision);
  if (!Array.isArray(state.entries) || state.entries.length > 1000) fail('Uygulama kayıt sınırı aşıldı.');
  const ids = new Set();
  for (const entry of state.entries) {
    keys(entry, ['id', 'name', 'url', 'username', 'password', 'note', 'updatedAt'], ['source', 'manualOverrides']);
    identifier(entry.id);
    if (ids.has(entry.id)) fail('Tekrarlanan uygulama kimliği.');
    ids.add(entry.id);
    const validated = details({ revision: state.revision, name: entry.name, url: entry.url, username: entry.username, password: entry.password, note: entry.note });
    if (Object.entries(validated).some(([key, value]) => value !== entry[key])) fail('Geçersiz uygulama kaydı.');
    if (typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt)) || new Date(entry.updatedAt).toISOString() !== entry.updatedAt) fail('Geçersiz kayıt tarihi.');
    if (entry.source !== undefined) validateSource(entry.source);
    if (entry.manualOverrides !== undefined) {
      if (entry.source !== undefined) fail('Geçersiz elle düzenleme kaydı.');
      validateOverrides(entry.manualOverrides);
    }
  }
  return state;
}
function publicState(state) {
  return { revision: state.revision, entries: state.entries.map(({ password: secret, source: _source, manualOverrides: _manualOverrides, ...entry }) => ({ ...entry, hasPassword: secret.length > 0 })) };
}
function serialized(file, operation) {
  const result = (queues.get(file) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(file, result);
  const clear = () => { if (queues.get(file) === result) queues.delete(file); };
  void result.then(clear, clear);
  return result;
}

async function restrictFile(file) {
  // Linux deployment uses owner-only files. Windows development inherits the
  // profile directory ACL: Node mode bits do not change Windows access rules.
  if (process.platform !== 'win32') await chmod(file, 0o600);
}
async function readBounded(file, maximum) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid credential file.');
    return await handle.readFile();
  } finally { await handle.close(); }
}
function decode(value, length) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid encrypted value.');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || length !== undefined && result.length !== length) throw new Error('Invalid encrypted value.');
  return result;
}

export function createAppCredentialStore({ dataDir }) {
  const directory = path.resolve(dataDir), file = path.join(directory, 'app-credentials.enc.json'), keyFile = path.join(directory, 'app-credentials.key');
  async function key(create = false) {
    try {
      const value = await readBounded(keyFile, 32);
      if (value.length !== 32) throw new Error('Invalid key.');
      if (create) await restrictFile(keyFile);
      return value;
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      const value = randomBytes(32);
      await writeFile(keyFile, value, { flag: 'wx', mode: 0o600, flush: true });
      await restrictFile(keyFile);
      return value;
    }
  }
  async function load() {
    let bytes;
    try { bytes = await readBounded(file, MAX_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return { revision: 0, entries: [] }; unavailable(); }
    try {
      const stored = JSON.parse(bytes.toString('utf8'));
      keys(stored, ['version', 'algorithm', 'iv', 'tag', 'ciphertext']);
      if (stored.version !== 1 || stored.algorithm !== 'aes-256-gcm') throw new Error('Invalid envelope.');
      const decipher = createDecipheriv('aes-256-gcm', await key(), decode(stored.iv, 12));
      decipher.setAAD(AAD); decipher.setAuthTag(decode(stored.tag, 16));
      const cleartext = Buffer.concat([decipher.update(decode(stored.ciphertext)), decipher.final()]);
      return validateState(JSON.parse(cleartext.toString('utf8')));
    } catch { unavailable(); }
  }
  async function persist(state) {
    const temporary = path.join(directory, `app-credentials.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(true), iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
      const stored = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      if (Buffer.byteLength(stored) > MAX_BYTES) throw new Error('Credential file too large.');
      await writeFile(temporary, stored + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await restrictFile(temporary);
      await rename(temporary, file);
    } catch { unavailable(); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function mutate(expectedRevision, change) {
    revision(expectedRevision);
    return serialized(file, async () => {
      const state = await load();
      if (state.revision !== expectedRevision) fail('Uygulama bilgileri başka bir oturumda değişti. Güncel kayıtları inceleyip yeniden deneyin.', 409);
      if (state.revision === Number.MAX_SAFE_INTEGER) fail('Uygulama kayıt sürümü sınırına ulaşıldı.', 409);
      const next = change(state); next.revision = state.revision + 1;
      validateState(next); await persist(next);
      return publicState(next);
    });
  }
  return {
    read: () => serialized(file, async () => publicState(await load())),
    create(body) {
      const entry = details(body);
      return mutate(body.revision, state => {
        if (state.entries.length >= 1000) fail('En fazla 1000 uygulama kaydedilebilir.');
        return { ...state, entries: [...state.entries, { id: randomUUID(), password: '', ...entry, updatedAt: new Date().toISOString() }] };
      });
    },
    update(id, body) {
      identifier(id); const entry = details(body);
      return mutate(body.revision, state => {
        if (!state.entries.some(row => row.id === id)) fail('Uygulama bulunamadı.', 404);
        return { ...state, entries: state.entries.map(row => {
          if (row.id !== id) return row;
          const changed = IMPORT_FIELDS.filter(key => Object.hasOwn(entry, key) && entry[key] !== row[key]);
          const overrides = row.source
            ? { source: { ...row.source, overrides: [...new Set([...row.source.overrides, ...changed])] } }
            : changed.length || row.manualOverrides ? { manualOverrides: [...new Set([...(row.manualOverrides || []), ...changed])] } : {};
          return { ...row, ...entry, ...overrides, updatedAt: new Date().toISOString() };
        }) };
      });
    },
    mergeDiscovered(values) {
      if (!Array.isArray(values) || values.length > 5000) fail('Geçersiz keşif sonuçları.');
      const discovered = new Map(), sourceIds = new Map();
      for (const value of values) {
        const entry = importedEntry(value), priorIdentity = sourceIds.get(entry.sourceId);
        if (priorIdentity && priorIdentity !== entry.identity) fail('Aynı kaynak için birden fazla hesap bulundu.');
        sourceIds.set(entry.sourceId, entry.identity);
        const prior = discovered.get(entry.identity);
        if (!prior) discovered.set(entry.identity, entry);
        else if (!prior.password && entry.password) prior.password = entry.password;
      }
      return serialized(file, async () => {
        // Discovery can run for minutes. Read after it finishes so a concurrent
        // manual edit is merged against the latest values and override markers.
        const state = await load(), counts = { added: 0, updated: 0, unchanged: 0 };
        let dirty = false;
        for (const value of discovered.values()) {
          const { sourceId, identity, ...snapshot } = value;
          let row = state.entries.find(entry => entry.source?.id === sourceId)
            || state.entries.find(entry => !entry.source && panelAccount(entry) === identity);
          if (!row) {
            if (state.entries.length >= 1000) fail('En fazla 1000 uygulama kaydedilebilir.');
            row = { id: randomUUID(), password: '', note: '', ...snapshot, updatedAt: new Date().toISOString(), source: { id: sourceId, lastImported: snapshot, overrides: [] } };
            state.entries.push(row); counts.added++; dirty = true; continue;
          }
          const previous = JSON.stringify(row);
          if (!row.source) {
            // Only exact matches with today's authoritative source establish an
            // automatic baseline. Differing nonempty manual values stay owned
            // by the user, including an unverified legacy password.
            row.source = { id: sourceId, lastImported: snapshot, overrides: [...new Set([...(row.manualOverrides || []), ...IMPORT_FIELDS.filter(key => row[key] !== '' && row[key] !== snapshot[key])])] };
            delete row.manualOverrides;
          }
          let changed = false;
          for (const key of IMPORT_FIELDS) {
            if (!Object.hasOwn(snapshot, key) || row.source.overrides.includes(key) || row[key] === snapshot[key]) continue;
            if (key === 'username' && !snapshot[key] && row[key]) continue;
            row[key] = snapshot[key]; changed = true;
          }
          row.source.lastImported = { ...row.source.lastImported, ...snapshot };
          if (changed) { row.updatedAt = new Date().toISOString(); counts.updated++; }
          else counts.unchanged++;
          if (JSON.stringify(row) !== previous) dirty = true;
        }
        if (dirty) {
          if (state.revision === Number.MAX_SAFE_INTEGER) fail('Uygulama kayıt sürümü sınırına ulaşıldı.', 409);
          state.revision++; validateState(state); await persist(state);
        }
        return { ...counts, revision: state.revision };
      });
    },
    delete(id, body) {
      identifier(id); keys(body, ['revision']);
      return mutate(body.revision, state => {
        if (!state.entries.some(row => row.id === id)) fail('Uygulama bulunamadı.', 404);
        return { ...state, entries: state.entries.filter(row => row.id !== id) };
      });
    },
    reveal(id) {
      identifier(id);
      return serialized(file, async () => {
        const entry = (await load()).entries.find(row => row.id === id);
        if (!entry) fail('Uygulama bulunamadı.', 404);
        return { password: entry.password };
      });
    },
  };
}

export function appCredentialsRouter(store, { sync } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  if (sync) {
    router.get('/sync', async (_req, res) => res.json(await sync.status()));
    router.post('/sync', async (req, res) => {
      if (req.body !== undefined) keys(req.body, []);
      res.status(202).json(await sync.trigger('manual'));
    });
  }
  router.get('/', async (_req, res) => res.json(await store.read()));
  router.post('/', async (req, res) => res.status(201).json(await store.create(req.body)));
  router.put('/:id', async (req, res) => res.json(await store.update(req.params.id, req.body)));
  router.delete('/:id', async (req, res) => res.json(await store.delete(req.params.id, req.body)));
  router.post('/:id/reveal', async (req, res) => { if (req.body !== undefined) keys(req.body, []); res.json(await store.reveal(req.params.id)); });
  return router;
}
