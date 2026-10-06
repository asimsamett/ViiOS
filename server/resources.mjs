import { readConnectionProfile } from './ssh-transport.mjs';
import { spawn } from './ssh-transport.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function resourceConnection(profiles, { id, host, mode }) {
  const profile = profiles[id];
  if (!profile || profile.host !== host) return null;
  const transport =
    profile.transport === 'auto'
      ? mode === 'local'
        ? 'local'
        : 'ssh'
      : profile.transport;
  if (
    !['local', 'ssh'].includes(transport) ||
    (transport === 'local' && mode !== 'local')
  )
    return null;
  if (
    transport === 'ssh' &&
    (typeof profile.sshTarget !== 'string' ||
      !/^[a-zA-Z0-9_.@-]+$/.test(profile.sshTarget) ||
      profile.sshTarget.startsWith('-'))
  )
    return null;
  return { ...profile, transport };
}
export function sharedResourceSample(run, now = Date.now) {
  let pending, cache;
  return async () => {
    if (cache && now() - cache.at < 250) return cache.data;
    if (!pending)
      pending = run()
        .then((data) => {
          cache = { at: now(), data };
          return data;
        })
        .finally(() => {
          pending = null;
        });
    return pending;
  };
}
export function createResourceMonitor(config) {
  let closed = false,
    child;
  const read = sharedResourceSample(async () => {
    if (closed)
      throw Object.assign(new Error('Kaynak izleyici kapanıyor.'), {
        status: 503,
      });
    const profile = await readConnectionProfile(config);
    if (!profile)
      return {
        available: false,
        reason:
          'Bu sunucuda sistem kaynaklarını ölçmek için yönetim erişimi yapılandırılmalı.',
        applications: [],
      };
    const data = await new Promise((resolve, reject) => {
      const command = profile.transport === 'ssh' ? 'ssh' : 'sudo';
      const args =
        profile.transport === 'ssh'
          ? [
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=8',
              profile.sshTarget,
              'sudo -n /usr/bin/python3 -I /opt/viios-agent/resources.py',
            ]
          : [
              '-n',
              '/usr/bin/python3',
              '-I',
              path.join(root, 'server/resources.py'),
            ];
      const process = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = process;
      let out = '',
        done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child === process) child = null;
        if (error) reject(error);
        else resolve(out);
      };
      const failure = () =>
        Object.assign(
          new Error(
            'Sunucu kaynakları ölçülemedi. Biraz sonra yeniden deneyin.',
          ),
          { status: 503 },
        );
      const timer = setTimeout(() => {
        process.kill();
        finish(failure());
      }, profile.platform === 'windows' ? 45000 : 15000);
      process.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.length > 3 * 1024 * 1024) {
          process.kill();
          finish(failure());
        }
      });
      process.stderr.on('data', () => {});
      process.on('error', () => finish(failure()));
      process.on('close', (code) => finish(code === 0 ? null : failure()));
    });
    const result = JSON.parse(data);
    if (!result.available || !Array.isArray(result.applications))
      throw Object.assign(new Error('Geçerli bir kaynak ölçümü alınamadı.'), {
        status: 503,
      });
    return { ...result, serverId: config.id, host: config.host };
  });
  return {
    read,
    shutdown() {
      closed = true;
      child?.kill();
    },
  };
}
