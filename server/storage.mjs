import { readConnectionProfile } from './ssh-transport.mjs';
import { spawn } from './ssh-transport.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url), 'utf8'));
const invalid = message => Object.assign(new Error(message), { status: 400 });
const unavailable = () => Object.assign(new Error('Depolama ölçümü yapılamadı. Yol, yönetim erişimi veya yardımcı programı denetleyin.'), { status: 503 });
export function storageTopology(value) {
  if (!value || !Array.isArray(value.devices)) return { available: false, devices: [], reason: 'Disk eşleştirmesi için güncel agent gereklidir.' };
  const text = item => typeof item === 'string' ? item.slice(0, 256) : '';
  const number = item => typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : null;
  const ids = items => Array.isArray(items) ? [...new Set(items.filter(item => typeof item === 'string').map(text))].slice(0, 512) : [];
  const seen = new Set();
  const devices = value.devices.slice(0, 512).filter(row => row && typeof row.id === 'string' && row.id && !seen.has(row.id) && seen.add(row.id)).map(row => ({
    id: text(row.id), name: text(row.name), kind: ['disk', 'partition', 'logical'].includes(row.kind) ? row.kind : 'unknown',
    sizeBytes: number(row.sizeBytes), parentIds: ids(row.parentIds), volumeIds: ids(row.volumeIds),
    model: text(row.model), partitionStyle: text(row.partitionStyle),
    readBytesPerSecond: number(row.readBytesPerSecond), writeBytesPerSecond: number(row.writeBytesPerSecond),
  }));
  return { available: value.available === true && devices.length > 0, partial: !!value.partial || value.devices.length > 512,
    sampledAt: Date.now(), devices, reason: text(value.reason) };
}
function hasControl(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function storagePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || Buffer.byteLength(value) > 4096 ||
      hasControl(value) || (value !== '/' && (value.endsWith('/') || value.includes('//'))) ||
      value.split('/').some(part => part === '.' || part === '..')) throw invalid('Geçersiz dizin yolu.');
  return value;
}
export function storageQuery(query, folder = false) {
  if (Object.keys(query).some(key => !['refresh', ...(folder ? ['path'] : [])].includes(key)) ||
      (query.refresh !== undefined && query.refresh !== '1')) throw invalid('Geçersiz depolama sorgusu.');
  return { refresh: query.refresh === '1', ...(folder ? { path: storagePath(query.path ?? '/') } : {}) };
}

function appDirectory(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\/+$/, '') || '/';
  try { storagePath(normalized); } catch { return null; }
  if (['/', '/root', '/home', '/opt', '/srv', '/var', '/development', '/tmp', '/mnt', '/media'].includes(normalized) ||
      /^\/(etc|usr|run|proc|sys|dev|boot|var\/lib|var\/log)(\/|$)/.test(normalized) ||
      normalized.split('/').some(part => ['.ssh', '.gnupg'].includes(part))) return null;
  return normalized;
}

/** Only known catalog/inventory metadata supplies app roots; clients cannot inject them. */
export function storageApplications(apps, config, definitions = catalog) {
  const result = new Map();
  const add = (id, name, directory) => {
    const value = appDirectory(directory);
    if (value && !result.has(value)) result.set(value, { id: String(id).slice(0, 200), name: String(name || path.posix.basename(value)).slice(0, 200), path: value });
  };
  if (definitions.length) {
    for (const project of definitions.filter(p=>(!p.serverId || p.serverId===config.id) && (!p.host || p.host===config.host))) {
      add(project.id, project.name, project.directory);
      for (const directory of project.roots || []) if (directory !== project.directory && !directory.startsWith(project.directory + '/'))
        add(`${project.id}:${directory}`, project.name, directory);
    }
  }
  for (const app of apps) {
    if (app.project?.system) continue;
    add(app.project?.id || `port:${app.port}`, app.project?.name || app.name, app.project?.directory || app.filesPath || app.directory);
  }
  const rows = [...result.values()];
  return rows.map(row => ({ ...row, ...(rows.some(other => other !== row && (row.path.startsWith(other.path + '/') || other.path.startsWith(row.path + '/')))
    ? { reason: 'Başka uygulama diziniyle iç içe; bu boyutlar birbirine eklenmemelidir.' } : {}) }));
}

/** Polls share bounded queued work. Never return failed or unmeasured scans as zero. */
export function createStorageScanCache(run, { now = Date.now, ttl = 300000, cooldown = 30000, maxEntries = 32 } = {}) {
  const records = new Map(), queue = [];
  let active = false, closed = false, lastRefresh = -Infinity;
  function pump() {
    if (active || closed || !queue.length) return;
    active = true;
    const record = queue.shift();
    record.startedAt = now();
    Promise.resolve().then(() => run(record.payload)).then(value => {
      if (!value || value.status !== 'ready') throw unavailable();
      record.value = value;
      record.finishedAt = now();
    }).catch(() => {
      record.value = { ...record.value, status: 'error', partial: true, error: 'Yeni ölçüm alınamadı; varsa gösterilen değerler önceki ölçümdür. Yol veya yönetim erişimi kullanılamıyor.' };
      record.finishedAt = now();
    }).finally(() => { record.pending = false; active = false; pump(); });
  }
  return {
    read(key, payload, empty, refresh = false) {
      if (closed) throw unavailable();
      let record = records.get(key);
      if (!record) {
        if (records.size >= maxEntries) {
          const disposable = [...records].filter(([, item]) => !item.pending).sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
          if (!disposable) throw Object.assign(new Error('Depolama tarama sırası dolu; mevcut ölçümün bitmesini bekleyin.'), { status: 429 });
          records.delete(disposable[0]);
        }
        record = { empty, value: empty, startedAt: -Infinity, finishedAt: -Infinity, pending: false };
        records.set(key, record);
      }
      const manual = refresh && now() - lastRefresh >= cooldown && now() - record.startedAt >= cooldown;
      const expired = now() - record.finishedAt >= (record.value.status === 'error' ? cooldown : ttl);
      if (!record.pending && (manual || expired)) {
        if (queue.length >= 8) throw Object.assign(new Error('Depolama tarama sırası dolu; mevcut ölçümün bitmesini bekleyin.'), { status: 429 });
        if (manual) lastRefresh = now();
        record.pending = true;
        record.payload = payload;
        queue.push(record);
        pump();
      }
      return record.pending ? { ...record.value, status: 'scanning', reason: 'Ölçüm sürüyor veya sırada; mevcut değerler önceki ölçüme ait olabilir.' } : record.value;
    },
    shutdown() { closed = true; queue.length = 0; },
  };
}

function helperRunner(config) {
  let closed = false;
  const children = new Set();
  return {
    async run(request) {
      if (closed) throw unavailable();
      const profile = await readConnectionProfile(config);
      if (!profile) throw unavailable();
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 65536) throw invalid('Depolama isteği sınırı aşıldı.');
      const command = profile.transport === 'ssh' ? 'ssh' : 'sudo';
      const args = profile.transport === 'ssh'
        ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', profile.sshTarget, 'sudo -n /usr/bin/python3 -I /opt/viios-agent/storage.py']
        : ['-n', '/usr/bin/python3', '-I', path.join(root, 'server/storage.py')];
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        let out = '', done = false;
        const finish = failure => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          children.delete(child);
          if (failure) reject(unavailable());
          else { try { resolve(JSON.parse(out)); } catch { reject(unavailable()); } }
        };
        const timer = setTimeout(() => { child.kill(); finish(true); }, request.action === 'overview' ? (profile.platform === 'windows' ? 45000 : 15000) : 65000);
        child.stdout.on('data', data => {
          out += data;
          if (out.length > 4 * 1024 * 1024) { child.kill(); finish(true); }
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.on('error', () => finish(true));
        child.on('close', code => finish(code !== 0));
        child.stdin.end(input);
      });
    },
    shutdown() { closed = true; for (const child of children) child.kill(); },
  };
}

export function createStorageMonitor(config, { applications = () => [], run, now = Date.now } = {}) {
  const runner = run ? { run, shutdown() {} } : helperRunner(config);
  const scans = createStorageScanCache(request => runner.run(request), { now });
  let overview, overviewAt = -Infinity, overviewPending, closed = false;
  return {
    async read() {
      if (closed) throw unavailable();
      if (overview && now() - overviewAt < 5000) return overview;
      if (!overviewPending) overviewPending = runner.run({ action: 'overview' }).then(value => {
        if (!value || !Array.isArray(value.volumes) || !value.summary) throw unavailable();
        overview = { ...value, topology: storageTopology(value.topology), serverId: config.id, host: config.host };
        overviewAt = now();
        return overview;
      }).catch(() => {
        overview = { ...(overview || { sampledAt: null, hostname: null, summary: null, volumes: [] }), available: false,
          stale: !!overview, reason: 'Yeni kapasite ölçümü alınamadı; varsa gösterilen değerler önceki ölçümdür. Yönetim erişimi veya yardımcı program kullanılamıyor.' };
        overviewAt = now();
        return overview;
      }).finally(() => { overviewPending = null; });
      return overviewPending;
    },
    usage(query = {}) {
      const options = storageQuery(query, true);
      return scans.read(`usage:${options.path}`, { action: 'usage', path: options.path },
        { status: 'scanning', path: options.path, scannedAt: null, partial: false, totalBytes: null, entries: [] }, options.refresh);
    },
    apps(query = {}) {
      const { refresh } = storageQuery(query);
      const candidates = storageApplications(applications(), config), rows = candidates.slice(0, 80);
      const omittedApplications = candidates.length - rows.length;
      if (!rows.length) return { status: 'ready', scannedAt: now(), partial: false, applications: [], reason: 'Ölçülebilir uygulama dizini bulunamadı.' };
      const snapshot = scans.read('apps', { action: 'apps', paths: rows.map(row => row.path) },
        { status: 'scanning', scannedAt: null, partial: false, applications: [] }, refresh);
      const measurements = new Map((snapshot.applications || []).map(row => [row.path, row]));
      return { ...snapshot, partial: snapshot.partial || omittedApplications > 0, omittedApplications,
        reason: 'Uygulama dizinlerinin ayrılmış disk alanı ölçülür; paylaşılan/iç içe dizinler toplanamaz. Container katmanları ayrı uygulama tüketimi olarak ölçülmez.' +
          (omittedApplications ? ` İlk 80 dizin gösteriliyor; ${omittedApplications} dizin ölçüm sınırı dışında.` : ''),
        applications: rows.map(row => ({ ...row, bytes: null, ...measurements.get(row.path),
          ...((row.reason || measurements.get(row.path)?.reason) ? { reason: [row.reason, measurements.get(row.path)?.reason].filter(Boolean).join(' ') } : {}) })),
      };
    },
    shutdown() { closed = true; scans.shutdown(); runner.shutdown(); },
  };
}
