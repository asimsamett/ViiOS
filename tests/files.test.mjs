import {configureManagedTransport} from '../server/ssh-transport.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileManager, validateFileRequest } from '../server/files.mjs';

test('file action request rejects command fields, invalid paths and unknown actions', () => {
  for (const body of [
    { action: 'exec', command: 'id' },
    {
      action: 'copy',
      path: '/home/file',
      destination: '/home/other',
      command: 'id',
    },
    { action: 'read', path: 42 },
    { action: 'read', path: 'relative' },
    { action: 'read', path: '/home/a\0b' },
    null,
  ])
    assert.throws(() => validateFileRequest(body), { status: 400 });
  assert.equal(
    validateFileRequest({
      action: 'write',
      path: '/home/app.py',
      content: 'pass',
      revision: 'abc',
    }).action,
    'write',
  );
});
test('unsupported target and wrong host never invoke a file broker', async () => {
  const log = async () => {
    throw new Error('No writes expected.');
  };
  for (const config of [
    { id: 'ip-40', host: '192.0.2.40', mode: 'network' },
    { id: 'fixture', host: '192.0.2.41', mode: 'local' },
  ]) {
    const files = createFileManager({ ...config, log });
    assert.equal(
      (await files.invoke({ action: 'capabilities' })).available,
      false,
    );
    await assert.rejects(
      files.invoke({ action: 'create', path: '/home/a', content: 'bad' }),
      { status: 403 },
    );
    await assert.rejects(
      files.invoke({ action: 'search', path: '/', query: 'report' }),
      { status: 403 },
    );
    await assert.rejects(
      files.invoke({ action: 'properties', path: '/home/project' }),
      { status: 403 },
    );
    await assert.rejects(
      files.invoke({
        action: 'export',
        path: '/home/project',
        revision: 'a'.repeat(64),
      }),
      { status: 403 },
    );
    files.shutdown();
  }
});

test('export requires a target path and revision and rejects command options', () => {
  assert.equal(
    validateFileRequest({
      action: 'export',
      path: '/home/project',
      revision: 'a'.repeat(64),
    }).action,
    'export',
  );
  for (const body of [
    { action: 'export', path: '/home/project' },
    { action: 'export', path: '/home/project', revision: 'bad' },
    { action: 'export', revision: 'a'.repeat(64) },
    {
      action: 'export',
      path: '/home/project',
      revision: 'a'.repeat(64),
      command: 'zip -r',
    },
  ])
    assert.throws(() => validateFileRequest(body), { status: 400 });
});

test('legacy JSON export cannot allocate an unbounded archive instead of streaming', async () => {
  configureManagedTransport({get:()=>({id:'srv-'+ 'a'.repeat(24),host:'192.0.2.1',status:'ready',platform:'linux',capabilities:{files:true}})});
  const files = createFileManager({
    id: 'srv-'+ 'a'.repeat(24),
    host: '192.0.2.1',
    mode: 'ssh',
    log: async () => {},
  });
  await assert.rejects(
    files.invoke({
      action: 'export',
      path: '/home/project',
      revision: 'a'.repeat(64),
    }),
    { status: 409 },
  );
  files.shutdown();
});

test('search accepts a bounded query without command or traversal options', () => {
  assert.equal(
    validateFileRequest({
      action: 'search',
      path: '/',
      query: 'rapor',
      hidden: false,
    }).query,
    'rapor',
  );
  for (const body of [
    { action: 'search', query: 'a' },
    { action: 'search', query: ' ' },
    { action: 'search', query: 'x'.repeat(121) },
    { action: 'search', query: 'report', hidden: 'yes' },
    { action: 'search', query: 'report', command: 'find /' },
  ])
    assert.throws(() => validateFileRequest(body), { status: 400 });
});

test('properties requests require a path and cannot inject command or traversal controls', () => {
  assert.equal(
    validateFileRequest({ action: 'properties', path: '/home/project' }).action,
    'properties',
  );
  for (const body of [
    { action: 'properties' },
    { action: 'properties', path: '/home/project', command: 'du -sh /' },
    { action: 'properties', path: '/home/project', followLinks: true },
  ])
    assert.throws(() => validateFileRequest(body), { status: 400 });
});
