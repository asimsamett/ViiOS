import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createExportTransfers } from '../server/file-exports.mjs';

class Response extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
    this.headers = {};
    this.bytes = 0;
    this.statusCode = 200;
  }
  _write(chunk, _encoding, callback) {
    this.headersSent = true;
    this.bytes += chunk.length;
    setImmediate(() => callback());
  }
  setHeader(name, value) {
    this.headers[name] = value;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.body = body;
    this.end();
    return this;
  }
}
const request = {
  action: 'export',
  path: '/home/project',
  revision: 'a'.repeat(64),
};
function fixture(source) {
  return createExportTransfers({
    openStream: async () =>
      spawn(process.execPath, ['-e', source], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
  });
}
const prefix = `process.stdin.once('data', async () => {`;
const meta = `process.stdout.write(JSON.stringify({ok:true,name:'project.zip',bytes:220000000,entries:80000})+'\\n');`;

test('large export streams past the old ZIP limit with backpressure and finishes only after child success', async () => {
  const transfers = fixture(
    prefix +
      meta +
      `for(let i=0;i<320;i++){if(!process.stdout.write(Buffer.alloc(65536)))await new Promise(r=>process.stdout.once('drain',r));}process.stdout.end(()=>process.exit(0));});`,
  );
  const job = transfers.create(request),
    response = new Response();
  await transfers.download(job.id, { method: 'GET', headers: {} }, response);
  assert.equal(transfers.status(job.id).state, 'complete');
  assert.equal(response.bytes, 20 * 1024 * 1024);
  assert.equal(response.writableFinished, true);
  assert.equal(transfers.status(job.id).entries, 80000);
  assert.equal(transfers.status(job.id).sourceBytes, 220000000);
  await assert.rejects(
    transfers.download(job.id, { method: 'GET', headers: {} }, new Response()),
    { status: 409 },
  );
  transfers.shutdown();
});

test('pre-header failure retains the detailed reason and failed partial ZIP is never completed', async () => {
  for (const started of [false, true]) {
    const transfers = fixture(
      prefix +
        (started ? meta + `process.stdout.write(Buffer.alloc(512));` : '') +
        `process.stderr.write(JSON.stringify({error:'Kaynak işlem sırasında değişti.',status:409})+'\\n',()=>process.exit(1));});`,
    );
    const job = transfers.create(request),
      response = new Response();
    await transfers.download(job.id, { method: 'GET', headers: {} }, response);
    assert.equal(transfers.status(job.id).state, 'failed');
    assert.equal(
      transfers.status(job.id).error,
      'Kaynak işlem sırasında değişti.',
    );
    if (started) {
      assert.equal(response.destroyed, true);
      assert.equal(response.writableFinished, false);
    } else {
      assert.equal(response.statusCode, 409);
      assert.equal(response.body.error, 'Kaynak işlem sırasında değişti.');
    }
    transfers.shutdown();
  }
});

test('cancel and HTTP disconnect stop a running download without marking success', async () => {
  for (const explicit of [true, false]) {
    const transfers = fixture(
      prefix +
        meta +
        `process.stdout.write(Buffer.alloc(1024));setInterval(()=>process.stdout.write(Buffer.alloc(1024)),20);});`,
    );
    const job = transfers.create(request),
      response = new Response();
    const running = transfers.download(
      job.id,
      { method: 'GET', headers: {} },
      response,
    );
    await new Promise((resolve) => response.once('drain', resolve));
    if (explicit) transfers.cancel(job.id);
    else response.destroy();
    await running;
    assert.equal(transfers.status(job.id).state, 'cancelled');
    assert.equal(response.writableFinished, false);
    transfers.shutdown();
  }
});

test('a download job cannot be consumed twice while target setup is pending', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const transfers = createExportTransfers({
    openStream: async () => {
      await gate;
      throw Object.assign(new Error('Hedef kullanılamıyor.'), { status: 403 });
    },
  });
  const job = transfers.create(request),
    response = new Response();
  const running = transfers.download(
    job.id,
    { method: 'GET', headers: {} },
    response,
  );
  await assert.rejects(
    transfers.download(job.id, { method: 'GET', headers: {} }, new Response()),
    { status: 409 },
  );
  release();
  await running;
  assert.equal(transfers.status(job.id).state, 'failed');
  const other = fixture('');
  assert.throws(() => other.status(job.id), { status: 404 });
  transfers.shutdown();
  other.shutdown();
});
