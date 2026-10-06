import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import path from 'node:path';

const execute = promisify(execFile);
export const CONNECTION_ID = /^srv-[a-f0-9]{24}$/;
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const connectionError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const fields = ['id', 'name', 'host', 'port', 'username', 'platform', 'authType', 'fingerprint', 'status', 'phase', 'message', 'capabilities', 'updatedAt', 'createdAt', 'errorCode'];

export function publicConnection(record) {
  return { ...Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, structuredClone(record[key])])), configRevision: record.configRevision ?? 0 };
}
export function validateAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw connectionError('INVALID_CONNECTION', 'Sunucu bilgileri geçersiz.');
  const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
  if (!host || host.length > 253 || (!isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)))
    throw connectionError('INVALID_HOST', 'Geçerli bir IP adresi veya sunucu adı girin.');
  const port = input.port === undefined ? 22 : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw connectionError('INVALID_PORT', 'SSH portu 1–65535 arasında olmalı.');
  if (!['linux', 'windows'].includes(input.platform)) throw connectionError('INVALID_PLATFORM', 'Linux veya Windows seçin.');
  return { host, port, platform: input.platform };
}
export function validateConnection(input) {
  const address = validateAddress(input);
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\$-]{0,127}$/.test(username)) throw connectionError('INVALID_USERNAME', 'Geçerli bir SSH kullanıcı adı girin.');
  const name = typeof input.name === 'string' ? input.name.trim() : address.host;
  if (!name || name.length > 120) throw connectionError('INVALID_NAME', 'Sunucu adı 1–120 karakter olmalı.');
  if (!FINGERPRINT.test(input.fingerprint || '')) throw connectionError('HOST_KEY_REQUIRED', 'Önce sunucu anahtar parmak izini kontrol edip onaylayın.');
  if (!['password', 'key'].includes(input.authType)) throw connectionError('INVALID_AUTH', 'Şifre veya SSH anahtarı seçin.');
  const secrets = {};
  if (input.authType === 'password') {
    if (typeof input.password !== 'string' || !input.password || input.password.length > 4096) throw connectionError('PASSWORD_REQUIRED', 'SSH şifresi gerekli.');
    secrets.password = input.password;
  } else {
    if (typeof input.privateKey !== 'string' || !input.privateKey || input.privateKey.length > 131072) throw connectionError('KEY_REQUIRED', 'Geçerli SSH özel anahtarı gerekli.');
    secrets.privateKey = input.privateKey;
    if (input.passphrase !== undefined) {
      if (typeof input.passphrase !== 'string' || input.passphrase.length > 4096) throw connectionError('INVALID_PASSPHRASE', 'Anahtar parolası geçersiz.');
      secrets.passphrase = input.passphrase;
    }
  }
  return { ...address, username, name, fingerprint: input.fingerprint, authType: input.authType, secrets };
}

let windowsSid;
export async function privatePermissions(filename, directory = false) {
  if (process.platform !== 'win32') { await chmod(filename, directory ? 0o700 : 0o600); return; }
  if (!windowsSid) {
    const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 });
    windowsSid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
    if (!windowsSid) throw connectionError('PRIVATE_STORAGE_FAILED', 'Özel kayıt dizini izinleri hazırlanamadı.', 500);
  }
  const encodedPath = Buffer.from(path.resolve(filename), 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference="Stop"',
    '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + encodedPath + '"))',
    '$owner=New-Object Security.Principal.SecurityIdentifier("' + windowsSid + '")',
    '$system=New-Object Security.Principal.SecurityIdentifier("S-1-5-18")',
    '$acl=New-Object Security.AccessControl.' + (directory ? 'DirectorySecurity' : 'FileSecurity'),
    '$acl.SetOwner($owner); $acl.SetAccessRuleProtection($true,$false)',
    'foreach($sid in @($owner,$system)) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl",' + (directory ? '"ContainerInherit,ObjectInherit","None",' : '') + '"Allow"))) }',
    (directory ? '[IO.Directory]' : '[IO.File]') + '::SetAccessControl($p,$acl)',
  ].join('\n');
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
export async function securePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privatePermissions(directory, true);
}

export function createConnectionStore({ dataDir, securePermissions = privatePermissions } = {}) {
  if (!dataDir) throw new Error('Connection store dataDir required');
  const directory = path.resolve(dataDir, 'connections');
  const keyPath = path.join(directory, 'master.key'), registry = path.join(directory, 'servers.json');
  let key, initialized = false, writes = Promise.resolve();
  const records = new Map(), updates = new Map();
  const aad = record => Buffer.from(JSON.stringify(['viios-connection-v1', record.id, record.host, record.port, record.username, record.platform, record.authType, record.fingerprint]));
  function seal(record, secrets) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(record));
    const body = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
  }
  function unseal(record) {
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.sealed.iv, 'base64'));
      cipher.setAAD(aad(record));
      cipher.setAuthTag(Buffer.from(record.sealed.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.sealed.body, 'base64')), cipher.final()]).toString('utf8'));
    } catch { throw connectionError('SECRET_UNAVAILABLE', 'Kayıtlı SSH bilgileri açılamadı; bağlantıyı yeniden ekleyin.', 503); }
  }
  async function save() {
    const temporary = registry + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, servers: [...records.values()] }), { mode: 0o600, flag: 'wx' });
      await securePermissions(temporary);
      await rename(temporary, registry);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function mutate(action) {
    const operation = writes.catch(() => {}).then(async () => {
      if (!initialized) throw new Error('Connection store not initialized');
      const before = new Map(records);
      try { const result = action(); await save(); return result; }
      catch (error) { records.clear(); for (const [id, record] of before) records.set(id, record); throw error; }
    });
    writes = operation;
    return operation;
  }
  function duplicate(value, excludeId) {
    if ([...records.values(), ...[...updates.values()].map(update => update.record)].some(record => record.id !== excludeId && record.host === value.host && record.port === value.port && record.username === value.username))
      throw connectionError('CONNECTION_EXISTS', 'Bu sunucu ve kullanıcı zaten kayıtlı.', 409);
  }
  const store = {
    async initialize() {
      if (initialized) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await securePermissions(directory, true);
      try { key = await readFile(keyPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {
          await readFile(registry);
          throw connectionError('MISSING_MASTER_KEY', 'Bağlantı şifreleme anahtarı eksik; kayıtlar değiştirilmedi.', 500);
        } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
        const generated = randomBytes(32);
        try { await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 }); }
        catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        key = await readFile(keyPath);
      }
      if (key.length !== 32) throw connectionError('INVALID_MASTER_KEY', 'Bağlantı şifreleme anahtarı geçersiz.', 500);
      await securePermissions(keyPath);
      try {
        const stored = JSON.parse(await readFile(registry, 'utf8'));
        if (stored.version !== 1 || !Array.isArray(stored.servers) || stored.servers.length > 200) throw new Error('Invalid registry');
        for (const record of stored.servers) {
          if (!CONNECTION_ID.test(record.id) || !record.sealed || !FINGERPRINT.test(record.fingerprint || '') || (record.configRevision !== undefined && (!Number.isSafeInteger(record.configRevision) || record.configRevision < 0))) throw new Error('Invalid record');
          records.set(record.id, record);
        }
        await securePermissions(registry);
      } catch (error) { if (error.code !== 'ENOENT') throw connectionError('INVALID_REGISTRY', 'Sunucu kayıtları okunamadı; kayıtlar değiştirilmedi.', 500); }
      initialized = true;
    },
    list() { return [...records.values()].map(publicConnection); },
    get(id) { const record = records.get(id); return record ? publicConnection(record) : null; },
    getSecret(id) {
      const record = records.get(id);
      if (!record) throw connectionError('CONNECTION_NOT_FOUND', 'Sunucu bağlantısı bulunamadı.', 404);
      return { ...publicConnection(record), ...unseal(record) };
    },
    add(input) {
      const value = validateConnection(input);
      return mutate(() => {
        if (records.size >= 200) throw connectionError('CONNECTION_LIMIT', 'En fazla 200 sunucu eklenebilir.');
        duplicate(value);
        const timestamp = new Date().toISOString(), { secrets, ...profile } = value;
        const record = { ...profile, id: 'srv-' + randomBytes(12).toString('hex'), configRevision: 0, status: 'pending', phase: 'queued', message: 'Bağlantı hazırlanıyor.', capabilities: {}, createdAt: timestamp, updatedAt: timestamp };
        record.sealed = seal(record, secrets);
        records.set(record.id, record);
        return publicConnection(record);
      });
    },
    prepareUpdate(id, input) {
      // Reserve the new endpoint before stopping a live job. Nothing is persisted
      // and credentials never leave this closure until commit succeeds.
      const operation = writes.catch(() => {}).then(() => {
        if (!initialized) throw new Error('Connection store not initialized');
        const record = records.get(id);
        if (!record) throw connectionError('CONNECTION_NOT_FOUND', 'Sunucu bağlantısı bulunamadı.', 404);
        if (updates.has(id)) throw connectionError('CONNECTION_BUSY', 'Bu bağlantı zaten güncelleniyor.', 409);
        const required = ['name', 'host', 'port', 'username', 'platform', 'authType', 'fingerprint', 'keepCredentials', 'expectedRevision'];
        const optional = ['password', 'privateKey', 'passphrase', 'sudoPassword'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !required.includes(field) && !optional.includes(field)))
          throw connectionError('INVALID_CONNECTION', 'Sunucu düzenleme bilgileri geçersiz.');
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw connectionError('INVALID_REVISION', 'Bağlantı ayarlarının sürümü geçersiz.');
        if (typeof input.name !== 'string') throw connectionError('INVALID_NAME', 'Sunucu adı 1–120 karakter olmalı.');
        if (input.expectedRevision !== (record.configRevision ?? 0)) throw connectionError('CONNECTION_CHANGED', 'Bağlantı ayarları başka bir oturumda değişti. Güncel bilgileri yükleyip tekrar deneyin.', 409);
        if (input.expectedRevision === Number.MAX_SAFE_INTEGER) throw connectionError('REVISION_LIMIT', 'Bağlantı ayarlarının sürüm sınırına ulaşıldı.', 503);
        if (typeof input.keepCredentials !== 'boolean') throw connectionError('INVALID_CREDENTIALS', 'Kayıtlı erişim bilgileri tercihi geçersiz.');
        const secretFields = ['password', 'privateKey', 'passphrase'];
        let value;
        if (input.keepCredentials) {
          if (input.authType !== record.authType) throw connectionError('CREDENTIALS_REQUIRED', 'Kimlik doğrulama türü değiştiğinde yeni şifre veya SSH anahtarı girin.');
          if (secretFields.some(field => Object.hasOwn(input, field))) throw connectionError('INVALID_CREDENTIALS', 'Kayıtlı bilgileri kullanırken yeni şifre veya anahtar göndermeyin.');
          value = validateConnection({ ...input, ...unseal(record) });
        } else {
          if ((input.authType === 'password' && ['privateKey', 'passphrase'].some(field => Object.hasOwn(input, field))) || (input.authType === 'key' && Object.hasOwn(input, 'password')))
            throw connectionError('INVALID_CREDENTIALS', 'Erişim bilgileri seçilen kimlik doğrulama türüyle uyuşmuyor.');
          value = validateConnection(input);
        }
        duplicate(value, id);
        const { secrets, ...profile } = value;
        const expectedRevision = input.expectedRevision;
        const prepared = { ...profile, id, configRevision: expectedRevision + 1 };
        prepared.sealed = seal(prepared, secrets);
        const reservation = { record: prepared };
        updates.set(id, reservation);
        const cancel = () => { if (updates.get(id) === reservation) updates.delete(id); };
        return {
          cancel,
          async commit() {
            try {
              return await mutate(() => {
                const current = records.get(id);
                if (updates.get(id) !== reservation || !current || (current.configRevision ?? 0) !== expectedRevision) throw connectionError('CONNECTION_CHANGED', 'Bağlantı ayarları değişti. Güncel bilgileri yükleyip tekrar deneyin.', 409);
                const updated = { ...current, ...prepared, status: 'pending', phase: 'queued', message: 'Güncellenen bağlantı hazırlanıyor.', capabilities: {}, errorCode: null, updatedAt: new Date().toISOString() };
                records.set(id, updated);
                return publicConnection(updated);
              });
            } finally { cancel(); }
          },
        };
      });
      writes = operation;
      return operation;
    },
    async update(id, input) { const prepared = await store.prepareUpdate(id, input); return prepared.commit(); },
    patch(id, changes, { guard = () => true } = {}) {
      return mutate(() => {
        if (!guard()) return null;
        const record = records.get(id);
        if (!record) throw connectionError('CONNECTION_NOT_FOUND', 'Sunucu bağlantısı bulunamadı.', 404);
        const allowed = ['status', 'phase', 'message', 'capabilities', 'errorCode'];
        if (Object.keys(changes).some(field => !allowed.includes(field))) throw new Error('Unsupported connection update');
        const updated = { ...record, ...changes, updatedAt: new Date().toISOString() };
        records.set(id, updated);
        return publicConnection(updated);
      });
    },
    remove(id) { return mutate(() => { if (updates.has(id)) throw connectionError('CONNECTION_BUSY', 'Bu bağlantı zaten güncelleniyor.', 409); if (!records.delete(id)) throw connectionError('CONNECTION_NOT_FOUND', 'Sunucu bağlantısı bulunamadı.', 404); return { ok: true }; }); },
    async shutdown() { await writes.catch(() => {}); updates.clear(); key?.fill(0); initialized = false; },
  };
  return store;
}
