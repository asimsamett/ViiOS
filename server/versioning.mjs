import { readConnectionProfile } from './ssh-transport.mjs';
import { spawn } from './ssh-transport.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accessErrorCodes = new Set(['ACL_UNSUPPORTED', 'ACL_ACCESS_DENIED', 'ACL_UPDATE_FAILED']);
export function versionAccessErrorCode(value) {
  return accessErrorCodes.has(value) ? value : undefined;
}
const fields = {
  capabilities: [],
  list: [],
  inspect: ['path'],
  prepare: ['path', 'revision'],
  status: ['id'],
  register: ['path', 'revision'],
  commit: ['id', 'revision', 'message'],
  restore: ['id', 'revision', 'commit'],
  diff: ['id', 'commit'],
  timeline: ['id', 'offset'],
  graph: ['id'],
  treeFiles: ['id', 'commit'],
  treeFile: ['id', 'commit', 'file'],
  commitFiles: ['id', 'commit'],
  fileDiff: ['id', 'commit', 'file'],
  workingFileDiff: ['id', 'file'],
};
export function validateVersionRequest(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.hasOwn(fields, body.action) ||
    Object.keys(body).some(
      (key) => key !== 'action' && !fields[body.action].includes(key),
    )
  )
    throw Object.assign(new Error('Geçersiz sürüm işlemi.'), { status: 400 });
  for (const field of fields[body.action]) {
    const value = body[field];
    if (field === 'offset') {
      if (!Number.isInteger(value) || value < 0 || value > 1000000)
        throw Object.assign(new Error('Geçersiz sürüm sayfası.'), {
          status: 400,
        });
      continue;
    }
    if (
      ['message', 'commit'].includes(field) &&
      value === undefined &&
      body.action !== 'restore'
    )
      continue;
    const valid =
      typeof value === 'string' &&
      (field === 'id'
        ? /^[a-f0-9]{32}$/.test(value)
        : field === 'revision'
          ? /^[a-f0-9]{64}$/.test(value)
          : field === 'commit'
            ? /^[a-f0-9]{40}$/.test(value)
            : field === 'path'
              ? value.startsWith('/') &&
                value.length <= 4096 &&
                !value.includes(String.fromCharCode(0)) &&
                !value.split('/').some((p) => p === '..' || p === '.')
              : field === 'file'
                ? value.length > 0 &&
                  value.length <= 4096 &&
                  !value.startsWith('/') &&
                  !value.includes('\0') &&
                  !value.split('/').some((p) => p === '..' || p === '.')
                : value.length <= 300 &&
                  !value.includes(String.fromCharCode(0)));
    if (!valid)
      throw Object.assign(new Error('Geçersiz sürüm parametresi.'), {
        status: 400,
      });
  }
  return body;
}

export function versionRouter(config, { spawnProcess = spawn, readProfile = readConnectionProfile } = {}) {
  const router = express.Router();
  async function invoke(body) {
    validateVersionRequest(body);
    const settings = JSON.parse(
      await readFile(path.join(root, 'server/versioning.json'), 'utf8'),
    );
    // Only enrolled targets with verified capabilities support project versioning.
    const connection = await readProfile(config);
    if (!settings.enabled || !connection || connection.capabilities?.versions === false) {
      if (body.action === 'capabilities')
        return {
          available: false,
          reason: 'Sürüm yönetimi bu sunucuda kapalı.',
        };
      throw Object.assign(new Error('Sürüm yönetimi bu sunucuda kapalı.'), {
        status: 403,
      });
    }
    if (body.action === 'inspect' || body.action === 'prepare') {
      const access = await run(body, connection, true);
      if (access.needsAccess)
        return {
          ...access,
          ignore: access.ignore,
          registered: null,
          revision: access.accessRevision,
        };
      return {
        ...(await run({ action: 'inspect', path: access.path }, connection)),
        selectedPath: access.selectedPath,
        ...(access.accessReceipt
          ? { accessReceipt: access.accessReceipt }
          : {}),
      };
    }
    return run(body, connection);
  }
  function run(body, connection, access = false) {
    return new Promise((resolve, reject) => {
      const remote = connection.transport === 'ssh';
      const child = spawnProcess(
        remote ? 'ssh' : access ? 'sudo' : '/usr/bin/python3',
        remote
          ? [
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=8',
              connection.sshTarget,
              access
                ? 'sudo -n /usr/bin/python3 -I /opt/viios-agent/versioning_access.py'
                : 'sudo -n -u viios-agent /usr/bin/python3 -I /opt/viios-agent/versioning.py',
            ]
          : access
            ? [
                '-n',
                '/usr/bin/python3',
                '-I',
                path.join(root, 'server/versioning_access.py'),
              ]
            : ['-I', path.join(root, 'server/versioning.py')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '',
        finished = false;
      const failure = () =>
        Object.assign(
          new Error(
            'Sürüm servisine erişilemedi. İşlem sonucunu Yenile ile kontrol edin.',
          ),
          { status: 503 },
        );
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => {
          child.kill();
          finish(failure());
        },
        access ? 130000 : 600000,
      );
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.length > 2 * 1024 * 1024) {
          child.kill();
          finish(failure());
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(failure()));
      child.on('close', () => {
        try {
          const result = JSON.parse(out);
          finish(
            result.error
              ? Object.assign(new Error(result.error), {
                  status: result.status || 400,
                  ...(access && versionAccessErrorCode(result.code) ? { code: result.code } : {}),
                })
              : null,
            result,
          );
        } catch {
          finish(failure());
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(body));
    });
  }
  router.get('/capabilities', async (_req, res) =>
    res.json(await invoke({ action: 'capabilities' })),
  );
  router.get('/projects', async (_req, res) =>
    res.json(await invoke({ action: 'list' })),
  );
  router.post('/action', async (req, res) => res.json(await invoke(req.body)));
  return router;
}
