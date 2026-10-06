import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAppCredentialStore, appCredentialsRouter } from '../server/app-credentials.mjs';
import { createAppCredentialSync, istanbulDay, nextIstanbulMidnight } from '../server/app-credential-sync.mjs';
import { createAuth, hashPassword, protectWrites } from '../server/auth.mjs';

const fixture = { sourceId: 'fixture/project-a/admin-account', name: 'Fixture panel', url: 'https://example.test/admin', username: 'admin', password: 'MOCK_ONLY_first_password', note: 'Kaynak açıklaması' };
const manual = ({ sourceId: _sourceId, ...entry }) => entry;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(t, { at = '2026-09-29T12:00:00.000Z', discover = async () => ({ entries: [] }), enabled = true } = {}) {
  const temporaryRoot = path.resolve(os.tmpdir()), dataDir = await mkdtemp(path.join(temporaryRoot, 'credential-sync-test-'));
  let time = Date.parse(at);
  const store = createAppCredentialStore({ dataDir });
  const createSync = (source = discover) => createAppCredentialSync({ store, dataDir, discover: source, now: () => time, enabled });
  const sync = createSync();
  t.after(async () => {
    await sync.close();
    assert.equal(path.dirname(path.resolve(dataDir)), temporaryRoot);
    assert.ok(path.basename(dataDir).startsWith('credential-sync-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, sync, createSync, setTime: value => { time = Date.parse(value); } };
}

test('discovery adopts legacy accounts, deduplicates normalized panel+account, and stays idempotent', async t => {
  const { store, dataDir } = await setup(t);
  await store.create({ revision: 0, ...manual(fixture) });
  await store.create({ revision: 1, ...manual(fixture), name: 'Kişisel ad', url: 'https://example.test/other', password: 'MOCK_ONLY_manual_password', note: 'Kişisel not' });
  const sources = [fixture, { ...fixture, sourceId: 'fixture/project-b/admin', url: 'https://example.test/other', password: 'MOCK_ONLY_source_password' },
    { ...fixture, sourceId: 'fixture/project-c/admin', url: 'https://EXAMPLE.test:443/new/', password: undefined },
    { ...fixture, sourceId: 'fixture/project-c/admin', url: 'https://example.test/new', password: 'MOCK_ONLY_new_password' }];
  delete sources[2].password;
  const result = await store.mergeDiscovered(sources);
  assert.deepEqual(result, { added: 1, updated: 0, unchanged: 2, revision: 3 });
  const state = await store.read(); assert.equal(state.entries.length, 3);
  assert.ok(state.entries.every(entry => !Object.hasOwn(entry, 'source') && !Object.hasOwn(entry, 'password')));
  const manualRow = state.entries.find(entry => entry.url.endsWith('/other'));
  assert.equal(manualRow.name, 'Kişisel ad'); assert.equal(manualRow.note, 'Kişisel not');
  assert.deepEqual(await store.reveal(manualRow.id), { password: 'MOCK_ONLY_manual_password' });
  assert.deepEqual(await store.mergeDiscovered(sources), { added: 0, updated: 0, unchanged: 3, revision: 3 });
  await store.mergeDiscovered([]);
  assert.deepEqual(await store.read(), state, 'missing/offline source records are retained');
  const raw = await readFile(path.join(dataDir, 'app-credentials.enc.json'), 'utf8');
  for (const secret of [fixture.sourceId, fixture.password, 'lastImported', 'MOCK_ONLY_manual_password']) assert.ok(!raw.includes(secret));
});

test('verified source fields follow stable identity across URL/account changes while explicit edits remain protected', async t => {
  const { store } = await setup(t);
  await store.create({ revision: 0, ...manual(fixture) });
  await store.mergeDiscovered([fixture]);
  const before = await store.read(), id = before.entries[0].id;
  const moved = { ...fixture, url: 'https://example.test/new-admin', username: 'new-admin', password: 'MOCK_ONLY_rotated', name: 'Yeni kaynak adı' };
  assert.equal((await store.mergeDiscovered([moved])).updated, 1);
  let current = await store.read();
  assert.equal(current.entries.length, 1); assert.equal(current.entries[0].id, id);
  assert.equal(current.entries[0].url, moved.url); assert.equal(current.entries[0].username, moved.username);
  assert.deepEqual(await store.reveal(id), { password: moved.password });
  await store.update(id, { revision: current.revision, ...manual(moved), name: 'Elle düzenlenmiş', password: 'MOCK_ONLY_user_override' });
  assert.equal((await store.mergeDiscovered([{ ...moved, name: 'Başka kaynak adı', password: 'MOCK_ONLY_rotation_2', note: 'Güncel kaynak notu' }])).updated, 1);
  current = await store.read();
  assert.equal(current.entries[0].name, 'Elle düzenlenmiş'); assert.equal(current.entries[0].note, 'Güncel kaynak notu');
  assert.deepEqual(await store.reveal(id), { password: 'MOCK_ONLY_user_override' });
  const { password: _password, note: _note, ...partial } = moved;
  await store.mergeDiscovered([partial]);
  assert.equal((await store.read()).entries[0].note, 'Güncel kaynak notu');
  assert.deepEqual(await store.reveal(id), { password: 'MOCK_ONLY_user_override' });
  current = await store.read();
  await store.update(id, { revision: current.revision, ...manual(moved), password: '' });
  await store.mergeDiscovered([moved]);
  assert.deepEqual(await store.reveal(id), { password: '' }, 'explicitly cleared password stays cleared');
});

test('a new source reusing the same panel URL cannot replace a tracked source password', async t => {
  const { store } = await setup(t);
  await store.mergeDiscovered([fixture]);
  const first = (await store.read()).entries[0];
  const other = { ...fixture, sourceId: 'fixture/different-project/admin-account', password: 'MOCK_ONLY_reused_port_password' };
  assert.equal((await store.mergeDiscovered([other])).added, 1);
  assert.equal((await store.read()).entries.length, 2);
  assert.deepEqual(await store.reveal(first.id), { password: fixture.password });
  assert.deepEqual(await store.mergeDiscovered([other]), { added: 0, updated: 0, unchanged: 1, revision: 2 });
});

test('manual edits made during an asynchronous discovery survive the final merge', async t => {
  const scan = deferred(), { store, sync } = await setup(t, { discover: () => scan.promise });
  await store.mergeDiscovered([fixture]);
  await sync.initialize();
  assert.equal((await sync.trigger()).scanning, true);
  const state = await store.read(), id = state.entries[0].id;
  await store.update(id, { revision: state.revision, ...manual(fixture), username: 'user-choice', password: 'MOCK_ONLY_edit_during_scan' });
  scan.resolve({ entries: [{ ...fixture, username: 'source-change', password: 'MOCK_ONLY_scanner_change', name: 'Kaynak güncel' }] });
  const status = await sync.waitForIdle();
  assert.deepEqual(status.lastResult, { added: 0, updated: 1, unchanged: 0 });
  const row = (await store.read()).entries[0];
  assert.equal(row.username, 'user-choice'); assert.equal(row.name, 'Kaynak güncel');
  assert.deepEqual(await store.reveal(id), { password: 'MOCK_ONLY_edit_during_scan' });
});

test('explicit legacy edits and password clears during the first discovery stay protected after adoption', async t => {
  const scan = deferred(), { store, sync } = await setup(t, { discover: () => scan.promise });
  const original = await store.create({ revision: 0, ...manual(fixture), name: 'Eski elle girilmiş ad' });
  const id = original.entries[0].id;
  await sync.initialize(); await sync.trigger();
  // This edit precedes source adoption. The new name happens to match the
  // initial source snapshot, but remains an explicit user-owned value.
  const edited = await store.update(id, { revision: original.revision, ...manual(fixture), password: '' });
  assert.equal(edited.entries[0].hasPassword, false);
  assert.equal(Object.hasOwn(edited.entries[0], 'manualOverrides'), false);
  scan.resolve({ entries: [fixture] }); await sync.waitForIdle();
  let state = await store.read();
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].id, id);
  assert.equal(state.entries[0].name, fixture.name);
  assert.deepEqual(await store.reveal(id), { password: '' });
  await store.mergeDiscovered([{ ...fixture, name: 'Sonraki kaynak adı', password: 'MOCK_ONLY_later_rotation' }]);
  state = await store.read();
  assert.equal(state.entries[0].name, fixture.name);
  assert.deepEqual(await store.reveal(id), { password: '' });
  assert.equal(Object.hasOwn(state.entries[0], 'source'), false);
  assert.equal(Object.hasOwn(state.entries[0], 'manualOverrides'), false);
});

test('Istanbul midnight scheduling is independent of the host zone and manual checks do not consume midnight', async t => {
  let calls = 0;
  const { sync, setTime } = await setup(t, { at: '2026-09-29T20:59:59.000Z', discover: async () => { calls++; return { entries: [] }; } });
  assert.equal(istanbulDay('2026-09-29T21:00:00.000Z'), '2026-09-30');
  assert.equal(nextIstanbulMidnight('2026-09-29T20:59:59.000Z'), '2026-09-29T21:00:00.000Z');
  assert.equal(nextIstanbulMidnight('2026-09-29T21:00:00.000Z'), '2026-09-30T21:00:00.000Z');
  let status = await sync.initialize();
  assert.equal(calls, 0); assert.equal(status.nextRunAt, '2026-09-29T21:00:00.000Z');
  await sync.trigger(); await sync.waitForIdle();
  assert.equal(calls, 1); assert.equal((await sync.status()).lastDailyDay, null);
  setTime('2026-09-29T21:00:00.000Z');
  assert.equal((await sync.tick()).scanning, true);
  status = await sync.waitForIdle();
  assert.equal(calls, 2); assert.equal(status.lastDailyDay, '2026-09-30'); assert.equal(status.nextRunAt, '2026-09-30T21:00:00.000Z');
  await sync.tick(); assert.equal(calls, 2);
  setTime('2026-09-30T21:00:00.000Z'); await sync.tick(); await sync.waitForIdle();
  assert.equal(calls, 3);
});

test('restart catches up a missed midnight once and persists the next midnight', async t => {
  let calls = 0;
  const { sync, createSync, setTime } = await setup(t, { discover: async () => { calls++; return { entries: [] }; } });
  await sync.initialize(); await sync.close();
  setTime('2026-10-02T09:00:00.000Z');
  const restarted = createSync(); t.after(() => restarted.close());
  assert.equal((await restarted.initialize()).scanning, true);
  const status = await restarted.waitForIdle();
  assert.equal(calls, 1); assert.equal(status.lastDailyDay, '2026-10-02'); assert.equal(status.nextRunAt, '2026-10-02T21:00:00.000Z');
  await restarted.close();
  const again = createSync(); t.after(() => again.close());
  assert.equal((await again.initialize()).scanning, false); assert.equal(calls, 1);
});

test('concurrent clicks coalesce and a midnight reached during a manual scan runs afterward', async t => {
  let calls = 0; const pending = deferred();
  const { sync, setTime } = await setup(t, { at: '2026-09-29T20:59:59.000Z', discover: async () => { calls++; return calls === 1 ? pending.promise : { entries: [] }; } });
  await sync.initialize();
  const statuses = await Promise.all([sync.trigger(), sync.trigger(), sync.trigger()]);
  assert.ok(statuses.every(status => status.scanning)); assert.equal(calls, 1);
  setTime('2026-09-29T21:00:00.000Z'); await sync.tick(); assert.equal(calls, 1);
  pending.resolve({ entries: [] });
  const status = await sync.waitForIdle();
  assert.equal(calls, 2); assert.equal(status.lastDailyDay, '2026-09-30');
});

test('failed scheduled checks retain records, retry after five minutes, and never report false success or secret errors', async t => {
  let calls = 0;
  const { store, sync, setTime, createSync, dataDir } = await setup(t, { at: '2026-09-29T20:59:59.000Z', discover: async () => { calls++; if (calls === 1) throw new Error('MOCK_ONLY_DO_NOT_EXPOSE'); return { entries: [] }; } });
  await store.mergeDiscovered([fixture]);
  await sync.initialize(); setTime('2026-09-29T21:00:00.000Z'); await sync.tick();
  let status = await sync.waitForIdle();
  assert.equal(status.lastSuccessAt, null); assert.equal(status.lastDailyDay, null); assert.equal(status.lastResult, null);
  assert.ok(status.lastError); assert.ok(!JSON.stringify(status).includes('MOCK_ONLY_DO_NOT_EXPOSE'));
  assert.equal(status.nextRunAt, '2026-09-29T21:05:00.000Z');
  assert.equal((await store.read()).entries.length, 1);
  await sync.close();
  const restarted = createSync(); t.after(() => restarted.close());
  setTime('2026-09-29T21:04:59.999Z'); await restarted.initialize(); await restarted.tick(); assert.equal(calls, 1);
  setTime('2026-09-29T21:05:00.000Z'); await restarted.tick();
  status = await restarted.waitForIdle();
  assert.equal(calls, 2); assert.equal(status.lastError, null); assert.equal(status.lastSuccessAt, '2026-09-29T21:05:00.000Z');
  assert.equal(status.lastDailyDay, '2026-09-30'); assert.equal(status.nextRunAt, '2026-09-30T21:00:00.000Z');
  const raw = await readFile(path.join(dataDir, 'app-credentials-sync.json'), 'utf8');
  assert.ok(!raw.includes(fixture.password)); assert.ok(!raw.includes('MOCK_ONLY_DO_NOT_EXPOSE'));
});

test('disabled targets cannot start a scan and corrupt scheduling metadata is not silently replaced', async t => {
  let calls = 0;
  const disabled = await setup(t, { enabled: false, discover: async () => { calls++; return { entries: [] }; } });
  const status = await disabled.sync.initialize();
  assert.equal(status.enabled, false); assert.equal(status.nextRunAt, null); assert.ok(status.disabledReason);
  await assert.rejects(disabled.sync.trigger(), error => error.status === 503); assert.equal(calls, 0);
  const enabled = await setup(t);
  const file = path.join(enabled.dataDir, 'app-credentials-sync.json');
  await writeFile(file, '{broken');
  await assert.rejects(enabled.sync.initialize(), error => error.status === 503);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('sync endpoints enforce session/write protection and return 202 without waiting for discovery', async t => {
  const pending = deferred(), { sync, store } = await setup(t, { discover: () => pending.promise });
  await sync.initialize();
  const app = express(), auth = createAuth(hashPassword('MOCK_ONLY_login'));
  app.use('/api', protectWrites, express.json()); app.post('/api/login', auth.login); app.use('/api', auth.require);
  app.use('/api/credentials', appCredentialsRouter(store, { sync }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.status ? error.message : 'İşlem tamamlanamadı.' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(`${base}/credentials/sync`)).status, 401);
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Request': '1' }, body: JSON.stringify({ password: 'MOCK_ONLY_login' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/credentials/sync`, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const response = await fetch(`${base}/credentials/sync`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Management-Request': '1' }, body: '{}' });
  assert.equal(response.status, 202); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).scanning, true);
  pending.resolve({ entries: [fixture] }); await sync.waitForIdle();
  const finished = await fetch(`${base}/credentials/sync`, { headers: { Cookie: cookie } });
  const finishedStatus = await finished.json(); assert.equal(finishedStatus.scanning, false); assert.equal(finishedStatus.lastResult.added, 1);
});
