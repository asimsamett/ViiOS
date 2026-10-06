import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnectionStore } from '../server/connection-store.mjs';
import { createConnectionManager } from '../server/connection-routes.mjs';

const pin = 'SHA256:' + 'A'.repeat(43);
const input = { name: 'Synthetic target', host: 'old.example.invalid', port: 22, platform: 'linux', username: 'operator', authType: 'password', password: 'synthetic-edit-fixture', fingerprint: pin };
const edit = (record, changes = {}) => ({ name: record.name, host: record.host, port: record.port, platform: record.platform, username: record.username, authType: record.authType, fingerprint: record.fingerprint, keepCredentials: true, expectedRevision: record.configRevision, ...changes });
async function fixture(t, securePermissions = async () => {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'viios-connection-edit-'));
  const store = createConnectionStore({ dataDir, securePermissions });
  await store.initialize();
  t.after(async () => { await store.shutdown(); await rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic job did not settle');
}

test('edit preserves id, creation and data, reseals retained credentials for the new profile', async t => {
  const { store, dataDir } = await fixture(t);
  const original = await store.add(input);
  const targetData = path.join(dataDir, 'servers', original.id);
  await mkdir(targetData, { recursive: true });
  const layout = '{"revision":7,"dock":[]}';
  await writeFile(path.join(targetData, 'desktop-layout.json'), layout);
  await store.patch(original.id, { status: 'installing', phase: 'upload', message: 'Synthetic progress' });
  const changed = await store.update(original.id, edit(original, { host: 'new.example.invalid', username: 'newoperator', platform: 'windows', port: 2222, fingerprint: 'SHA256:' + 'B'.repeat(43) }));
  assert.equal(changed.id, original.id);
  assert.equal(changed.createdAt, original.createdAt);
  assert.equal(changed.configRevision, 1);
  assert.equal(changed.status, 'pending');
  assert.equal(store.getSecret(original.id).password, input.password);
  assert.equal(await readFile(path.join(targetData, 'desktop-layout.json'), 'utf8'), layout);
  const raw = await readFile(path.join(dataDir, 'connections', 'servers.json'), 'utf8');
  assert.ok(!raw.includes(input.password));
  assert.ok(!JSON.stringify(changed).includes('sealed'));
  assert.equal(changed.password, undefined);
  const reloaded = createConnectionStore({ dataDir, securePermissions: async () => {} });
  await reloaded.initialize();
  assert.equal(reloaded.getSecret(original.id).password, input.password);
  await reloaded.shutdown();
  await assert.rejects(store.update(original.id, edit(original)), { code: 'CONNECTION_CHANGED' });
});

test('replacement and authentication changes require explicit secrets; reserved endpoints reject duplicates', async t => {
  const { store } = await fixture(t);
  const original = await store.add(input);
  await assert.rejects(store.update(original.id, edit(original, { authType: 'key' })), { code: 'CREDENTIALS_REQUIRED' });
  await assert.rejects(store.update(original.id, edit(original, { keepCredentials: false, authType: 'key' })), { code: 'KEY_REQUIRED' });
  const password = await store.update(original.id, edit(original, { keepCredentials: false, password: 'synthetic-replacement' }));
  assert.equal(store.getSecret(original.id).password, 'synthetic-replacement');
  const key = await store.update(original.id, edit(password, { keepCredentials: false, authType: 'key', privateKey: 'synthetic-private-key-fixture', passphrase: 'synthetic-passphrase' }));
  assert.equal(store.getSecret(original.id).privateKey, 'synthetic-private-key-fixture');
  assert.equal(store.getSecret(original.id).password, undefined);
  const prepared = await store.prepareUpdate(original.id, edit(key, { host: 'reserved.example.invalid' }));
  await assert.rejects(store.add({ ...input, host: 'reserved.example.invalid' }), { code: 'CONNECTION_EXISTS' });
  prepared.cancel();
  await store.add({ ...input, host: 'reserved.example.invalid' });
});

test('invalid edits do not disconnect ready targets and failed persistence restores their cache', async t => {
  let failWrites = false;
  const { store, dataDir } = await fixture(t, async filename => { if (failWrites && filename.endsWith('.tmp')) throw new Error('Synthetic write failure'); });
  const original = await store.add(input);
  await store.patch(original.id, { status: 'ready', phase: 'complete' });
  let removed = 0, ready = 0;
  const manager = createConnectionManager({ dataDir, store, bootstrap: async () => assert.fail('Invalid edit must not bootstrap'), onReady: () => { ready++; }, onRemove: () => { removed++; } });
  await manager.initialize();
  t.after(() => manager.shutdown());
  await assert.rejects(manager.update(original.id, edit(original, { port: 0 })), { code: 'INVALID_PORT' });
  assert.equal(removed, 0);
  assert.equal(ready, 1);
  failWrites = true;
  await assert.rejects(manager.update(original.id, edit(original, { host: 'new.example.invalid' })), /Synthetic write failure/);
  failWrites = false;
  assert.equal(removed, 1);
  assert.equal(ready, 2);
  assert.equal(store.get(original.id).host, original.host);
  assert.equal(store.get(original.id).status, 'ready');
  assert.equal(store.get(original.id).configRevision, 0);
});

test('editing installing target waits for cancellation and ignores late progress from the old job', async t => {
  const { store, dataDir } = await fixture(t);
  let oldProgress, oldSignal, oldEnded = false, runs = 0;
  const manager = createConnectionManager({ dataDir, store, onRemove: () => assert.ok(oldEnded), bootstrap: async (profile, options) => {
    runs++;
    if (runs === 1) {
      oldProgress = options.onProgress; oldSignal = options.signal;
      await options.onProgress({ status: 'installing', phase: 'upload', message: 'Old progress' });
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      oldEnded = true;
    }
    return { synthetic: profile.host };
  } });
  await manager.initialize(); t.after(() => manager.shutdown());
  const original = await manager.add(input);
  await until(() => store.get(original.id).status === 'installing');
  const changed = await manager.update(original.id, edit(original, { host: 'new.example.invalid', sudoPassword: 'synthetic-ephemeral-sudo' }));
  assert.equal(changed.id, original.id);
  assert.ok(oldSignal.aborted);
  await until(() => store.get(original.id).status === 'ready');
  await oldProgress({ status: 'error', phase: 'stale', message: 'Should be ignored' });
  assert.equal(store.get(original.id).phase, 'complete');
  assert.equal(store.get(original.id).capabilities.synthetic, 'new.example.invalid');
  assert.equal(store.get(original.id).configRevision, 1);
  assert.equal(runs, 2);
});

test('concurrent update, retry and remove serialize for the same target without resurrecting jobs', async t => {
  const { store, dataDir } = await fixture(t);
  let running = 0, stopped = 0;
  const manager = createConnectionManager({ dataDir, store, bootstrap: async (_profile, { signal }) => {
    running++;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    stopped++;
    return {};
  } });
  await manager.initialize(); t.after(() => manager.shutdown());
  const original = await manager.add(input);
  const results = await Promise.all([
    manager.update(original.id, edit(original, { name: 'Changed name' })),
    manager.retry(original.id),
    manager.remove(original.id),
  ]);
  assert.equal(results[0].configRevision, 1);
  assert.equal(results[1].configRevision, 1);
  assert.equal(results[2].ok, true);
  assert.equal(store.get(original.id), null);
  assert.equal(running, 2);
  assert.equal(stopped, 2);
});
