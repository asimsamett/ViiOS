import { readConnectionProfile } from './ssh-transport.mjs';
import { spawn } from './ssh-transport.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createExportTransfers } from './file-exports.mjs';
import { createUploadReceiver } from './file-uploads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changes = new Set([
  'write',
  'create',
  'mkdir',
  'upload',
  'upload-directory',
  'copy',
  'move',
  'trash',
  'restore',
]);
const actions = new Set([
  'capabilities',
  'list',
  'search',
  'properties',
  'read',
  'download',
  'export',
  'trash-list',
  ...changes,
]);
const label = {
  write: 'Dosya kaydedildi',
  create: 'Dosya oluşturuldu',
  mkdir: 'Klasör oluşturuldu',
  upload: 'Dosya yüklendi',
  'upload-directory': 'Yükleme klasörü hazırlandı',
  copy: 'Öğe kopyalandı',
  move: 'Öğe taşındı / yeniden adlandırıldı',
  trash: 'Öğe çöp kutusuna taşındı',
  restore: 'Öğe geri yüklendi',
};
export function validateFileRequest(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !actions.has(body.action)
  )
    throw Object.assign(new Error('Geçersiz dosya işlemi.'), { status: 400 });
  const allowed = {
    capabilities: [],
    list: ['path', 'query', 'offset', 'hidden'],
    search: ['path', 'query', 'hidden'],
    properties: ['path'],
    read: ['path'],
    download: ['path'],
    export: ['path', 'revision'],
    'trash-list': [],
    write: ['path', 'content', 'revision'],
    create: ['path', 'content'],
    upload: ['path', 'data'],
    'upload-directory': ['path'],
    mkdir: ['path'],
    copy: ['path', 'destination', 'revision'],
    move: ['path', 'destination', 'revision'],
    trash: ['path', 'revision'],
    restore: ['root', 'id'],
  }[body.action];
  if (Object.keys(body).some((k) => k !== 'action' && !allowed.includes(k)))
    throw Object.assign(new Error('Beklenmeyen dosya parametresi.'), {
      status: 400,
    });
  for (const key of ['path', 'destination'])
    if (
      body[key] !== undefined &&
      (typeof body[key] !== 'string' ||
        body[key].length > 4096 ||
        !body[key].startsWith('/') ||
        body[key].includes('\0'))
    )
      throw Object.assign(new Error('Geçersiz dosya yolu.'), { status: 400 });
  if (body.action === 'properties' && typeof body.path !== 'string')
    throw Object.assign(
      new Error('Özellikler için bir dosya veya klasör seçin.'),
      { status: 400 },
    );
  if (
    body.action === 'search' &&
    (typeof body.query !== 'string' ||
      body.query.trim().length < 2 ||
      body.query.trim().length > 120 ||
      (body.hidden !== undefined && typeof body.hidden !== 'boolean'))
  )
    throw Object.assign(new Error('Arama için 2–120 karakter girin.'), {
      status: 400,
    });
  if (
    body.action === 'export' &&
    (typeof body.path !== 'string' ||
      typeof body.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.revision))
  )
    throw Object.assign(
      new Error('Dışa aktarmak için güncel öğe bilgisi gerekiyor.'),
      { status: 400 },
    );
  return body;
}
export function createFileManager({ id, mode, host, log }) {
  const children = new Set();
  let closed = false;
  async function profile() { return readConnectionProfile({ id, host, mode }); }
  async function invoke(body) {
    validateFileRequest(body);
    const p = await profile();
    if (!p) {
      if (body.action === 'capabilities')
        return {
          available: false,
          roots: [],
          reason:
            'Bu sunucu için dosya erişimi henüz yapılandırılmadı. Sunucuyu ekleme ekranından kurulumu tamamlayın.',
        };
      throw Object.assign(
        new Error('Bu sunucuda dosya yönetimi kullanılamıyor.'),
        { status: 403 },
      );
    }
    if (closed)
      throw Object.assign(new Error('Dosya servisi kapanıyor.'), {
        status: 503,
      });
    if (body.action === 'export')
      throw Object.assign(
        new Error(
          'Büyük dışa aktarımlar için /files/exports indirme akışını kullanın.',
        ),
        { status: 409 },
      );
    try {
      const response = await new Promise((resolve, reject) => {
        const command = p.transport === 'ssh' ? 'ssh' : 'sudo';
        const args =
          p.transport === 'ssh'
            ? [
                '-o',
                'BatchMode=yes',
                '-o',
                'ConnectTimeout=10',
                p.sshTarget,
                'sudo -n /usr/bin/python3 -I /opt/viios-agent/files.py',
              ]
            : [
                '-n',
                '/usr/bin/python3',
                '-I',
                path.join(root, 'server/files.py'),
              ];
        const child = spawn(command, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        let data = '',
          done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          children.delete(child);
          if (error) reject(error);
          else resolve(data);
        };
        const timer = setTimeout(
          () => {
            child.kill();
            finish(
              Object.assign(
                new Error(
                  'Dosya işlemi zaman aşımına uğradı. Yeniden denemeden önce klasörü yenileyin.',
                ),
                { status: 504 },
              ),
            );
          },
          body.action === 'search' ? 10000 : 120000,
        );
        child.stdout.on('data', (chunk) => {
          data += chunk;
          if (data.length > 26 * 1024 * 1024) {
            child.kill();
            finish(new Error('Dosya yanıtı çok büyük.'));
          }
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.on('error', () =>
          finish(new Error('Dosya bağlantısı başlatılamadı.')),
        );
        child.on('close', (code) =>
          finish(code === 0 ? null : new Error('Dosya erişimi kurulamadı.')),
        );
        child.stdin.end(JSON.stringify(body));
      });
      const result = JSON.parse(response);
      if (!result.ok)
        throw Object.assign(
          new Error(result.error || 'Dosya işlemi tamamlanamadı.'),
          { status: result.status || 503 },
        );
      if (changes.has(body.action))
        await log(
          'file_' + body.action,
          `${label[body.action]}: ${result.path || body.path || ''}${result.destination ? ' → ' + result.destination : ''}`,
        ).catch(() => {});
      return { ...result, serverId: id };
    } catch (error) {
      if (changes.has(body.action))
        await log(
          'file_failed',
          `Dosya işlemi tamamlanamadı (${body.action}): ${body.path || ''}`,
        ).catch(() => {});
      throw Object.assign(error, { status: error.status || 503 });
    }
  }
  async function openStream() {
      const p = await profile();
      if (!p)
        throw Object.assign(
          new Error('Bu sunucuda dosya yönetimi kullanılamıyor.'),
          { status: 403 },
        );
      if (closed)
        throw Object.assign(new Error('Dosya servisi kapanıyor.'), {
          status: 503,
        });
      const child = spawn(
        p.transport === 'ssh' ? 'ssh' : 'sudo',
        p.transport === 'ssh'
          ? [
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=10',
              p.sshTarget,
              'sudo -n /usr/bin/python3 -I /opt/viios-agent/files.py',
            ]
          : [
              '-n',
              '/usr/bin/python3',
              '-I',
              path.join(root, 'server/files.py'),
            ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.add(child);
      child.once('close', () => children.delete(child));
      return child;
  }
  const upload = createUploadReceiver({ openStream, log });
  const exports = createExportTransfers({
    log,
    openStream: async (request) => {
      validateFileRequest({ ...request, action: 'export' });
      return openStream();
    },
  });
  return {
    invoke,
    upload,
    exports,
    shutdown() {
      closed = true;
      exports.shutdown();
      for (const child of children) child.kill();
    },
  };
}
export function fileRouter(manager) {
  const router = express.Router();
  router.post('/upload', async (req, res) => res.json(await manager.upload(req)));
  router.get('/capabilities', async (_req, res) =>
    res.json(await manager.invoke({ action: 'capabilities' })),
  );
  router.get('/list', async (req, res) =>
    res.json(
      await manager.invoke({
        action: 'list',
        path: req.query.path || '/home',
        query: req.query.query || '',
        hidden: req.query.hidden === 'true',
        offset: req.query.offset === undefined ? 0 : Number(req.query.offset),
      }),
    ),
  );
  router.get('/search', async (req, res) =>
    res.json(
      await manager.invoke({
        action: 'search',
        path: req.query.path || '/',
        query: req.query.query || '',
        hidden: req.query.hidden === 'true',
      }),
    ),
  );
  router.get('/read', async (req, res) =>
    res.json(await manager.invoke({ action: 'read', path: req.query.path })),
  );
  router.get('/properties', async (req, res) =>
    res.json(
      await manager.invoke({ action: 'properties', path: req.query.path }),
    ),
  );
  router.get('/trash', async (_req, res) =>
    res.json(await manager.invoke({ action: 'trash-list' })),
  );
  router.post('/exports', (req, res) => {
    const request = validateFileRequest({ ...req.body, action: 'export' });
    res.status(201).json(manager.exports.create(request));
  });
  router.get('/exports/:id', (req, res) =>
    res.json(manager.exports.status(req.params.id)),
  );
  router.post('/exports/:id/cancel', (req, res) =>
    res.json(manager.exports.cancel(req.params.id)),
  );
  router.get('/exports/:id/download', (req, res) =>
    manager.exports.download(req.params.id, req, res),
  );
  router.get('/export', async (req, res) => {
    const request = validateFileRequest({
      action: 'export',
      path: req.query.path,
      revision: req.query.revision,
    });
    await manager.exports.download(
      manager.exports.create(request).id,
      req,
      res,
    );
  });
  router.get('/download', async (req, res) => {
    const result = await manager.invoke({
      action: 'download',
      path: req.query.path,
    });
    const inline =
      req.query.inline === 'true' &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        result.mime,
      );
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replaceAll("'", '%27')}`,
    );
    res
      .type(inline ? result.mime : 'application/octet-stream')
      .send(Buffer.from(result.data, 'base64'));
  });
  router.post('/action', async (req, res) =>
    res.json(await manager.invoke(req.body)),
  );
  return router;
}
