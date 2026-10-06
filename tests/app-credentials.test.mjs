import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAppCredentialStore, appCredentialsRouter } from '../server/app-credentials.mjs';
import { createAuth, hashPassword, protectWrites } from '../server/auth.mjs';

const fixture = { name: 'Örnek Yönetim', url: 'https://example.test/admin', username: 'admin', password: 'MOCK_ONLY_ Şifre_🔐_ ', note: 'Test kaydı' };
const rejected = (operation, status) => assert.rejects(async () => operation(), error => error.status === status);
async function directory(t) {
  const root = path.resolve(os.tmpdir()), dataDir = await mkdtemp(path.join(root, 'app-credentials-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataDir)), root);
    assert.ok(path.basename(dataDir).startsWith('app-credentials-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

test('credentials persist encrypted and list/mutation responses never expose passwords', async t => {
  const dataDir = await directory(t), store = createAppCredentialStore({ dataDir });
  assert.deepEqual(await store.read(), { revision: 0, entries: [] });
  assert.deepEqual(await readdir(dataDir), []);
  const created = await store.create({ revision: 0, ...fixture }), entry = created.entries[0];
  assert.equal(created.revision, 1);
  assert.equal(entry.hasPassword, true);
  assert.equal(entry.name, fixture.name);
  assert.equal('password' in entry, false);
  assert.ok(!JSON.stringify(created).includes(fixture.password));
  const ciphertext = await readFile(path.join(dataDir, 'app-credentials.enc.json'));
  for (const clear of [fixture.password, fixture.name, fixture.username, fixture.url, fixture.note]) assert.ok(!ciphertext.includes(Buffer.from(clear)));
  assert.equal((await readFile(path.join(dataDir, 'app-credentials.key'))).length, 32);
  const reopened = createAppCredentialStore({ dataDir });
  assert.deepEqual(await reopened.read(), created);
  assert.deepEqual(await reopened.reveal(entry.id), { password: fixture.password });
  assert.deepEqual((await readdir(dataDir)).sort(), ['app-credentials.enc.json', 'app-credentials.key']);

  const { password: _password, ...withoutPassword } = fixture;
  const updated = await reopened.update(entry.id, { revision: 1, ...withoutPassword, name: 'Yeni ad' });
  assert.equal(updated.entries[0].hasPassword, true);
  assert.deepEqual(await reopened.reveal(entry.id), { password: fixture.password });
  const cleared = await reopened.update(entry.id, { revision: 2, ...fixture, password: '' });
  assert.equal(cleared.entries[0].hasPassword, false);
  assert.deepEqual(await reopened.reveal(entry.id), { password: '' });
  assert.deepEqual(await reopened.delete(entry.id, { revision: 3 }), { revision: 4, entries: [] });
  await rejected(() => reopened.reveal(entry.id), 404);
});

test('invalid URLs and malformed credential fields are rejected without changing stored state', async t => {
  const store = createAppCredentialStore({ dataDir: await directory(t) });
  for (const url of ['javascript:alert(1)', 'file:///tmp/panel', '//example.test/admin', 'https://admin:password@example.test/', 'https://admin@example.test/', 'https://', 'http:\\example.test', 'https://exa\nmple.test', '']) {
    await rejected(() => store.create({ revision: 0, ...fixture, url }), 400);
  }
  for (const override of [{ name: '' }, { name: 'x'.repeat(201) }, { username: 'x'.repeat(257) }, { password: 'x'.repeat(4097) }, { password: '\0' }, { password: null }, { url: 'https://example.test/' + 'a'.repeat(2048) }, { note: 'x'.repeat(2001) }, { note: null }, { injected: true }, { revision: -1 }, { revision: '0' }]) {
    await rejected(() => store.create({ revision: 0, ...fixture, ...override }), 400);
  }
  assert.deepEqual(await store.read(), { revision: 0, entries: [] });
  const result = await store.create({ revision: 0, name: ' Yerel panel ', url: 'http://127.0.0.1:3100/admin', username: '', note: 'Satır 1\nSatır 2' });
  assert.equal(result.entries[0].name, 'Yerel panel');
  assert.equal(result.entries[0].hasPassword, false);
});

test('revisions serialize simultaneous writes across store instances and reject stale updates', async t => {
  const dataDir = await directory(t), first = createAppCredentialStore({ dataDir }), second = createAppCredentialStore({ dataDir });
  const writes = await Promise.allSettled([first.create({ revision: 0, ...fixture }), second.create({ revision: 0, ...fixture, name: 'İkinci' })]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.status, 409);
  const state = await second.read();
  assert.equal(state.revision, 1); assert.equal(state.entries.length, 1);
  await rejected(() => first.update(state.entries[0].id, { revision: 0, ...fixture }), 409);
  await rejected(() => first.delete(state.entries[0].id, { revision: 0 }), 409);
  assert.deepEqual(await first.read(), state);
});

test('different server data directories keep credentials and encryption keys separate', async t => {
  const root = await directory(t), primaryDir = path.join(root, 'primary'), otherDir = path.join(root, 'other');
  const primary = createAppCredentialStore({ dataDir: primaryDir }), other = createAppCredentialStore({ dataDir: otherDir });
  const primaryState = await primary.create({ revision: 0, ...fixture });
  assert.deepEqual(await other.read(), { revision: 0, entries: [] });
  await rejected(() => other.reveal(primaryState.entries[0].id), 404);
  await other.create({ revision: 0, ...fixture, name: 'Diğer sunucu' });
  assert.notDeepEqual(await readFile(path.join(primaryDir, 'app-credentials.key')), await readFile(path.join(otherDir, 'app-credentials.key')));
  // Copying a different target's encrypted file cannot reveal its contents.
  await writeFile(path.join(otherDir, 'app-credentials.enc.json'), await readFile(path.join(primaryDir, 'app-credentials.enc.json')));
  await rejected(() => other.read(), 503);
  assert.deepEqual(await primary.read(), primaryState);
});

test('tampering, corrupt payloads and missing keys fail closed and preserve original files', async t => {
  const dataDir = await directory(t), store = createAppCredentialStore({ dataDir });
  const state = await store.create({ revision: 0, ...fixture });
  const file = path.join(dataDir, 'app-credentials.enc.json'), keyFile = path.join(dataDir, 'app-credentials.key');
  const original = await readFile(file), originalKey = await readFile(keyFile);
  const envelope = JSON.parse(original), bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 1; envelope.ciphertext = bytes.toString('base64');
  const badValues = [Buffer.from(JSON.stringify(envelope)), Buffer.from('{broken-json'), Buffer.from(JSON.stringify({ ...JSON.parse(original), tag: '' }))];
  for (const bad of badValues) {
    await writeFile(file, bad);
    await rejected(() => store.read(), 503);
    await rejected(() => store.reveal(state.entries[0].id), 503);
    await rejected(() => store.create({ revision: 1, ...fixture }), 503);
    assert.deepEqual(await readFile(file), bad);
  }
  await writeFile(file, original); await rm(keyFile);
  await rejected(() => store.read(), 503);
  await rejected(() => store.update(state.entries[0].id, { revision: 1, ...fixture }), 503);
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(readFile(keyFile), { code: 'ENOENT' });
  await writeFile(keyFile, Buffer.alloc(32));
  await rejected(() => store.read(), 503);
  await writeFile(keyFile, originalKey);
  assert.deepEqual(await store.reveal(state.entries[0].id), { password: fixture.password });
});

test('API requires login and write protection for creation/reveal and disables response caching', async t => {
  const store = createAppCredentialStore({ dataDir: await directory(t) });
  const state = await store.create({ revision: 0, ...fixture }), id = state.entries[0].id;
  const app = express(), auth = createAuth(hashPassword('MOCK_ONLY_login_password'));
  app.use('/api', protectWrites, express.json());
  app.post('/api/login', auth.login); app.use('/api', auth.require);
  app.use('/api/servers/fixture/credentials', appCredentialsRouter(store));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.status ? error.message : 'İşlem tamamlanamadı.' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/api/servers/fixture/credentials`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}/${id}/reveal`, { method: 'POST', headers: { 'X-Management-Request': '1' } })).status, 401);
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Management-Request': '1' }, body: JSON.stringify({ password: 'MOCK_ONLY_login_password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), state);
  assert.equal((await fetch(`${base}/${id}/reveal`, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Management-Request': '1' };
  assert.equal((await fetch(`${base}/${id}/reveal`, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.test' }, body: '{}' })).status, 403);
  const revealed = await fetch(`${base}/${id}/reveal`, { method: 'POST', headers, body: '{}' });
  assert.equal(revealed.status, 200); assert.equal(revealed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await revealed.json(), { password: fixture.password });
  const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ revision: 1, ...fixture, password: '' }) });
  assert.equal(created.status, 201);
  const updated = await created.json(); assert.equal(updated.revision, 2);
  assert.ok(updated.entries.every(entry => !Object.hasOwn(entry, 'password')));
});
