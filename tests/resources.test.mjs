import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resourceConnection,
  sharedResourceSample,
  createResourceMonitor,
} from '../server/resources.mjs';

test('resource sampling cannot redirect a configured target or accept arbitrary SSH syntax', async () => {
  const profiles = {
    fixture: { host: '192.0.2.42', transport: 'auto', sshTarget: 'fixture' },
  };
  assert.equal(
    resourceConnection(profiles, {
      id: 'fixture',
      host: '192.0.2.42',
      mode: 'local',
    }).transport,
    'local',
  );
  assert.equal(
    resourceConnection(profiles, {
      id: 'fixture',
      host: '192.0.2.43',
      mode: 'local',
    }),
    null,
  );
  assert.equal(
    resourceConnection(
      { fixture: { ...profiles.fixture, sshTarget: '-oProxyCommand=id' } },
      { id: 'fixture', host: '192.0.2.42', mode: 'ssh' },
    ),
    null,
  );
  const unsupported = createResourceMonitor({
    id: 'ip-40',
    host: '192.0.2.40',
    mode: 'network',
  });
  assert.equal((await unsupported.read()).available, false);
  unsupported.shutdown();
});

test('concurrent clients share one sample and refresh after the cache interval', async () => {
  let calls = 0,
    now = 0;
  const read = sharedResourceSample(
    async () => {
      await Promise.resolve();
      return { sample: ++calls };
    },
    () => now,
  );
  const values = await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  assert.equal(values[0], values[1]);
  now = 249;
  await read();
  assert.equal(calls, 1);
  now = 250;
  await read();
  assert.equal(calls, 2);
});

test('failed samples are retried and never published as fresh zeros', async () => {
  let attempt = 0;
  const read = sharedResourceSample(async () => {
    if (++attempt === 1) throw new Error('unavailable');
    return { cpu: null };
  });
  await assert.rejects(read(), /unavailable/);
  assert.deepEqual(await read(), { cpu: null });
});
