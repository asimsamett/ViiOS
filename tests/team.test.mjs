import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createTeamStore, teamRouter } from '../server/team.mjs';
import { createAuth, hashPassword, protectWrites } from '../server/auth.mjs';

const empty = () => ({ revision: 0, people: [], assignments: [] });
const resolveServer = id => {
  if (!['srv-111111111111111111111111', 'srv-222222222222222222222222'].includes(id)) throw Object.assign(new Error('Sunucu bulunamadı.'), { status: 404 });
  return { id };
};
const project = { serverId: 'srv-111111111111111111111111', projectId: 'example-suite', projectName: 'Example Suite', projectPath: '/home/Example_Suite' };
const assignment = (personId, extra = {}) => ({ personId, role: 'Geliştirici', serviceKey: null, serviceLabel: null, ...extra });
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'management-team-test-'));
  t.after(async () => {
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'management-team-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, file: path.join(dataDir, 'team.json'), store: createTeamStore({ dataDir, resolveServer }) };
}

test('team state initializes lazily without sample people and persists complete immutable snapshots', async t => {
  const { store, dataDir, file } = await fixture(t);
  assert.deepEqual(await store.read(), empty());
  assert.deepEqual(await readdir(dataDir), []);
  const created = await store.addPerson({ revision: 0, name: '  Ada Kaya  ' });
  assert.equal(created.revision, 1);
  assert.equal(created.people[0].name, 'Ada Kaya');
  assert.match(created.people[0].id, /^[a-f0-9-]{36}$/);
  const id = created.people[0].id;
  created.people[0].name = 'External change';
  const reopened = createTeamStore({ dataDir, resolveServer });
  assert.equal((await reopened.read()).people[0].name, 'Ada Kaya');
  const updated = await reopened.renamePerson(id, { revision: 1, name: 'Ada Yılmaz' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.people[0].id, id);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), updated);
  assert.deepEqual(await readdir(dataDir), ['team.json']);
  assert.deepEqual(await store.deletePerson(id, { revision: 2 }), { revision: 3, people: [], assignments: [] });
});

test('concurrent requests and store instances serialize revision checks without losing writes', async t => {
  const { store, dataDir } = await fixture(t);
  const second = createTeamStore({ dataDir, resolveServer });
  const results = await Promise.allSettled([
    store.addPerson({ revision: 0, name: 'Birinci' }),
    second.addPerson({ revision: 0, name: 'İkinci' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.match(rejected.reason.message, /başka bir oturumda değişti/);
  const current = await store.read();
  assert.equal(current.revision, 1); assert.equal(current.people.length, 1);
  await assert.rejects(async () => store.renamePerson(current.people[0].id, { revision: 0, name: 'Eski' }), { status: 409 });
  assert.equal((await second.addPerson({ revision: 1, name: 'Üçüncü' })).people.length, 2);
});

test('assignments preserve identity and replace only the requested server and project scope', async t => {
  const { store } = await fixture(t);
  let state = await store.addPerson({ revision: 0, name: 'Ada' });
  const ada = state.people[0].id;
  state = await store.addPerson({ revision: state.revision, name: 'Deniz' });
  const deniz = state.people[1].id;
  const rows = [assignment(ada), assignment(ada, { role: 'Test' }), assignment(deniz, { serviceKey: 'unit:example-suite.service', serviceLabel: 'Uygulama' })];
  state = await store.replaceAssignments({ ...project, revision: state.revision, assignments: rows });
  const originalIds = state.assignments.map(row => row.id);
  state = await store.replaceAssignments({ ...project, projectName: 'Example Suite yeni', revision: state.revision, assignments: rows });
  assert.deepEqual(state.assignments.map(row => row.id), originalIds);
  state = await store.replaceAssignments({ ...project, serverId: 'srv-222222222222222222222222', revision: state.revision, assignments: [assignment(ada)] });
  state = await store.replaceAssignments({ ...project, projectId: 'different', revision: state.revision, assignments: [assignment(deniz)] });
  const foreign = state.assignments.filter(row => row.serverId !== 'srv-111111111111111111111111' || row.projectId !== 'example-suite');
  state = await store.replaceAssignments({ ...project, revision: state.revision, assignments: [] });
  assert.deepEqual(state.assignments, foreign);
  await assert.rejects(async () => store.deletePerson(ada, { revision: state.revision }), error => error.status === 409 && /projelerde görevli/.test(error.message));
  state = await store.replaceAssignments({ ...project, serverId: 'srv-222222222222222222222222', revision: state.revision, assignments: [] });
  state = await store.deletePerson(ada, { revision: state.revision });
  assert.deepEqual(state.people.map(person => person.id), [deniz]);
});

test('invalid references, duplicate assignments, disabled servers, and malformed fields never change state', async t => {
  const { store, file } = await fixture(t);
  const initial = await store.addPerson({ revision: 0, name: 'Ada' });
  const personId = initial.people[0].id;
  const valid = { ...project, revision: 1, assignments: [assignment(personId)] };
  const before = await readFile(file, 'utf8');
  const invalid = [
    { ...valid, extra: true },
    { ...valid, revision: '1' },
    { ...valid, revision: -1 },
    { ...valid, projectId: '' },
    { ...valid, projectName: 'x'.repeat(201) },
    { ...valid, projectPath: '../app' },
    { ...valid, projectPath: '/home/../etc' },
    { ...valid, projectPath: '/home/app\0' },
    { ...valid, projectPath: '/home\\app' },
    { ...valid, serverId: 'ip-255' },
    { ...valid, assignments: [assignment('missing')] },
    { ...valid, assignments: [assignment(personId), assignment(personId)] },
    { ...valid, assignments: [assignment(personId, { role: ' ' })] },
    { ...valid, assignments: [assignment(personId, { role: 'x'.repeat(81) })] },
    { ...valid, assignments: [assignment(personId, { serviceLabel: 'Orphan label' })] },
    { ...valid, assignments: [assignment(personId, { serviceKey: 'x'.repeat(257) })] },
    { ...valid, assignments: [assignment(personId, { id: 'client-id' })] },
    { ...valid, assignments: Array.from({ length: 61 }, (_, index) => assignment(personId, { role: `Rol ${index}` })) },
  ];
  for (const body of invalid) await assert.rejects(async () => store.replaceAssignments(body), { status: 400 });
  await assert.rejects(async () => store.replaceAssignments({ ...valid, serverId: 'srv-333333333333333333333333' }), { status: 404 });
  await assert.rejects(async () => store.renamePerson('missing', { revision: 1, name: 'Kişi' }), { status: 404 });
  await assert.rejects(async () => store.deletePerson('missing', { revision: 1 }), { status: 404 });
  for (const body of [null, [], { revision: 1 }, { revision: 1, name: '' }, { revision: 1, name: 'x'.repeat(101) }, { revision: 1, name: 'Ad\nSoyad' }, { revision: 1, name: 'Kişi', id: 'mine' }])
    await assert.rejects(async () => store.addPerson(body), { status: 400 });
  assert.equal(await readFile(file, 'utf8'), before);
});

test('corrupt and semantically invalid files are preserved and external repairs recover without restart', async t => {
  const { store, file } = await fixture(t);
  const valid = await store.addPerson({ revision: 0, name: 'Ada' });
  for (const content of ['{broken', JSON.stringify({ ...valid, assignments: [{ id: 'bad' }] }), JSON.stringify({ ...valid, unexpected: true })]) {
    await writeFile(file, content);
    await assert.rejects(() => store.read(), { status: 503 });
    await assert.rejects(async () => store.addPerson({ revision: 1, name: 'Deniz' }), { status: 503 });
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, JSON.stringify(valid));
  assert.deepEqual(await store.read(), valid);
  assert.equal((await store.addPerson({ revision: 1, name: 'Deniz' })).revision, 2);
});

test('global people and assignment limits are enforced without discarding saved data', async t => {
  const { store, file } = await fixture(t);
  const people = Array.from({ length: 300 }, (_, index) => ({ id: `person-${index}`, name: `Kişi ${index}` }));
  await writeFile(file, JSON.stringify({ revision: 4, people, assignments: [] }));
  await assert.rejects(async () => store.addPerson({ revision: 4, name: 'Fazla kişi' }), { status: 400 });
  const assignments = Array.from({ length: 3000 }, (_, index) => ({ id: `assignment-${index}`, ...project, projectId: `project-${Math.floor(index / 60)}`, ...assignment('person-0', { role: `Rol ${index % 60}` }) }));
  const state = { revision: 4, people, assignments };
  await writeFile(file, JSON.stringify(state));
  await assert.rejects(async () => store.replaceAssignments({ ...project, revision: 4, assignments: [assignment('person-0')] }), { status: 400 });
  assert.deepEqual(await store.read(), state);
});

test('team routes require authentication, CSRF header and allowed origin, and apply the 16kb body limit', async t => {
  const { store } = await fixture(t);
  const app = express(), auth = createAuth(hashPassword('team-test-password'));
  app.use('/api', protectWrites, express.json({ limit: '16kb' }));
  app.post('/api/login', auth.login);
  app.use('/api', auth.require);
  app.use('/api/team', teamRouter(store));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (route, method, body, headers = {}) => fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'X-Management-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(origin + '/api/team')).status, 401);
  assert.equal((await send('/api/team/people', 'POST', { revision: 0, name: 'Ada' })).status, 401);
  const login = await send('/api/login', 'POST', { password: 'team-test-password' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(origin + '/api/team', { headers: { cookie } })).json(), empty());
  assert.equal((await fetch(origin + '/api/team/people', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, name: 'Ada' }) })).status, 403);
  assert.equal((await send('/api/team/people', 'POST', { revision: 0, name: 'Ada' }, { cookie, Origin: 'https://foreign.invalid' })).status, 403);
  const created = await send('/api/team/people', 'POST', { revision: 0, name: 'Ada' }, { cookie, Origin: origin });
  assert.equal(created.status, 201);
  const state = await created.json();
  assert.equal((await send('/api/team/people', 'POST', { revision: 0, name: 'Stale' }, { cookie })).status, 409);
  assert.equal((await send('/api/team/people', 'POST', { revision: 1, name: 'x'.repeat(17000) }, { cookie })).status, 413);
  const assigned = await send('/api/team/assignments', 'PUT', { ...project, revision: 1, assignments: [assignment(state.people[0].id)] }, { cookie });
  assert.equal(assigned.status, 200); assert.equal((await assigned.json()).revision, 2);
  assert.equal((await send('/api/team/people/' + state.people[0].id, 'DELETE', { revision: 2 }, { cookie })).status, 409);
  assert.equal((await send('/api/team/people/' + state.people[0].id, 'PATCH', { revision: 2, name: 'Ada Kaya' }, { cookie })).status, 200);
});
