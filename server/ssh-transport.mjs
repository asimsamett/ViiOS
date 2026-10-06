import ssh2 from 'ssh2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nativeSpawn } from 'node:child_process';
import net from 'node:net';
import { CONNECTION_ID, FINGERPRINT, connectionError, validateAddress } from './connection-store.mjs';

const { Client } = ssh2;
let managedStore;
let ManagedClient = Client;
const live = new Map();
export function configureManagedTransport(store, { ClientClass = Client } = {}) { managedStore = store; ManagedClient = ClientClass; }
export function fingerprint(key) { return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }
function sameFingerprint(actual, expected) {
  return FINGERPRINT.test(expected || '') && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function sanitizedSshError(error, mismatch = false) {
  if (mismatch) return connectionError('HOST_KEY_CHANGED', 'Sunucu anahtarı onaylanan parmak iziyle eşleşmiyor. Bağlantı durduruldu.', 409);
  if (error?.level === 'client-authentication' || /authentication|privatekey|key format/i.test(error?.message || ''))
    return connectionError('AUTH_FAILED', 'SSH kimlik doğrulaması başarısız. Kullanıcı ve şifre/anahtar bilgilerini kontrol edin.', 401);
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') return connectionError('CONNECTION_TIMEOUT', 'SSH bağlantısı zaman aşımına uğradı.', 503);
  return connectionError('SSH_UNAVAILABLE', 'SSH bağlantısı kurulamadı. Adres, port ve SSH hizmetini kontrol edin.', 503);
}

export function probeHost(input, { ClientClass = Client, timeoutMs = 15000 } = {}) {
  const { host, port } = validateAddress(input);
  return new Promise((resolve, reject) => {
    const client = new ClientClass();
    let done = false, captured;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(connectionError('CONNECTION_TIMEOUT', 'SSH sunucu anahtarı alınamadı; bağlantı zaman aşımı.', 503)), timeoutMs);
    client.on('error', error => captured ? finish(null, captured) : finish(sanitizedSshError(error)));
    client.on('close', () => { if (!done) finish(connectionError('SSH_UNAVAILABLE', 'Sunucu anahtarı alınamadı.', 503)); });
    try {
      client.connect({ host, port, username: 'viios-fingerprint-probe', readyTimeout: timeoutMs,
        hostVerifier: key => {
          const length = key.length >= 4 ? key.readUInt32BE(0) : 0;
          const algorithm = length > 0 && length < 128 && key.length >= length + 4 ? key.subarray(4, 4 + length).toString('ascii') : 'SSH';
          // Abort before any authentication request or credential transmission.
          captured = { fingerprint: fingerprint(key), algorithm };
          queueMicrotask(() => finish(null, captured));
          return false;
        },
      });
    } catch (error) { finish(sanitizedSshError(error)); }
  });
}

export function openSshConnection(profile, { ClientClass = ManagedClient, timeoutMs = 20000 } = {}) {
  if (!FINGERPRINT.test(profile.fingerprint || '')) return Promise.reject(connectionError('HOST_KEY_REQUIRED', 'Sunucu anahtarı onaylanmadı.', 409));
  return new Promise((resolve, reject) => {
    const client = new ClientClass();
    let mismatch = false, ready = false;
    client.on('error', error => { if (!ready) { client.destroy(); reject(sanitizedSshError(error, mismatch)); } });
    client.once('ready', () => { ready = true; resolve(client); });
    client.once('close', () => { if (!ready) reject(sanitizedSshError(null, mismatch)); });
    try {
      client.connect({ host: profile.host, port: profile.port, username: profile.username,
        ...(profile.authType === 'key' ? { privateKey: profile.privateKey, passphrase: profile.passphrase } : { password: profile.password }),
        readyTimeout: timeoutMs, keepaliveInterval: 10000, keepaliveCountMax: 2,
        hostVerifier: key => { const matched = sameFingerprint(fingerprint(key), profile.fingerprint); mismatch = !matched; return matched; },
      });
    } catch (error) { client.destroy(); reject(sanitizedSshError(error, mismatch)); }
  });
}

export async function readConnectionProfile(config) {
  if (!managedStore || !CONNECTION_ID.test(config.id || '')) return null;
  const profile = managedStore.get(config.id);
  if (!profile || profile.host !== config.host || profile.status !== 'ready') return null;
  return { ...profile, transport: 'ssh', sshTarget: profile.id };
}
export function closeManagedConnection(id) { for (const child of live.get(id) || []) child.kill(); live.delete(id); }
export function shutdownManagedTransport() { for (const id of live.keys()) closeManagedConnection(id); }

export function parseSshArguments(args) {
  let index = 0, configOnly = false, forwarding = null, noCommand = false;
  while (index < args.length && String(args[index]).startsWith('-')) {
    const option = args[index++];
    if (option === '-o') { if (typeof args[index++] !== 'string') throw new Error('Missing SSH option'); }
    else if (option === '-T') continue;
    else if (option === '-G') configOnly = true;
    else if (option === '-N') noCommand = true;
    else if (option === '-L') forwarding = args[index++];
    else throw new Error('Unsupported SSH option');
  }
  const target = args[index++];
  if (!CONNECTION_ID.test(target || '')) throw connectionError('UNMANAGED_TARGET', 'Yalnız ViiOS içine eklenen sunuculara bağlanılabilir.', 403);
  const command = args.slice(index).join(' ');
  if ((!command && !noCommand && !configOnly) || (noCommand && (!forwarding || command))) throw new Error('Invalid SSH request');
  return { target, command, configOnly, forwarding, noCommand };
}

const helperMap = {
  'scan.py': 'scan', 'resources.py': 'resources', 'storage.py': 'storage', 'files.py': 'files',
  'control.py': 'control', 'versioning.py': 'versions', 'versioning_access.py': 'versions',
  'model_catalog.py': 'models', 'model_concurrency.py': 'concurrency',
};
export function managedCommand(command, platform) {
  const match = /^(?:sudo -n (?:-u viios-agent )?)?(?:\/usr\/bin\/)?python3 -I \/opt\/viios-agent\/([a-z_-]+\.py)(?: (1) (65535))?$/.exec(command);
  if (!match || !helperMap[match[1]] || (match[2] && match[1] !== 'scan.py')) throw connectionError('UNSUPPORTED_COMMAND', 'Bu yönetim işlemi taşınabilir sürümde desteklenmiyor.', 403);
  if (platform === 'windows') return 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\ViiOS\\agent\\windows-agent.ps1" -Helper ' + helperMap[match[1]];
  return command;
}

/** Minimal ChildProcess-compatible surface used by existing helper callers. */
export function managedSpawn(command, args = [], options = {}) {
  if (command !== 'ssh') return nativeSpawn(command, args, options);
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.exitCode = null; child.signalCode = null;
  let client, channel, forwardingServer, target, finished = false;
  const sockets = new Set();
  const finish = (code, signal = null, error = null) => {
    if (finished) return;
    finished = true; child.exitCode = code; child.signalCode = signal;
    forwardingServer?.close(); for (const socket of sockets) socket.destroy();
    channel?.close(); client?.end(); child.stdin.destroy(); child.stdout.end(); child.stderr.end();
    live.get(target)?.delete(child);
    if (error) child.emit('error', error);
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => {
    if (finished) return false;
    child.killed = true;
    try { channel?.signal(signal.replace(/^SIG/, '')); } catch { /* Closing channel also interrupts transport. */ }
    client?.destroy(); finish(null, signal); return true;
  };
  queueMicrotask(async () => {
    try {
      const parsed = parseSshArguments(args); target = parsed.target;
      if (!managedStore) throw connectionError('TRANSPORT_NOT_READY', 'Sunucu bağlantıları hazırlanıyor.', 503);
      const profile = managedStore.getSecret(target);
      if (profile.status !== 'ready') throw connectionError('CONNECTION_NOT_READY', 'Sunucu kurulumu tamamlanmadı.', 503);
      if (finished) return;
      if (!live.has(target)) live.set(target, new Set()); live.get(target).add(child);
      if (parsed.configOnly) { child.stdout.write(`hostname ${profile.host}\nuser ${profile.username}\nport ${profile.port}\n`); finish(0); return; }
      const remoteCommand = parsed.noCommand ? null : managedCommand(parsed.command, profile.platform);
      client = await openSshConnection(profile);
      if (finished) { client.end(); return; }
      client.on('error', error => finish(1, null, sanitizedSshError(error)));
      client.on('close', () => { if (!finished) finish(1); });
      if (parsed.noCommand) {
        const binding = /^(127(?:\.\d{1,3}){3}|localhost):(\d{1,5}):(\[[a-fA-F0-9:]+\]|[^:]+):(\d{1,5})$/.exec(parsed.forwarding || '');
        if (!binding || Number(binding[2]) < 1 || Number(binding[2]) > 65535 || Number(binding[4]) < 1 || Number(binding[4]) > 65535)
          throw connectionError('INVALID_FORWARD', 'Geçersiz yerel önizleme tüneli.', 400);
        const destination = binding[3].replace(/^\[|\]$/g, '');
        if (!['127.0.0.1', 'localhost', '::1', profile.host].includes(destination)) throw connectionError('INVALID_FORWARD', 'Önizleme tüneli yalnız seçili sunucuya açılabilir.', 403);
        forwardingServer = net.createServer(socket => {
          sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
          client.forwardOut('127.0.0.1', 0, destination, Number(binding[4]), (error, stream) => {
            if (error || finished) { socket.destroy(); stream?.destroy(); return; }
            stream.on('error', () => socket.destroy()); socket.pipe(stream).pipe(socket);
          });
        });
        forwardingServer.on('error', () => finish(1, null, connectionError('FORWARD_FAILED', 'Yerel önizleme tüneli açılamadı.', 503)));
        forwardingServer.listen(Number(binding[2]), binding[1]);
      } else {
        client.exec(remoteCommand, (error, stream) => {
          if (error) { finish(1, null, sanitizedSshError(error)); return; }
          channel = stream;
          if (finished) { stream.close(); return; }
          stream.pipe(child.stdout, { end: false }); stream.stderr.pipe(child.stderr, { end: false });
          stream.on('error', () => finish(1));
          stream.on('close', (code, signal) => finish(Number.isInteger(code) ? code : 1, signal || null));
          child.stdin.pipe(stream);
          if (options.stdio?.[0] === 'ignore') child.stdin.end();
        });
      }
    } catch (error) { finish(1, null, error.code ? error : sanitizedSshError(error)); }
  });
  return child;
}
export { managedSpawn as spawn };

/** Bootstrap-only execution; callers supply bundled commands, never UI command text. */
export function executeSsh(client, command, { input = '', timeoutMs = 120000, maxBytes = 2 * 1024 * 1024, pty = false } = {}) {
  return new Promise((resolve, reject) => {
    let stream, out = '', err = '', done = false;
    const finish = (error, code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { stream?.close(); reject(error); } else resolve({ code, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => finish(connectionError('BOOTSTRAP_TIMEOUT', 'Sunucu hazırlama işlemi zaman aşımına uğradı.', 503)), timeoutMs);
    client.exec(command, { pty }, (error, channel) => {
      if (error) { finish(sanitizedSshError(error)); return; }
      stream = channel;
      channel.on('data', chunk => { out += chunk; if (Buffer.byteLength(out) > maxBytes) finish(connectionError('OUTPUT_LIMIT', 'Sunucu yanıtı sınırı aşıldı.', 503)); });
      channel.stderr.on('data', chunk => { err = (err + chunk).slice(-4096); });
      channel.on('error', () => finish(connectionError('SSH_UNAVAILABLE', 'Sunucu bağlantısı kesildi.', 503)));
      channel.on('close', code => finish(null, Number.isInteger(code) ? code : 1));
      channel.end(input);
    });
  });
}

export function withSftp(client, action) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => {
    if (error) { reject(sanitizedSshError(error)); return; }
    Promise.resolve().then(() => action(sftp)).then(resolve, reject).finally(() => sftp.end());
  }));
}
