import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import ssh2 from 'ssh2';
import { createConnectionStore, securePrivateDirectory, validateConnection } from '../server/connection-store.mjs';
import { configureManagedTransport, fingerprint, managedCommand, managedSpawn, openSshConnection, parseSshArguments, probeHost, readConnectionProfile, shutdownManagedTransport } from '../server/ssh-transport.mjs';
import { bootstrapConnection, linuxInstaller, readAgentBundle, windowsInstaller } from '../server/connection-bootstrap.mjs';
import { createConnectionManager } from '../server/connection-routes.mjs';

const { Server, utils } = ssh2;
const pin = 'SHA256:' + 'A'.repeat(43);
const entry = { name: 'Test server', host: '127.0.0.1', port: 22, platform: 'linux', username: 'operator', authType: 'password', password: 'unique-test-secret', fingerprint: pin };
async function directory(t) {
  const result = await mkdtemp(path.join(os.tmpdir(), 'viios-connections-test-'));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}
async function storeFor(t) {
  const dataDir = await directory(t);
  const store = createConnectionStore({ dataDir, securePermissions: async () => {} });
  await store.initialize(); t.after(() => store.shutdown());
  return { store, dataDir };
}
const until = async predicate => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Condition did not become true');
};

test('connection credentials are encrypted, public records redacted, and endpoint identity authenticated', async t => {
  const { store, dataDir } = await storeFor(t);
  const added = await store.add(entry);
  assert.match(added.id, /^srv-[a-f0-9]{24}$/);
  assert.equal(added.password, undefined);
  assert.equal(store.getSecret(added.id).password, entry.password);
  const filename = path.join(dataDir, 'connections', 'servers.json');
  const raw = await readFile(filename, 'utf8');
  assert.ok(!raw.includes(entry.password));
  assert.ok(!JSON.stringify(store.list()).includes('sealed'));
  await assert.rejects(store.add(entry), { code: 'CONNECTION_EXISTS' });
  const changed = JSON.parse(raw);
  changed.servers[0].fingerprint = 'SHA256:' + 'B'.repeat(43);
  await writeFile(filename, JSON.stringify(changed));
  const reloaded = createConnectionStore({ dataDir, securePermissions: async () => {} });
  await reloaded.initialize(); t.after(() => reloaded.shutdown());
  assert.throws(() => reloaded.getSecret(added.id), { code: 'SECRET_UNAVAILABLE' });
});

test('missing encryption key never silently replaces the key for existing records', async t => {
  const { store, dataDir } = await storeFor(t);
  await store.add(entry); await store.shutdown();
  await rm(path.join(dataDir, 'connections', 'master.key'));
  const reloaded = createConnectionStore({ dataDir, securePermissions: async () => {} });
  await assert.rejects(reloaded.initialize(), { code: 'MISSING_MASTER_KEY' });
  await assert.rejects(stat(path.join(dataDir, 'connections', 'master.key')), { code: 'ENOENT' });
});

test('private directory permissions work on the current controller OS', async t => {
  const target = await directory(t);
  await securePrivateDirectory(target);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test('connection input rejects command syntax, invalid pins, ports and accidental credential types', () => {
  for (const changes of [{ host: '-oProxyCommand=bad' }, { host: 'localhost;whoami' }, { port: 0 }, { port: '22' }, { username: 'root; id' }, { fingerprint: '' }, { authType: 'agent' }]) {
    assert.throws(() => validateConnection({ ...entry, ...changes }));
  }
  assert.equal(validateConnection({ ...entry, host: '::1', username: 'DOMAIN\\administrator', platform: 'windows' }).host, '::1');
});

const hostPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const hostPin = fingerprint(utils.parseKey(hostPrivateKey).getPublicSSH());
const userKeys = utils.generateKeyPairSync('ed25519', { passphrase: 'key-only-passphrase', cipher: 'aes256-cbc', rounds: 4 });
const userPublicKey = utils.parseKey(userKeys.public);
async function sshServer(t) {
  const clients = new Set(), commands = [], inputs = [];
  let authRequests = 0;
  const server = new Server({ hostKeys: [hostPrivateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      authRequests++;
      if (context.method === 'password' && context.username === entry.username && context.password === entry.password) context.accept();
      else if (context.method === 'publickey' && context.username === entry.username && context.key.data.equals(userPublicKey.getPublicSSH()) &&
          (!context.signature || userPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true)) context.accept();
      else context.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec(); commands.push(info.command);
          let input = '';
          channel.on('data', chunk => { input += chunk; });
          channel.on('end', () => { inputs.push(input); channel.write(JSON.stringify({ available: true, input })); channel.exit(0); channel.end(); });
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect({ host: info.destIP, port: info.destPort });
        socket.on('error', reject);
        socket.once('connect', () => { const stream = accept(); stream.on('error', () => socket.destroy()); stream.pipe(socket).pipe(stream); });
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { shutdownManagedTransport(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, commands, inputs, get authRequests() { return authRequests; } };
}

test('real SSH host probe obtains fingerprint without sending authentication', async t => {
  const server = await sshServer(t);
  const result = await probeHost({ host: entry.host, port: server.port, platform: 'linux' });
  assert.equal(result.fingerprint, hostPin);
  assert.equal(result.algorithm, 'ssh-rsa');
  assert.equal(server.authRequests, 0);
});

test('real SSH pinned password authentication works; changed key prevents authentication', async t => {
  const server = await sshServer(t);
  await assert.rejects(openSshConnection({ ...entry, port: server.port, fingerprint: pin }), { code: 'HOST_KEY_CHANGED' });
  assert.equal(server.authRequests, 0);
  const client = await openSshConnection({ ...entry, port: server.port, fingerprint: hostPin });
  client.end();
  assert.ok(server.authRequests > 0);
  await assert.rejects(openSshConnection({ ...entry, port: server.port, fingerprint: hostPin, password: 'wrong-secret' }), { code: 'AUTH_FAILED' });
});

test('real SSH encrypted private key authentication and safe invalid-passphrase errors', async t => {
  const server = await sshServer(t);
  const profile = { ...entry, port: server.port, fingerprint: hostPin, authType: 'key', password: undefined, privateKey: userKeys.private, passphrase: 'key-only-passphrase' };
  const client = await openSshConnection(profile);
  client.end();
  await assert.rejects(openSshConnection({ ...profile, passphrase: 'incorrect' }), error => {
    assert.equal(error.code, 'AUTH_FAILED');
    assert.ok(!error.message.includes('incorrect'));
    assert.ok(!error.message.includes(userKeys.private));
    return true;
  });
});

function childResult(child, input = '') {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}
test('managed runtime forwards JSON stdin to exact Linux helpers over real SSH', async t => {
  const server = await sshServer(t);
  const { store } = await storeFor(t);
  const added = await store.add({ ...entry, port: server.port, fingerprint: hostPin });
  await store.patch(added.id, { status: 'ready', capabilities: { resources: true } });
  configureManagedTransport(store);
  const cmd = 'sudo -n /usr/bin/python3 -I /opt/viios-agent/resources.py';
  const result = await childResult(managedSpawn('ssh', ['-o', 'BatchMode=yes', added.id, cmd]), '{"sample":1}');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).input, '{"sample":1}');
  assert.deepEqual(server.commands, [cmd]);
  assert.equal((await readConnectionProfile({ id: added.id, host: entry.host })).sshTarget, added.id);
  assert.equal(await readConnectionProfile({ id: added.id, host: 'other' }), null);
});

test('managed runtime maps Windows helper calls and forbids arbitrary SSH/config targets', async t => {
  const server = await sshServer(t);
  const { store } = await storeFor(t);
  const added = await store.add({ ...entry, port: server.port, fingerprint: hostPin, platform: 'windows' });
  await store.patch(added.id, { status: 'ready' }); configureManagedTransport(store);
  const result = await childResult(managedSpawn('ssh', [added.id, 'sudo -n /usr/bin/python3 -I /opt/viios-agent/storage.py']), '{"action":"overview"}');
  assert.equal(result.code, 0);
  assert.match(server.commands[0], /-File "C:\\ProgramData\\ViiOS\\agent\\windows-agent.ps1" -Helper storage$/);
  await assert.rejects(childResult(managedSpawn('ssh', ['old-personal-alias', 'id'])), { code: 'UNMANAGED_TARGET' });
  await assert.rejects(childResult(managedSpawn('ssh', [added.id, 'id; curl example.com'])), { code: 'UNSUPPORTED_COMMAND' });
  assert.throws(() => managedCommand('sudo -n /usr/bin/python3 -I /opt/viios-agent/files.py /etc/passwd', 'linux'));
  assert.throws(() => parseSshArguments(['-o']));
});

test('managed loopback forwarding uses SSH channels and closes on removal', async t => {
  const server = await sshServer(t);
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => echo.close(resolve)));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const localPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const { store } = await storeFor(t);
  const profile = await store.add({ ...entry, port: server.port, fingerprint: hostPin });
  await store.patch(profile.id, { status: 'ready' }); configureManagedTransport(store);
  const child = managedSpawn('ssh', ['-N', '-L', '127.0.0.1:' + localPort + ':127.0.0.1:' + echo.address().port, profile.id]);
  let error;
  child.on('error', failure => { error = failure; });
  await until(() => new Promise(resolve => {
    const socket = net.connect({ port: localPort, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  }));
  assert.equal(error, undefined);
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect({ port: localPort, host: '127.0.0.1' }, () => socket.write('SSH preview'));
    socket.on('error', reject);
    socket.on('data', chunk => { socket.destroy(); resolve(chunk.toString()); });
  });
  assert.equal(received, 'SSH preview');
  child.kill();
  assert.equal(child.killed, true);
});

function bootstrapFixture(platform, { root = false, administrator = true, unavailable = null, aclTools = true, aclProbeError = false, dependenciesFail = false } = {}) {
  const commands = [], uploads = [];
  const client = { end() {}, destroy() {} };
  const sftp = {
    realpath(_path, callback) { callback(null, '/C:/Users/Administrator'); },
    mkdir(_path, _options, callback) { callback(); },
    fastPut(filename, destination, _options, callback) { uploads.push({ filename, destination }); callback(); },
    unlink(_path, callback) { callback(); }, rmdir(_path, callback) { callback(); },
  };
  const io = {
    async openSshConnection() { return client; },
    async withSftp(_client, action) { return action(sftp); },
    async executeSsh(_client, command, options = {}) {
      commands.push({ command, ...options });
      const ok = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
      if (command === 'uname -s && id -u') return { code: 0, stdout: 'Linux\n' + (root ? '0' : '1000') + '\n' };
      if (command === 'sudo -n true') return { code: 1, stdout: '' };
      if (command === "sudo -k -S -p '' true") return ok({});
      if (command.includes('/bin/sh -c') && command.includes('command -v getfacl')) {
        if (aclProbeError) throw new Error('Synthetic optional probe failure');
        return { code: aclTools ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command.includes('/bin/sh -c')) return dependenciesFail ? { code: 1, stdout: '', stderr: 'Synthetic core dependency failure' } : ok({});
      if (command.includes(' -c ')) return ok({ installed: true });
      if (command.includes('-EncodedCommand')) {
        const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
        return script.includes('OSVersion') ? ok({ os: platform === 'windows' ? 'Win32NT' : 'Unix', administrator }) : ok({ installed: true });
      }
      if (command.endsWith('-Helper capabilities')) return ok({ available: true, capabilities: { inventory: true, resources: true, storage: true, files: true, control: true, models: true, versions: false }, limitations: { versions: 'Unavailable' } });
      if (unavailable && command.includes(unavailable)) return ok({ available: false });
      if (command.endsWith('scan.py 1 65535')) return ok({ apps: [] });
      if (command.endsWith('model_catalog.py')) return ok({ models: [] });
      if (command.endsWith('model_concurrency.py')) return ok({ services: [] });
      if (command.endsWith('control.py')) return ok({ ok: true });
      return ok({ available: true });
    },
  };
  return { io, commands, uploads };
}

test('Linux bootstrap stages manifest, validates capabilities, sends sudo secret only through stdin', async () => {
  const fixture = bootstrapFixture('linux', { unavailable: 'versioning.py' }), phases = [];
  const result = await bootstrapConnection(entry, { io: fixture.io, sudoPassword: 'sudo-secret-never-argv', onProgress: async update => phases.push(update.phase) });
  assert.equal(result.resources, true); assert.equal(result.inventory, true); assert.equal(result.models, true);
  assert.equal(result.aclTools, true);
  assert.equal(result.versions, false); assert.equal(result.uat, false);
  assert.ok(fixture.uploads.length >= 10);
  assert.ok(fixture.commands.every(item => !item.command.includes(entry.password) && !item.command.includes('sudo-secret-never-argv')));
  assert.ok(fixture.commands.some(item => item.input === 'sudo-secret-never-argv\n'));
  assert.deepEqual(phases, ['connecting', 'checking', 'dependencies', 'uploading', 'installing', 'verifying']);
});

test('Linux root bootstrap requires no sudo password; installers pin contents and protected paths', async () => {
  const fixture = bootstrapFixture('linux', { root: true });
  await bootstrapConnection({ ...entry, username: 'root' }, { io: fixture.io });
  assert.ok(!fixture.commands.some(item => item.command.startsWith('sudo -k')));
  const files = await readAgentBundle('linux');
  const script = linuxInstaller({ stage: '/tmp/staging', release: 'a'.repeat(24), files, username: 'root', host: '127.0.0.1' });
  assert.ok(script.includes('os.O_NOFOLLOW'));
  assert.ok(script.includes('hashlib.sha256(content).hexdigest()'));
  assert.ok(script.includes('visudo'));
  assert.ok(script.includes('os.environ["PATH"]="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'));
  assert.ok(!script.includes('NOPASSWD: ALL'));
  assert.ok(!script.includes('shell=True'));
});

test('Linux bootstrap accepts missing optional ACL tools without requiring an ACL package', async () => {
  for (const root of [true, false]) {
    const fixture = bootstrapFixture('linux', { root, aclTools: false });
    const result = await bootstrapConnection({ ...entry, username: root ? 'root' : 'operator' }, { io: fixture.io });
    assert.equal(result.aclTools, false);
    assert.equal(result.files, true);
    assert.equal(result.storage, true);
    assert.equal(result.versions, true);
    const dependency = fixture.commands.find(item => item.timeoutMs === 600000);
    assert.ok(dependency);
    assert.doesNotMatch(dependency.command, /\b(?:acl|setfacl|getfacl)\b/);
    assert.ok(dependency.command.includes('export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
    const fastPath = dependency.command.split('\n').find(line => line.startsWith('if command -v python3'));
    assert.ok(fastPath.endsWith('then exit 0; fi'));
    for (const tool of ['python3', 'ss', 'git', 'visudo', 'useradd']) assert.ok(fastPath.includes('command -v ' + tool));
    const probe = fixture.commands.find(item => item.command.includes('command -v getfacl'));
    assert.ok(probe.command.startsWith('/bin/sh -c'));
    assert.ok(probe.command.includes('command -v setfacl'));
    assert.equal(probe.input, undefined);
    assert.doesNotMatch(probe.command, /\b(?:apt-get|dnf|yum|zypper|apk|pacman|sudo)\b/);
    assert.ok(result.reasons.aclTools.includes('dosya sisteminin ACL desteği hakkında bilgi vermez'));
  }
});

test('optional ACL probe failure does not fail setup, but core dependency failure still does', async () => {
  const optional = bootstrapFixture('linux', { root: true, aclProbeError: true });
  const result = await bootstrapConnection({ ...entry, username: 'root' }, { io: optional.io });
  assert.equal(result.aclTools, false);
  assert.equal(result.files, true);
  const required = bootstrapFixture('linux', { root: true, dependenciesFail: true });
  await assert.rejects(bootstrapConnection({ ...entry, username: 'root' }, { io: required.io }), error => {
    assert.equal(error.code, 'DEPENDENCIES_FAILED');
    assert.ok(!error.message.includes('ACL'));
    return true;
  });
  assert.equal(required.uploads.length, 0);
  assert.ok(!required.commands.some(item => item.command.includes('command -v getfacl')));
});

test('Windows bootstrap detects admin before uploading and preserves capability gaps', async () => {
  const fixture = bootstrapFixture('windows');
  const result = await bootstrapConnection({ ...entry, platform: 'windows' }, { io: fixture.io });
  assert.equal(result.files, true); assert.equal(result.versions, false); assert.equal(result.concurrency, false);
  assert.equal(Object.hasOwn(result, 'aclTools'), false);
  assert.equal(fixture.uploads.length, 1);
  const rejected = bootstrapFixture('windows', { administrator: false });
  await assert.rejects(bootstrapConnection({ ...entry, platform: 'windows' }, { io: rejected.io }), { code: 'ADMIN_REQUIRED' });
  assert.equal(rejected.uploads.length, 0);
  const script = windowsInstaller({ stage: '/C:/Users/Admin/stage', file: { name: 'windows-agent.ps1', sha256: 'a'.repeat(64) } });
  assert.ok(script.includes('Get-FileHash'));
  assert.ok(script.includes('SetAccessRuleProtection($true,$false)'));
  assert.ok(script.includes('[IO.File]::Replace'));
});

test('manager bounds concurrent bootstrap, coalesces retry and deletes local registration only', async t => {
  const { store } = await storeFor(t);
  const releases = [], ready = [], removed = [];
  let running = 0, highest = 0;
  const manager = createConnectionManager({ store, onReady: profile => ready.push(profile.id), onRemove: id => removed.push(id), bootstrap: async (_profile, { signal }) => {
    running++; highest = Math.max(highest, running);
    await new Promise(resolve => { releases.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
    running--; return { inventory: true };
  } });
  await manager.initialize(); t.after(() => manager.shutdown());
  const first = await manager.add(entry);
  const second = await manager.add({ ...entry, host: '127.0.0.2' });
  const third = await manager.add({ ...entry, host: '127.0.0.3' });
  assert.equal(highest, 2);
  await manager.retry(first.id);
  assert.equal(releases.length, 2);
  await manager.remove(third.id);
  assert.equal(manager.list().length, 2);
  releases.shift()(); releases.shift()();
  await until(() => ready.length === 2);
  assert.equal(manager.get(second.id).status, 'ready');
  assert.deepEqual(removed, [third.id]);
  await manager.remove(first.id);
  assert.throws(() => manager.get(first.id), { code: 'CONNECTION_NOT_FOUND' });
});

test('manager sanitizes unknown failure details and marks interrupted installs on restart', async t => {
  const { store } = await storeFor(t);
  const interrupted = await store.add(entry);
  const manager = createConnectionManager({ store, bootstrap: async () => { throw new Error('password=' + entry.password); } });
  await manager.initialize(); t.after(() => manager.shutdown());
  assert.equal(manager.get(interrupted.id).errorCode, 'INTERRUPTED');
  await manager.retry(interrupted.id);
  await until(() => manager.get(interrupted.id).status === 'error');
  assert.ok(!JSON.stringify(manager.list()).includes(entry.password));
  assert.equal(manager.get(interrupted.id).errorCode, 'BOOTSTRAP_FAILED');
});
