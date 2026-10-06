import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  validateVersionRequest,
  versionRouter,
} from '../server/versioning.mjs';
import { protectWrites, createAuth, hashPassword } from '../server/auth.mjs';
import { apiErrorMiddleware } from '../server/http-errors.mjs';

test('version requests reject unknown actions, command arguments, traversal, and malformed revisions', () => {
  const revision = 'a'.repeat(64),
    id = 'b'.repeat(32);
  assert.ok(
    validateVersionRequest({
      action: 'commit',
      id,
      revision,
      message: 'Yeni sürüm',
    }),
  );
  assert.ok(
    validateVersionRequest({
      action: 'workingFileDiff',
      id,
      file: 'src/app.ts',
    }),
  );
  assert.ok(validateVersionRequest({ action: 'graph', id }));
  assert.ok(validateVersionRequest({ action: 'treeFiles', id, commit: 'a'.repeat(40) }));
  assert.ok(validateVersionRequest({ action: 'treeFile', id, commit: 'a'.repeat(40), file: 'src/app.ts' }));
  for (const body of [
    null,
    { action: 'push' },
    { action: 'prepare', path: '/etc', revision, command: 'id' },
    { action: 'prepare', path: '/home/project', revision: 'invalid' },
    { action: 'restore-access', receipt: id },
    { action: 'timeline', id, offset: -1 },
    { action: 'timeline', id, offset: '0' },
    { action: 'fileDiff', id, commit: 'a'.repeat(40), file: '../secret' },
    { action: 'workingFileDiff', id, file: '../secret' },
    { action: 'treeFile', id, commit: 'a'.repeat(40), file: '../secret' },
    { action: 'graph', id, command: 'push' },
    { action: 'workingFileDiff', id, file: 'src/app.ts', command: 'id' },
    { action: 'inspect', path: '/home/../etc' },
    { action: 'inspect', path: '/home/demo', command: 'id' },
    { action: 'commit', id, revision: 'HEAD' },
    { action: 'restore', id, revision, commit: '--help' },
    { action: 'commit', id, revision, message: 'a'.repeat(301) },
  ])
    assert.throws(() => validateVersionRequest(body));
});

test('only explicit ACL broker errors survive the version router and controller error response', async t => {
  let brokerResult;
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.once('finish', () => queueMicrotask(() => {
      child.stdout.end(JSON.stringify(brokerResult)); child.emit('close', 0);
    }));
    return child;
  };
  const app = express();
  app.use(express.json());
  app.use('/versions', versionRouter({ id: 'fixture', host: '192.0.2.20' }, {
    spawnProcess, readProfile: async () => ({ transport: 'local', capabilities: { versions: true } }),
  }));
  app.get('/generic-denial', () => { throw Object.assign(new Error('Klasör kapsam dışında.'), { status: 403 }); });
  app.get('/unexpected', () => { throw Object.assign(new Error('Private operating-system detail'), { code: 'EACCES' }); });
  app.use(apiErrorMiddleware);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = body => fetch(origin + '/versions/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const [code, status] of [['ACL_UNSUPPORTED', 501], ['ACL_ACCESS_DENIED', 403], ['ACL_UPDATE_FAILED', 409]]) {
    brokerResult = { error: 'Fixture ACL error', code, status };
    const response = await request({ action: 'inspect', path: '/home/example' });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: brokerResult.error, code });
    assert.ok(calls.at(-1).args.at(-1).endsWith('versioning_access.py'));
  }
  brokerResult = { error: 'ACL erişimi hazırlanamadı.', status: 403 };
  assert.deepEqual(await (await request({ action: 'inspect', path: '/home/example' })).json(), { error: brokerResult.error }, 'message text alone never creates an ACL code');
  brokerResult = { error: 'Fixture policy denial', status: 403, code: 'PRIVATE_UNKNOWN_CODE' };
  assert.deepEqual(await (await request({ action: 'inspect', path: '/home/example' })).json(), { error: brokerResult.error });
  brokerResult = { error: 'Fixture Git denial', status: 403, code: 'ACL_ACCESS_DENIED' };
  assert.deepEqual(await (await request({ action: 'status', id: 'a'.repeat(32) })).json(), { error: brokerResult.error }, 'unprivileged Git broker cannot classify ACL operations');
  assert.deepEqual(await (await fetch(origin + '/generic-denial')).json(), { error: 'Klasör kapsam dışında.' });
  assert.deepEqual(await (await fetch(origin + '/unexpected')).json(), { error: 'İşlem tamamlanamadı.' });
});

test('version API uses session and CSRF protection and rejects unsupported targets before invoking Git', async () => {
  const app = express();
  const auth = createAuth(hashPassword('test-version-password'));
  app.use(protectWrites, express.json());
  app.post('/login', auth.login);
  app.use(
    '/versions',
    auth.require,
    versionRouter({ id: 'ip-40', host: '192.0.2.40', mode: 'network' }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(origin + '/versions/capabilities')).status, 401);
    assert.equal(
      (await fetch(origin + '/versions/action', { method: 'POST' })).status,
      403,
    );
    const login = await fetch(origin + '/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Management-Request': '1',
      },
      body: JSON.stringify({ password: 'test-version-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const cap = await fetch(origin + '/versions/capabilities', {
      headers: { cookie },
    });
    assert.equal((await cap.json()).available, false);
    const result = await fetch(origin + '/versions/action', {
      method: 'POST',
      headers: {
        cookie,
        'X-Management-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'list' }),
    });
    assert.equal(result.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
