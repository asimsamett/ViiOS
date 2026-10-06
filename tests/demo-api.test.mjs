import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDemoController, demoPreviewUrl } from '../demo/api.mjs';
import { createFixtures, DEMO_SERVER_IDS } from '../demo/fixtures.mjs';

const origin = 'https://viios-demo.invalid';
const fixedTime = '2026-01-01T12:00:00.000Z';
const controller = () => createDemoController({ origin, now: () => fixedTime });
const scoped = (id, path) => `/api/servers/${id}${path}`;
const write = (path, body, method = 'POST') => [path, { method, body: JSON.stringify(body) }];

test('demo starts without credentials and exposes only the two invented platforms', async () => {
  const demo = controller();
  assert.deepEqual(await (await demo.fetch('/api/setup')).json(), { required: false, demo: true });
  assert.equal((await (await demo.fetch('/api/session')).json()).authenticated, true);
  const fleet = await (await demo.fetch('/api/servers')).json();
  assert.deepEqual(fleet.servers.map(server => server.id), DEMO_SERVER_IDS);
  assert.deepEqual(fleet.servers.map(server => server.platform), ['linux', 'windows']);
  assert.ok(fleet.servers.every(server => server.host.startsWith('192.0.2.')));
  for (const server of fleet.servers) {
    assert.equal(server.password, undefined);
    assert.equal(server.privateKey, undefined);
    const inventory = await (await demo.fetch(scoped(server.id, '/inventory'))).json();
    assert.equal(inventory.serverId, server.id);
    assert.ok(inventory.apps.length >= 3);
    assert.ok(inventory.apps.every(app => !app.openUrl && !app.control.canStop && !app.control.canStart));
  }
  await demo.fetch(...write('/api/logout', {}));
  assert.equal((await (await demo.fetch('/api/session')).json()).authenticated, true);
});

test('every demo panel has a usable browser-only response on Linux and Windows', async () => {
  const demo = controller();
  for (const id of DEMO_SERVER_IDS) {
    const get = async path => {
      const response = await demo.fetch(scoped(id, path));
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const storage = await get('/storage');
    assert.equal(storage.summary.totalBytes, storage.volumes.reduce((sum, volume) => sum + volume.totalBytes, 0));
    assert.ok((await get('/resources')).applications.every(app => app.ports.length));
    const root = (await get('/files/capabilities')).defaultPath;
    const folders = await get('/files/list?path=' + encodeURIComponent(root));
    const firstFolder = folders.entries.find(file => file.kind === 'directory');
    assert.ok(firstFolder);
    const files = await get('/files/list?path=' + encodeURIComponent(firstFolder.path));
    const readme = files.entries.find(file => file.name === 'README.md');
    const read = await get('/files/read?path=' + encodeURIComponent(readme.path));
    assert.equal(read.kind, 'text');
    assert.equal(read.editable, false);
    assert.match(read.content, /demo/);
    assert.ok((await get('/files/properties?path=' + encodeURIComponent(readme.path))).sizeBytes > 0);
    assert.ok((await get('/storage/usage?path=' + encodeURIComponent(root))).entries.length);
    assert.ok((await get('/storage/apps')).applications.length);
    assert.ok((await get('/models')).models.length);
    assert.ok((await get('/models/concurrency')).services.length);
    assert.equal((await get('/models/benchmark/options')).canStart, false);
    assert.deepEqual((await get('/models/benchmark/runs')).history, []);
    assert.ok((await get('/events')).events.length);
    assert.ok((await get('/credentials')).entries.every(value => !value.hasPassword));
    assert.equal((await get('/credentials/sync')).enabled, false);
    const projects = (await get('/versions/projects')).projects;
    assert.ok(projects.length);
    for (const action of ['status', 'timeline', 'graph', 'treeFiles', 'commitFiles']) {
      const response = await demo.fetch(...write(scoped(id, '/versions/action'), { action, id: projects[0].id }));
      assert.equal(response.status, 200, action);
    }
  }
});

test('management preview panels use synthetic data and reject process/service mutations without networking', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('No network allowed'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const demo = controller();
  for (const id of DEMO_SERVER_IDS) {
    const get = async path => { const response = await demo.fetch(scoped(id, path)); assert.equal(response.status, 200, path); return response.json(); };
    const overview = await get('/overview');
    assert.equal(overview.serverId, id);
    assert.equal(overview.demo, true);
    assert.ok(overview.topProcesses.length && overview.disks.length && overview.network.length);
    const processes = (await get('/processes')).processes;
    assert.ok(processes.length && processes.every(row => !row.canTerminate && row.token === null));
    assert.equal((await get(`/processes/${processes[0].pid}`)).process.pid, processes[0].pid);
    const services = (await get('/services')).services;
    assert.ok(services.length && services.every(row => !row.actions.length && row.token === null));
    assert.equal((await get(`/services/${services[0].name}`)).service.name, services[0].name);
    assert.equal((await get(`/services/${services[0].name}/logs`)).available, id === 'demo-linux');
    const storage = await get('/storage');
    assert.ok(storage.topology.devices.filter(row => row.kind === 'partition').every(row => storage.volumes.some(volume => row.volumeIds.includes(volume.id))));
    for (const path of [`/processes/${processes[0].pid}/terminate`, `/services/${services[0].name}/action`]) assert.equal((await demo.fetch(...write(scoped(id, path), { action: 'stop', token: 'a'.repeat(64) }))).status, 403);
    assert.deepEqual((await get('/processes')).processes, processes);
    assert.deepEqual((await get('/services')).services, services);
    assert.equal((await demo.fetch(scoped(id, '/processes/999999'))).status, 404);
    assert.equal((await demo.fetch(scoped(id, '/services/missing'))).status, 404);
  }
  assert.equal(calls, 0);
});

test('demo never delegates unknown requests, server probes or credentials to network', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Network must never run'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const demo = controller();
  const secret = 'synthetic-value-that-must-not-persist';
  for (const path of ['/api/connections/probe', '/api/connections', '/api/connections/demo-linux', scoped('demo-linux', '/credentials'), scoped('demo-linux', '/credentials/example/reveal')]) {
    const response = await demo.fetch(...write(path, { host: 'external.example.invalid', username: secret, password: secret, privateKey: secret }));
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes(secret));
  }
  for (const path of ['https://external.example.invalid/api/session', '//external.example.invalid/api/session', 'file:///etc/passwd', 'data:text/plain,demo']) {
    assert.equal((await demo.fetch(path)).status, 403);
  }
  for (const path of ['/api/unknown', '/api/servers/other/inventory', '/api/servers/__proto__/inventory', '/api/connections/__proto__']) assert.equal((await demo.fetch(path)).status, 404);
  for (const path of ['/api/connections', '/api/servers', '/api/team', scoped('demo-linux', '/credentials')]) assert.ok(!(await (await demo.fetch(path)).text()).includes(secret));
  assert.equal(calls, 0);
});

test('file and server mutations stay disabled and never change fixture state', async () => {
  const demo = controller();
  const before = await (await demo.fetch(scoped('demo-linux', '/inventory'))).text();
  for (const [path, body] of [['/files/action', { action: 'write', path: '/srv/atlas/README.md', content: 'replacement' }], ['/files/upload', {}], ['/files/exports', {}], ['/apps/3000/control', { action: 'stop' }], ['/models/benchmark/runs', { prompt: 'never sent' }], ['/versions/action', { action: 'restore', id: 'atlas' }], ['/ops/action', {}]]) {
    assert.equal((await demo.fetch(...write(scoped('demo-linux', path), body))).status, 403, path);
  }
  assert.equal(await (await demo.fetch(scoped('demo-linux', '/inventory'))).text(), before);
  assert.equal((await demo.fetch(scoped('demo-linux', '/files/read?path=/etc/passwd'))).status, 404);
  const read = await (await demo.fetch(scoped('demo-linux', '/files/read?path=/srv/atlas/README.md'))).json();
  assert.ok(!read.content.includes('replacement'));
});

test('in-memory desktop and notifications isolate targets, controllers, and reset', async () => {
  const first = controller(), second = controller();
  const path = scoped('demo-linux', '/desktop-layout');
  const saved = await (await first.fetch(...write(path, { revision: 0, dock: [{ id: 'tasks', kind: 'tasks', label: 'Görev Yöneticisi' }], desktop: [] }, 'PUT'))).json();
  assert.equal(saved.revision, 1);
  saved.dock[0].label = 'caller-mutated';
  assert.equal((await (await first.fetch(path)).json()).dock[0].label, 'Görev Yöneticisi');
  assert.equal((await (await first.fetch(scoped('demo-windows', '/desktop-layout'))).json()).revision, 0);
  assert.equal((await (await second.fetch(path)).json()).revision, 0);
  assert.equal((await first.fetch(...write(path, { revision: 0, dock: [], desktop: [] }, 'PUT'))).status, 409);
  const events = (await (await first.fetch(scoped('demo-linux', '/events'))).json()).events;
  await first.fetch(...write(scoped('demo-linux', '/notifications/read'), { ids: events.map(event => event.id) }));
  assert.equal((await (await first.fetch(scoped('demo-linux', '/inventory'))).json()).unread, 0);
  assert.equal((await (await first.fetch(scoped('demo-windows', '/inventory'))).json()).unread, 2);
  first.reset();
  assert.equal((await (await first.fetch(path)).json()).revision, 0);
  assert.equal((await (await first.fetch(scoped('demo-linux', '/inventory'))).json()).unread, 2);
});

test('ports, synthetic downloads, previews and aborted Request inputs work without backend', async () => {
  const demo = controller();
  const ports = await (await demo.fetch(scoped('demo-linux', '/ports/free?start=2999&end=3001'))).json();
  assert.deepEqual(ports.ports.map(port => port.port), [2999, 3001]);
  const request = new Request(origin + scoped('demo-linux', '/reports/inventory?format=json'));
  const report = await demo.fetch(request);
  assert.match(report.headers.get('content-disposition'), /viios-demo/);
  assert.equal((await report.json()).demo, true);
  const csv = await demo.fetch(scoped('demo-windows', '/reports/free-ports?start=5049&end=5051&format=csv'));
  assert.match(await csv.text(), /5049/);
  const preview = demoPreviewUrl('demo-linux', '3000');
  assert.ok(preview.startsWith('data:image/svg+xml;'));
  assert.match(decodeURIComponent(preview), /Atlas Portal/);
  assert.doesNotMatch(decodeURIComponent(preview), /<script|href=/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(demo.fetch('/api/session', { signal: abort.signal }), { name: 'AbortError' });
});

test('demo runtime dependency boundary contains no server, filesystem or storage imports', async () => {
  const api = await readFile(new URL('../demo/api.mjs', import.meta.url), 'utf8');
  const fixtures = await readFile(new URL('../demo/fixtures.mjs', import.meta.url), 'utf8');
  const imports = [...api.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports, ['./fixtures.mjs', './fixtures.mjs']);
  assert.doesNotMatch(api + fixtures, /node:|require\(|import\(|localStorage|sessionStorage|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  const first = createFixtures(fixedTime), second = createFixtures(fixedTime);
  first.servers['demo-linux'].inventory.apps.length = 0;
  assert.ok(second.servers['demo-linux'].inventory.apps.length);
});
