import { createFixtures, DEMO_NOTICE, DEMO_SERVER_IDS, demoPreviewSvg } from './fixtures.mjs';
export { demoPreviewUrl } from './fixtures.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-ViiOS-Demo': 'true' } });
const fail = (message, status = 403) => json({ error: message, demo: true }, status);
const readonly = () => fail('Bu işlem tanıtım demosunda kapalıdır. Gerçek sunucu, dosya veya şifre kullanılmaz.');
const missing = () => fail('Örnek kayıt bulunamadı.', 404);
const parentPath = path => path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
const boundedNumber = (value, fallback, low, high) => {
  const number = value === null || value === undefined ? fallback : Number(value);
  return Number.isInteger(number) ? Math.min(high, Math.max(low, number)) : fallback;
};
const entry = (file, now) => ({ name: file.name, path: file.path, kind: file.kind, size: file.size, modifiedAt: Date.parse(now), mode: file.kind === 'directory' ? '0555' : '0444', uid: 1000, gid: 1000, revision: 'demo-file', accessible: true, mutable: false });

function listFiles(server, path, query, offset, now, recursive = false) {
  const folder = server.files[path];
  if (!folder || folder.kind !== 'directory') return null;
  const candidates = Object.values(server.files).filter(file => file.path !== path && (recursive ? file.path.startsWith(path === '/' ? '/' : path + '/') : parentPath(file.path) === path));
  const entries = candidates.filter(file => file.name.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr'))).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'tr')).map(file => entry(file, now));
  return { path, parent: parentPath(path), entries: entries.slice(offset, offset + 100), total: entries.length, offset, writable: false, truncated: false, partial: false };
}

function freePorts(server, query, now) {
  const start = boundedNumber(query.get('start'), 8000, 1, 65535), end = boundedNumber(query.get('end'), 8999, start, 65535);
  const offset = boundedNumber(query.get('offset'), 0, 0, 65535), limit = boundedNumber(query.get('limit'), 100, 1, 65535);
  const taken = new Set(server.inventory.apps.map(app => app.port));
  const ports = [];
  for (let port = start; port <= end; port++) if (!taken.has(port)) ports.push({ port, previouslyUsed: false, previousName: null, restartable: false, otherProtocol: null });
  return { demo: true, host: server.connection.host, scannedAt: now, stale: false, connectionError: null, total: ports.length, occupied: end - start + 1 - ports.length, excludedKnown: 0, rangeSize: end - start + 1, ports: ports.slice(offset, offset + limit), filters: { start, end, protocol: query.get('protocol') || 'both' } };
}

function versionRead(server, body) {
  const project = server.projects.find(item => item.id === body.id || item.path === body.path);
  if (!project) return missing();
  const history = server.commits;
  if (body.action === 'status') return json({ project, state: { path: project.path, name: project.name, head: history[0].id, branch: 'main', changes: [], history, blocked: 'Demo modunda sürümler yalnız görüntülenir.', revision: 'demo-revision', remoteNames: [], ignoredCount: 0, trackedCount: 3 } });
  if (body.action === 'inspect') return json({ path: project.path, selectedPath: project.path, name: project.name, exists: true, revision: 'demo-revision', ignore: [], registered: project.id, branch: 'main', needsAccess: false });
  if (body.action === 'timeline') return json({ branch: 'main', total: history.length, offset: 0, history, hasMore: false });
  if (body.action === 'graph') return json({ rows: history.map((commit, index) => ({ graph: '*', commit: { ...commit, refs: index === 0 ? ['HEAD -> main'] : [], parents: index === 0 ? [history[1].id] : [] } })), total: history.length, truncated: false });
  if (body.action === 'commitFiles') return json({ files: [{ status: 'A', path: 'README.md' }, { status: 'A', path: 'demo.config.json' }] });
  if (body.action === 'treeFiles') return json({ files: ['README.md', 'demo.config.json', 'docs/guide.txt'], total: 3, truncated: false });
  if (body.action === 'treeFile') {
    const file = server.files[`${project.path}/${body.file}`];
    return file?.kind === 'file' ? json({ text: file.content, truncated: false, note: 'Temsili demo dosyası.' }) : missing();
  }
  if (['diff', 'fileDiff', 'workingFileDiff'].includes(body.action)) return json({ text: 'diff --git a/README.md b/README.md\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1,3 @@\n+# Örnek uygulama\n+\n+Bu içerik ViiOS demosu için oluşturuldu.\n', truncated: false, note: 'Bu fark örnek veri içerir.' });
  return readonly();
}

function layoutList(value, limit) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > limit) throw new Error('invalid');
  const allowed = new Set(['id', 'kind', 'label', 'detail', 'path', 'port', 'projectId', 'view', 'openedAt']);
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.label !== 'string' || item.label.length > 255 || item.kind === 'link' || Object.keys(item).some(key => !allowed.has(key))) throw new Error('invalid');
    return { ...item };
  });
}

/** Isolated browser memory only; no fetch fallback, persistence, sockets or backend imports. */
export function createDemoController({ origin = globalThis.location?.origin || 'https://viios-demo.invalid', now = () => new Date().toISOString() } = {}) {
  let state = createFixtures(now());
  async function fetchDemo(input, init = {}) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const signal = init.signal || request?.signal;
    signal?.throwIfAborted();
    let url;
    try { url = new URL(request ? request.url : String(input), origin); } catch { return fail('Demo isteği geçersiz.', 400); }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('Demo dış adreslere bağlanmaz.');
    if (!url.pathname.startsWith('/api/')) return missing();
    const method = (init.method || request?.method || 'GET').toUpperCase();
    let path = url.pathname.slice(4);
    const query = url.searchParams;
    const read = method === 'GET';
    if (path === '/setup' && read) return json({ required: false, demo: true });
    if (path === '/session' && read) return json({ authenticated: true, demo: true });
    if (['/login', '/logout'].includes(path) && method === 'POST') return json({ authenticated: true, demo: true });
    if (path === '/demo' && read) return json({ demo: true, message: DEMO_NOTICE });
    if (path.startsWith('/connections')) {
      if (path === '/connections' && read) return json({ servers: Object.values(state.servers).map(server => server.connection), demo: true });
      if (read) {
        const id = path.split('/')[2];
        const connection = Object.hasOwn(state.servers, id) ? state.servers[id].connection : null;
        return connection ? json({ server: connection, demo: true }) : missing();
      }
      // Reject before parsing any supplied credentials: they never enter state.
      return fail('Demo gerçek sunucuya bağlanmaz. IP, kullanıcı adı veya şifre girmeyin; örnek Linux ve Windows sunucularını inceleyebilirsiniz.');
    }
    if (path === '/servers' && read) return json({ servers: Object.values(state.servers).map(server => server.connection), demo: true });
    if (path === '/servers/discover' && method === 'POST') return json({ ok: true, demo: true, message: DEMO_NOTICE });
    if (path.startsWith('/team')) return path === '/team' && read ? json(state.team) : readonly();
    let server = state.servers[DEMO_SERVER_IDS[0]];
    const scoped = /^\/servers\/([^/]+)(\/.*)$/.exec(path);
    if (scoped) { server = Object.hasOwn(state.servers, scoped[1]) ? state.servers[scoped[1]] : null; path = scoped[2]; }
    if (!server) return missing();
    if (path.startsWith('/credentials') && !read) return readonly();
    let body;
    const jsonBody = async () => {
      if (body !== undefined) return body;
      const raw = init.body !== undefined ? init.body : request ? await request.clone().text() : '{}';
      if (typeof raw !== 'string' || raw.length > 256 * 1024) throw new Error('invalid');
      body = JSON.parse(raw || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
      return body;
    };
    try {
      if (path === '/inventory' && read) return json({ ...server.inventory, unread: server.events.filter(event => !event.read && event.notify).length });
      if (['/scan', '/previews'].includes(path) && method === 'POST') return json({ ok: true, demo: true, message: 'Örnek görünüm yenilendi; ağ taraması yapılmadı.' }, 202);
      if (path === '/resources' && read) return json({ ...server.resources, sampledAt: Date.now() });
      if (path === '/overview' && read) return json({ ...server.overview, sampledAt: Date.now() });
      if (path === '/processes' && read) return json({ available: true, demo: true, platform: server.connection.platform, sampledAt: Date.now(), partial: false, processes: server.processes });
      if (path.startsWith('/processes/')) {
        if (!read) return readonly();
        const match = /^\/processes\/(\d+)$/.exec(path);
        const process = match && server.processes.find(row => row.pid === Number(match[1]));
        return process ? json({ process }) : missing();
      }
      if (path === '/services' && read) return json({ available: true, demo: true, platform: server.connection.platform, sampledAt: Date.now(), partial: false, services: server.services });
      if (path.startsWith('/services/')) {
        if (!read) return readonly();
        const match = /^\/services\/([^/]+)(\/logs)?$/.exec(path);
        const service = match && server.services.find(row => row.name === decodeURIComponent(match[1]));
        if (!service) return missing();
        return match[2] ? json({ available: service.canLogs, reason: service.canLogs ? 'Temsili demo günlükleri.' : 'Windows olay günlükleri bu sürümde desteklenmiyor.', entries: service.canLogs ? [{ at: Date.now(), priority: 6, message: 'Demo servisi hazır. Bu kayıt örnek veridir.' }] : [] }) : json({ ok: true, service });
      }
      if (path === '/storage' && read) return json(server.storage);
      if (path === '/storage/apps' && read) return json(server.appUsage);
      if (path === '/storage/usage' && read) {
        const listing = listFiles(server, query.get('path') || '/', '', 0, state.now);
        if (!listing) return missing();
        const entries = listing.entries.map(file => ({ name: file.name, path: file.path, kind: file.kind, bytes: file.size, partial: false, navigable: file.kind === 'directory', mount: server.storage.volumes.some(volume => volume.mount === file.path) }));
        return json({ path: listing.path, totalBytes: entries.reduce((sum, file) => sum + (file.bytes || 0), 0), entries, status: 'ready', scannedAt: state.now, partial: false });
      }
      if (path === '/desktop-layout') {
        if (read) return json(server.desktop);
        if (method !== 'PUT') return readonly();
        const change = await jsonBody();
        if (change.revision !== server.desktop.revision) return fail('Demo masaüstü düzeni güncellendi; tekrar deneyin.', 409);
        server.desktop = { version: 1, revision: change.revision + 1, dock: layoutList(change.dock, 32), desktop: layoutList(change.desktop, 16) };
        return json(server.desktop);
      }
      const annotation = /^\/apps\/(\d+)\/annotation$/.exec(path);
      if (annotation && method === 'PATCH') {
        const app = server.inventory.apps.find(item => item.port === Number(annotation[1]));
        if (!app) return missing();
        const value = await jsonBody();
        if (value.revision !== app.annotation.revision) return fail('Not güncellendi; tekrar açın.', 409);
        app.annotation = { displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 160) : '', note: typeof value.note === 'string' ? value.note.slice(0, 2000) : '', favorite: value.favorite === true, expectedUp: value.expectedUp === true, tags: Array.isArray(value.tags) ? value.tags.filter(tag => typeof tag === 'string').slice(0, 12).map(tag => tag.slice(0, 40)) : [], revision: app.annotation.revision + 1, updatedAt: state.now };
        return json({ ok: true, annotation: app.annotation });
      }
      const control = /^\/apps\/(\d+)\/control$/.exec(path);
      if (control) {
        const app = server.inventory.apps.find(item => item.port === Number(control[1]));
        return !app ? missing() : read ? json({ control: app.control }) : readonly();
      }
      const preview = /^\/previews\/(\d+)$/.exec(path);
      if (preview && read) return new Response(demoPreviewSvg(server.connection.id, preview[1]), { headers: { 'Content-Type': 'image/svg+xml', 'X-ViiOS-Demo': 'true' } });
      if (/^\/apps\/\d+\/open$/.test(path)) return readonly();
      if (path === '/ports/free' && read) return json(freePorts(server, query, state.now));
      if (path === '/events' && read) {
        const filtered = server.events.filter(event => (!query.get('type') || event.type === query.get('type')) && (!query.get('port') || event.port === Number(query.get('port'))) && (query.get('notifications') !== 'true' || event.notify));
        const offset = boundedNumber(query.get('offset'), 0, 0, 1000), limit = boundedNumber(query.get('limit'), 50, 1, 200);
        return json({ events: filtered.slice(offset, offset + limit), total: filtered.length, nextAuditAt: server.inventory.nextAuditAt, lastDailyAuditDay: server.inventory.lastDailyAuditDay });
      }
      if (path === '/notifications/read' && method === 'POST') {
        const change = await jsonBody();
        if (!Array.isArray(change.ids)) return fail('Bildirim kimlikleri geçersiz.', 400);
        for (const event of server.events) if (change.ids.includes(event.id)) event.read = true;
        return json({ ok: true, demo: true });
      }
      if (path.startsWith('/reports/') && read) {
        const kind = path.split('/')[2];
        const data = kind === 'inventory' ? server.inventory : kind === 'events' ? { events: server.events } : kind === 'free-ports' ? freePorts(server, new URLSearchParams({ ...Object.fromEntries(query), offset: '0', limit: '65535' }), state.now) : null;
        if (!data) return missing();
        const format = query.get('format') || 'csv';
        const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
        const rows = kind === 'inventory' ? [['Demo uygulama', 'Port', 'Durum'], ...server.inventory.apps.map(app => [app.name, app.port, 'Temsili / hazır'])] : kind === 'events' ? [['Demo olay', 'Açıklama'], ...server.events.map(event => [event.type, event.message])] : [['Demo boş port'], ...data.ports.map(item => [item.port])];
        return new Response(format === 'json' ? JSON.stringify({ demo: true, ...data }, null, 2) : '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), { headers: { 'Content-Type': format === 'json' ? 'application/json' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="viios-demo-${kind}.${format === 'json' ? 'json' : 'csv'}"`, 'X-ViiOS-Demo': 'true' } });
      }
      if (path === '/credentials' && read) return json({ revision: 0, entries: server.projects.map(project => ({ id: 'demo-' + project.id, name: project.name + ' · Demo', url: 'https://example.invalid/demo', username: 'demo-user', hasPassword: false, note: 'Temsili kayıt. Bu demoda şifre saklanmaz ve dış bağlantı açılmaz.', updatedAt: state.now })) });
      if (path === '/credentials/sync' && read) return json({ enabled: false, disabledReason: 'Demo verileri sabittir; gerçek erişim bilgisi taranmaz.', scanning: false, timeZone: 'Europe/Istanbul', schedule: '00:00', lastAttemptAt: null, lastSuccessAt: null, lastDailyDay: null, nextRunAt: null, lastResult: null, warnings: [], lastError: null });
      if (path === '/models' && read || path === '/models/refresh' && method === 'POST') return json(server.catalog);
      if (path === '/models/concurrency' && read) return json({ checkedAt: state.now, refreshing: false, stale: false, error: null, services: [{ id: server.connection.id + '-ollama', endpoint: `http://${server.connection.host}:11434`, host: server.connection.host, runtime: 'Ollama', status: 'ok', checkedAt: state.now, running: 2, waiting: 0, configuredParallelism: 4, configuredQueueLimit: 32, configuredParallelismScope: 'service', scope: 'service', modelName: null, sources: [{ kind: 'configuration', source: 'Demo', detail: DEMO_NOTICE }], note: 'Temsili ölçümler; gerçek istek gönderilmez.', capacity: { status: 'not_tested' } }] });
      if (path === '/models/benchmark/options' && read) return json({ scannedAt: state.now, models: server.catalog.models.filter(model => model.endpoint), canStart: false, unavailableReason: 'Demo modunda modele istek gönderilmez; kapasite testi yerel kurulumda kullanılabilir.' });
      if (path === '/models/benchmark/runs' && read) return json({ active: null, history: [] });
      if (path.startsWith('/models/benchmark') && !read) return readonly();
      if (path === '/files/capabilities' && read) return json({ available: true, roots: [server.base], defaultPath: server.base, reason: 'Demo dosyaları yalnız görüntülenir.', textLimit: 65536, fileLimit: 65536, streamUpload: false, streamExport: false });
      if (['/files/list', '/files/search'].includes(path) && read) {
        const result = listFiles(server, query.get('path') || server.base, query.get('query') || '', boundedNumber(query.get('offset'), 0, 0, 10000), state.now, path.endsWith('/search'));
        return result ? json(result) : missing();
      }
      if (['/files/read', '/files/download', '/files/properties'].includes(path) && read) {
        const file = server.files[query.get('path')];
        if (!file) return missing();
        if (path === '/files/properties') return json({ ...entry(file, state.now), parent: parentPath(file.path), permissions: file.kind === 'directory' ? 'dr-xr-xr-x' : '-r--r--r--', owner: 'demo', group: 'demo', sizeBytes: file.size, allocatedBytes: file.size, files: file.kind === 'file' ? 1 : 3, directories: file.kind === 'directory' ? 1 : 0, links: 0, special: 0, accessedAt: Date.parse(state.now), metadataChangedAt: Date.parse(state.now), scannedAt: Date.parse(state.now), restricted: false, partial: false, skipped: 0, changed: false, timedOut: false, sharedReferences: 0 });
        if (file.kind !== 'file') return missing();
        if (path === '/files/download') return new Response(file.content, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="demo.txt"', 'X-ViiOS-Demo': 'true' } });
        return json({ name: file.name, path: file.path, kind: 'text', size: file.size, revision: 'demo-file', editable: false, content: file.content });
      }
      if (path === '/files/trash' && read) return json({ entries: [] });
      if (path.startsWith('/files/') && !read) return readonly();
      if (path === '/versions/capabilities' && read) return json({ available: true, reason: 'Demo sürüm geçmişi yalnız görüntülenir.', root: server.base, roots: [server.base], projectRoots: server.projects.map(project => project.path), gitVersion: 'Demo', automatic: false, ignore: [], readOnly: true });
      if (path === '/versions/projects' && read) return json({ projects: server.projects });
      if (path === '/versions/action' && method === 'POST') return versionRead(server, await jsonBody());
      if (path.startsWith('/ops')) return readonly();
      return read ? missing() : readonly();
    } catch {
      signal?.throwIfAborted();
      return fail('Demo isteğinin alanları geçersiz.', 400);
    }
  }
  return { fetch: fetchDemo, reset() { state = createFixtures(now()); } };
}

const defaultController = createDemoController();
export const demoFetch = (input, init) => defaultController.fetch(input, init);
