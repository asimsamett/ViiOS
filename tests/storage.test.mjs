import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageScanCache, createStorageMonitor, storageApplications, storagePath, storageQuery } from '../server/storage.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const empty = { status: 'scanning', path: '/', totalBytes: null, partial: false, entries: [], scannedAt: null };

test('storage paths and query reject traversal, repeated parameters and unsupported options', () => {
  for (const value of ['relative', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b', '/a\nb', ['/home'], '/' + 'a'.repeat(4096)])
    assert.throws(() => storagePath(value), { status: 400 });
  assert.equal(storagePath('/home/Uygulama adı'), '/home/Uygulama adı');
  assert.throws(() => storageQuery({ path: ['/', '/home'] }, true), { status: 400 });
  assert.throws(() => storageQuery({ refresh: '0' }), { status: 400 });
  assert.throws(() => storageQuery({ command: 'id' }), { status: 400 });
});

test('directory requests coalesce, serialize across paths, cache and rate-limit refreshes', async () => {
  let now = 0, active = 0, peak = 0;
  const calls = [], complete = [];
  const cache = createStorageScanCache(request => new Promise(resolve => {
    calls.push(request.path); active++; peak = Math.max(peak, active);
    complete.push(value => { active--; resolve(value); });
  }), { now: () => now });
  assert.equal(cache.read('/', { path: '/' }, empty).status, 'scanning');
  cache.read('/', { path: '/' }, empty, true);
  cache.read('/home', { path: '/home' }, { ...empty, path: '/home' });
  await settle();
  assert.deepEqual(calls, ['/']);
  complete.shift()({ ...empty, status: 'ready', totalBytes: 120, partial: true });
  await settle();
  assert.equal(cache.read('/', { path: '/' }, empty).totalBytes, 120);
  assert.equal(cache.read('/', { path: '/' }, empty).partial, true);
  assert.deepEqual(calls, ['/', '/home']);
  complete.shift()({ ...empty, status: 'ready', totalBytes: 20 });
  await settle();
  now = 29999;
  assert.equal(cache.read('/', { path: '/' }, empty, true).status, 'ready');
  now = 30000;
  assert.equal(cache.read('/', { path: '/' }, empty, true).status, 'scanning');
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(peak, 1);
  complete.shift()({ ...empty, status: 'ready', totalBytes: 121 });
  await settle();
  now = 30001;
  assert.equal(cache.read('/home', { path: '/home' }, empty, true).status, 'ready');
  cache.shutdown();
});

test('failed scans retain null and retry only after cooldown, not on every poll', async () => {
  let calls = 0, now = 0;
  const cache = createStorageScanCache(async () => { calls++; throw new Error('permission'); }, { now: () => now });
  cache.read('/', {}, empty);
  await settle();
  const result = cache.read('/', {}, empty);
  assert.equal(result.status, 'error');
  assert.equal(result.totalBytes, null);
  for (let index = 0; index < 10; index++) cache.read('/', {}, empty, true);
  assert.equal(calls, 1);
  now = 30000;
  cache.read('/', {}, empty);
  await settle();
  assert.equal(calls, 2);
  cache.shutdown();
});

test('queued scans and cached paths have hard bounds', async () => {
  const cache = createStorageScanCache(() => new Promise(() => {}));
  for (let index = 0; index < 9; index++) cache.read(String(index), {}, empty);
  assert.throws(() => cache.read('overflow', {}, empty), { status: 429 });
  cache.shutdown();
});

test('failed refresh preserves the last successful directory measurement with its timestamp', async () => {
  let now = 0, attempt = 0;
  const cache = createStorageScanCache(async () => {
    if (++attempt === 2) throw new Error('offline');
    return { ...empty, status: 'ready', scannedAt: 123, totalBytes: 456, entries: [{ name: 'app', bytes: 456 }] };
  }, { now: () => now });
  cache.read('/', {}, empty);
  await settle();
  now = 30000;
  cache.read('/', {}, empty, true);
  await settle();
  const stale = cache.read('/', {}, empty);
  assert.equal(stale.status, 'error');
  assert.equal(stale.scannedAt, 123);
  assert.equal(stale.totalBytes, 456);
  assert.equal(stale.entries[0].bytes, 456);
  assert.equal(stale.partial, true);
  cache.shutdown();
});

test('application roots include inactive catalog siblings and deduplicate generic/shared directories', () => {
  const definitions = [{ id: 'known', name: 'Known', directory: '/home/main', roots: ['/home/main/api', '/home/side'] },
    { id: 'child', name: 'Child', directory: '/home/main/child', roots: [] }].map(project => ({ ...project, serverId: 'srv-111111111111111111111111', host: '192.0.2.10' }));
  const rows = storageApplications([
    { port: 1, name: 'duplicate', project: { id: 'known', directory: '/home/main' } },
    { port: 2, name: 'system', directory: '/usr/bin' },
    { port: 3, name: 'generic', directory: '/home' },
    { port: 4, name: 'standalone', directory: '/opt/standalone' },
  ], { id: 'srv-111111111111111111111111', host: '192.0.2.10' }, definitions);
  assert.deepEqual(rows.map(row => row.path), ['/home/main', '/home/side', '/home/main/child', '/opt/standalone']);
  assert.ok(rows[0].reason.includes('eklenmemelidir'));
  assert.equal(storageApplications([], { id: 'srv-222222222222222222222222', host: '192.0.2.11' }, definitions).length, 0);
});

test('application unknown sizes remain null and capacity failures stay unavailable', async () => {
  const monitor = createStorageMonitor({ id: 'other', host: 'host' }, {
    applications: () => [{ port: 1, name: 'Example', directory: '/opt/example' }],
    run: async request => {
      if (request.action === 'overview') throw new Error('missing helper');
      return { status: 'ready', scannedAt: 123, partial: true, applications: [{ path: '/opt/example', bytes: null, partial: true, reason: 'unreadable' }] };
    },
  });
  assert.equal(monitor.apps().applications[0].bytes, null);
  await settle();
  assert.equal(monitor.apps().status, 'ready');
  assert.equal(monitor.apps().applications[0].bytes, null);
  assert.equal(monitor.apps().partial, true);
  const overview = await monitor.read();
  assert.equal(overview.available, false);
  assert.equal(overview.summary, null);
  monitor.shutdown();
});

test('overview failure preserves known volumes and labels them stale; app truncation is explicit', async () => {
  let now = 0, attempt = 0;
  const monitor = createStorageMonitor({ id: 'other', host: 'host' }, {
    now: () => now,
    applications: () => Array.from({ length: 85 }, (_, index) => ({ port: index + 1, name: `App ${index}`, directory: `/opt/app${index}` })),
    run: async request => {
      if (request.action !== 'overview') return { status: 'ready', applications: [] };
      if (++attempt === 2) throw new Error('offline');
      return { available: true, sampledAt: 123, summary: { totalBytes: 999 }, volumes: [{ id: 'disk', totalBytes: 999 }] };
    },
  });
  assert.equal((await monitor.read()).available, true);
  now = 5000;
  const stale = await monitor.read();
  assert.equal(stale.available, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.sampledAt, 123);
  assert.equal(stale.volumes[0].totalBytes, 999);
  const apps = monitor.apps();
  assert.equal(apps.applications.length, 80);
  assert.equal(apps.omittedApplications, 5);
  assert.equal(apps.partial, true);
  assert.match(apps.reason, /5 dizin/);
  monitor.shutdown();
});
