import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyPublicSources, normalizeDemoBasePath } from '../scripts/build-demo.mjs';
import { createDemoServer } from '../scripts/serve-demo.mjs';

function sourceFixture(extra = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'viios-demo-source-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  writeFileSync(path.join(root, 'public-source-files.json'), JSON.stringify(['public-source-files.json', 'package.json', ...extra]));
  return root;
}

test('isolated demo staging copies only reviewed files, never adjacent runtime or environment data', () => {
  const root = sourceFixture(['.env.example']);
  writeFileSync(path.join(root, '.env.example'), 'APP_PORT=3180\n');
  writeFileSync(path.join(root, '.env.local'), 'PRIVATE_FIXTURE=never-stage\n');
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'admin.json'), 'private-fixture');
  const staged = mkdtempSync(path.join(os.tmpdir(), 'viios-demo-staged-'));
  assert.equal(copyPublicSources(root, staged), 3);
  assert.deepEqual(readdirSync(staged).sort(), ['.env.example', 'package.json', 'public-source-files.json']);
  assert.equal(readFileSync(path.join(root, 'data', 'admin.json'), 'utf8'), 'private-fixture');
});

test('the demo source manifest cannot opt runtime files, credentials or traversal back into a build', () => {
  for (const name of ['data/admin.json', '.env.local', 'app/.env', 'outputs/example.json', 'server/servers.json', 'server/access.key', '../outside.txt', 'app/../outside.txt', 'C:/secret.txt']) {
    const root = sourceFixture([name]);
    const staged = mkdtempSync(path.join(os.tmpdir(), 'viios-demo-blocked-'));
    assert.throws(() => copyPublicSources(root, staged), /source path|Private artifact/);
  }
});

test('demo base paths support repository subpaths but reject URL and filesystem escapes', () => {
  assert.equal(normalizeDemoBasePath(''), '');
  assert.equal(normalizeDemoBasePath('/'), '');
  assert.equal(normalizeDemoBasePath('/Example-Repo/'), '/Example-Repo');
  assert.equal(normalizeDemoBasePath('/docs/demo'), '/docs/demo');
  for (const name of ['../demo', '/..', '/repo/../other', '//host', 'https://example.test/demo', '/repo?token=x', '/repo#section', '/repo\\file']) assert.throws(() => normalizeDemoBasePath(name));
});

test('the preview serves only static files at its base path and has no API or traversal fallback', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'viios-demo-static-'));
  writeFileSync(path.join(directory, 'index.html'), '<main>Fixture demo</main>');
  writeFileSync(path.join(directory, 'index.txt'), 'fixture-rsc');
  writeFileSync(path.join(directory, '.env'), 'never-serve');
  mkdirSync(path.join(directory, '_next', 'static'), { recursive: true });
  writeFileSync(path.join(directory, '_next', 'static', 'app.js'), 'export const demo = true;');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'viios-demo-outside-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'never-serve');
  symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = createDemoServer(directory, '/example-repo');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redirect = await fetch(origin, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/example-repo/');
  assert.equal(await (await fetch(origin + '/example-repo/')).text(), '<main>Fixture demo</main>');
  const script = await fetch(origin + '/example-repo/_next/static/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(await (await fetch(origin + '/example-repo/index.txt')).text(), 'fixture-rsc');
  for (const url of ['/api/setup', '/example-repo/api/setup', '/example-repo/.env', '/example-repo/linked/secret.txt', '/example-repo/%2e%2e%2fsecret.txt', '/_next/static/app.js']) {
    const response = await fetch(origin + url);
    assert.ok([400, 404].includes(response.status), `${url} must not be served`);
    assert.ok(!(await response.text()).includes('never-serve'));
  }
  assert.equal((await fetch(origin + '/example-repo/api/login', { method: 'POST', body: '{}' })).status, 405);
});
