import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const noticeUrl = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('../app/acl-errors.ts', import.meta.url), 'utf8')));
const { notifyAclError, ACL_ERROR_EVENT } = await import(noticeUrl);
const apiSource = stripTypeScriptTypes(readFileSync(new URL('../app/api.ts', import.meta.url), 'utf8'))
  .replace("import { DEMO_MODE } from '@/lib/public-mode';", 'const DEMO_MODE = false;')
  .replace("from './acl-errors'", `from '${noticeUrl}'`);
const { api } = await import(moduleUrl(apiSource));

function browser(t) {
  const target = new EventTarget();
  target.location = { href: 'http://localhost:3180/' };
  const previous = globalThis.window;
  globalThis.window = target;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const notices = [];
  target.addEventListener(ACL_ERROR_EVENT, event => notices.push(event.detail));
  return notices;
}

test('ACL error reaches both the global popup transport and the calling UI', async t => {
  const notices = browser(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ error: 'Dosya sistemi ACL desteklemiyor.', code: 'ACL_UNSUPPORTED' }, { status: 501 });
  await assert.rejects(api('/servers/example/versions/action', { method: 'POST', body: JSON.stringify({ action: 'prepare', path: '/srv/example' }) }), error => {
    assert.equal(error.code, 'ACL_UNSUPPORTED');
    assert.equal(error.status, 501);
    assert.equal(error.message, 'Dosya sistemi ACL desteklemiyor.');
    return true;
  });
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], { code: 'ACL_UNSUPPORTED', message: 'Dosya sistemi ACL desteklemiyor.', operation: 'Proje erişimini hazırlama', endpoint: '/api/servers/example/versions/action' });
});

test('all supported ACL codes notify without consuming the original response', async t => {
  const notices = browser(t);
  for (const code of ['ACL_UNSUPPORTED', 'ACL_ACCESS_DENIED', 'ACL_UPDATE_FAILED']) {
    const body = { code, error: 'Örnek ACL hatası' };
    const response = Response.json(body, { status: 403 });
    await notifyAclError(response, new URL('http://localhost:3180/api/versions/action'), { body: '{"action":"inspect"}' });
    assert.deepEqual(await response.json(), body);
  }
  assert.equal(notices.length, 3);
  assert.ok(notices.every(notice => notice.operation === 'Proje erişimini inceleme'));
});

test('generic permission errors, successful bodies, non-JSON and cancelled requests do not open ACL popups', async t => {
  const notices = browser(t);
  for (const response of [
    Response.json({ error: 'Erişim reddedildi.' }, { status: 403 }),
    Response.json({ error: 'ACL metni tek başına yeterli değildir.', code: 'EACCES' }, { status: 403 }),
    Response.json({ code: 'ACL_UNSUPPORTED' }),
    new Response('Service unavailable', { status: 503 }),
    Response.json(null, { status: 500 }),
  ]) await notifyAclError(response, '/api/versions/action');
  const controller = new AbortController();
  controller.abort();
  await notifyAclError(Response.json({ code: 'ACL_UNSUPPORTED' }, { status: 501 }), '/api/versions/action', { signal: controller.signal });
  assert.deepEqual(notices, []);
});
