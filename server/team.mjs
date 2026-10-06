import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const queues = new Map();
const limits = { people: 300, assignments: 3000, projectAssignments: 60 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected) {
  if (!plain(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
    fail('Eksik veya beklenmeyen ekip bilgisi.');
}
function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || !value.trim() || /\p{Cc}/u.test(value))
    fail(`Geçersiz ${label}.`);
  return value.trim();
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('Geçersiz kişi veya atama kimliği.');
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Geçersiz ekip sürümü.');
  return value;
}
function serverId(value) {
  if (typeof value !== 'string' || !/^srv-[a-f0-9]{24}$/.test(value))
    fail('Geçersiz sunucu kimliği.');
  return value;
}
function projectPath(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.includes('\\') || /\p{Cc}/u.test(value) || value.split('/').some(part => part === '.' || part === '..'))
    fail('Geçersiz proje klasörü.');
  return value;
}
function scope(value) {
  return {
    serverId: serverId(value.serverId),
    projectId: text(value.projectId, 2048, 'proje kimliği'),
    projectName: text(value.projectName, 200, 'proje adı'),
    projectPath: projectPath(value.projectPath),
  };
}
function assignment(value) {
  keys(value, ['personId', 'role', 'serviceKey', 'serviceLabel']);
  const serviceKey = value.serviceKey === null ? null : text(value.serviceKey, 256, 'servis kimliği');
  const serviceLabel = value.serviceLabel === null ? null : text(value.serviceLabel, 200, 'servis adı');
  if (serviceKey === null && serviceLabel !== null) fail('Servis adı için servis kimliği gerekiyor.');
  return { personId: identifier(value.personId), role: text(value.role, 80, 'rol'), serviceKey, serviceLabel };
}
const assignmentKey = value => JSON.stringify([value.personId, value.role, value.serviceKey]);
const scopeKey = value => JSON.stringify([value.serverId, value.projectId]);
function validateState(value) {
  keys(value, ['revision', 'people', 'assignments']);
  revision(value.revision);
  if (!Array.isArray(value.people) || value.people.length > limits.people || !Array.isArray(value.assignments) || value.assignments.length > limits.assignments)
    fail('Ekip kayıt sınırı aşıldı.');
  const people = new Set();
  for (const person of value.people) {
    keys(person, ['id', 'name']);
    identifier(person.id);
    if (people.has(person.id) || text(person.name, 100, 'kişi adı') !== person.name) fail('Geçersiz kişi kaydı.');
    people.add(person.id);
  }
  const ids = new Set(), entries = new Set(), scopes = new Map();
  for (const row of value.assignments) {
    keys(row, ['id', 'serverId', 'projectId', 'projectName', 'projectPath', 'personId', 'role', 'serviceKey', 'serviceLabel']);
    identifier(row.id);
    const normalizedScope = scope(row);
    const normalized = assignment({ personId: row.personId, role: row.role, serviceKey: row.serviceKey, serviceLabel: row.serviceLabel });
    if (Object.entries({ ...normalizedScope, ...normalized }).some(([key, field]) => row[key] !== field)) fail('Geçersiz atama kaydı.');
    const key = scopeKey(row), duplicate = JSON.stringify([key, assignmentKey(row)]);
    if (ids.has(row.id) || entries.has(duplicate) || !people.has(row.personId)) fail('Geçersiz kişi ataması.');
    const prior = scopes.get(key);
    if (prior && (prior.name !== row.projectName || prior.path !== row.projectPath)) fail('Tutarsız proje bilgisi.');
    const count = (prior?.count || 0) + 1;
    if (count > limits.projectAssignments) fail('Proje ekip sınırı aşıldı.');
    scopes.set(key, { name: row.projectName, path: row.projectPath, count });
    ids.add(row.id); entries.add(duplicate);
  }
  return value;
}
function serialized(file, operation) {
  const result = (queues.get(file) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(file, result);
  const clear = () => { if (queues.get(file) === result) queues.delete(file); };
  void result.then(clear, clear);
  return result;
}

export function createTeamStore({ dataDir, resolveServer }) {
  const directory = path.resolve(dataDir), file = path.join(directory, 'team.json');
  async function load() {
    let handle;
    try {
      handle = await open(file, 'r');
      if ((await handle.stat()).size > 32 * 1024 * 1024) fail('Ekip kayıt dosyası sınırı aşıldı.');
      return validateState(JSON.parse(await handle.readFile('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { revision: 0, people: [], assignments: [] };
      fail('Ekip kayıt dosyası okunamadı veya bozuk. Kayıtlar korunuyor; dosya düzeltildikten sonra yeniden deneyin.', 503);
    } finally {
      await handle?.close();
    }
  }
  async function persist(state) {
    const temp = path.join(directory, `team.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
      await rename(temp, file);
    } catch {
      fail('Ekip bilgileri kaydedilemedi. Mevcut kayıtlar korunuyor; yeniden deneyin.', 503);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
  function mutate(expectedRevision, change) {
    revision(expectedRevision);
    return serialized(file, async () => {
      const state = await load();
      if (state.revision !== expectedRevision)
        fail('Ekip bilgileri başka bir oturumda değişti. Güncel kayıtları inceleyip yeniden deneyin.', 409);
      if (state.revision === Number.MAX_SAFE_INTEGER) fail('Ekip sürüm sınırına ulaşıldı.', 409);
      const next = change(state);
      next.revision = state.revision + 1;
      validateState(next);
      await persist(next);
      return structuredClone(next);
    });
  }
  return {
    read: () => serialized(file, async () => structuredClone(await load())),
    addPerson(body) {
      keys(body, ['revision', 'name']);
      const name = text(body.name, 100, 'kişi adı');
      return mutate(body.revision, state => {
        if (state.people.length >= limits.people) fail('En fazla 300 kişi eklenebilir.');
        return { ...state, people: [...state.people, { id: randomUUID(), name }] };
      });
    },
    renamePerson(id, body) {
      identifier(id); keys(body, ['revision', 'name']);
      const name = text(body.name, 100, 'kişi adı');
      return mutate(body.revision, state => {
        if (!state.people.some(person => person.id === id)) fail('Kişi bulunamadı.', 404);
        return { ...state, people: state.people.map(person => person.id === id ? { ...person, name } : person) };
      });
    },
    deletePerson(id, body) {
      identifier(id); keys(body, ['revision']);
      return mutate(body.revision, state => {
        if (!state.people.some(person => person.id === id)) fail('Kişi bulunamadı.', 404);
        if (state.assignments.some(row => row.personId === id)) fail('Bu kişi projelerde görevli. Silmeden önce proje ve servis atamalarını kaldırın.', 409);
        return { ...state, people: state.people.filter(person => person.id !== id) };
      });
    },
    replaceAssignments(body) {
      keys(body, ['revision', 'serverId', 'projectId', 'projectName', 'projectPath', 'assignments']);
      const project = scope(body);
      if (!Array.isArray(body.assignments) || body.assignments.length > limits.projectAssignments) fail('Bir projeye en fazla 60 görev atanabilir.');
      const rows = body.assignments.map(assignment), duplicates = new Set();
      for (const row of rows) {
        const key = assignmentKey(row);
        if (duplicates.has(key)) fail('Aynı kişi, rol ve servis birden fazla kez atanamaz.');
        duplicates.add(key);
      }
      return mutate(body.revision, state => {
        resolveServer(project.serverId);
        const people = new Set(state.people.map(person => person.id));
        if (rows.some(row => !people.has(row.personId))) fail('Atanan kişilerden biri bulunamadı. Güncel kişi listesini kontrol edin.');
        const belongs = row => row.serverId === project.serverId && row.projectId === project.projectId;
        const previous = new Map(state.assignments.filter(belongs).map(row => [assignmentKey(row), row.id]));
        const remaining = state.assignments.filter(row => !belongs(row));
        if (remaining.length + rows.length > limits.assignments) fail('Toplam 3000 görev atama sınırına ulaşıldı.');
        return { ...state, assignments: [...remaining, ...rows.map(row => ({ id: previous.get(assignmentKey(row)) || randomUUID(), ...project, ...row }))] };
      });
    },
  };
}

export function teamRouter(store) {
  const router = express.Router();
  router.get('/', async (_req, res) => res.json(await store.read()));
  router.post('/people', async (req, res) => res.status(201).json(await store.addPerson(req.body)));
  router.patch('/people/:id', async (req, res) => res.json(await store.renamePerson(req.params.id, req.body)));
  router.delete('/people/:id', async (req, res) => res.json(await store.deletePerson(req.params.id, req.body)));
  router.put('/assignments', async (req, res) => res.json(await store.replaceAssignments(req.body)));
  return router;
}
