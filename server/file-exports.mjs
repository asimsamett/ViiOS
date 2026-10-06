import { randomUUID } from 'node:crypto';

const terminal = new Set(['complete', 'failed', 'cancelled']);
const problem = (message, status = 400) =>
  Object.assign(new Error(message), { status });

// Per-target, authenticated download jobs. Archive bytes never become a JSON
// string or a browser Blob, so Node/browser single-allocation limits do not apply.
export function createExportTransfers({ openStream, log = async () => {} }) {
  const jobs = new Map();
  function clean() {
    for (const [id, job] of jobs) {
      if (
        (terminal.has(job.state) && Date.now() - job.updatedAt > 3600000) ||
        (job.state === 'pending' && Date.now() - job.updatedAt > 600000)
      )
        jobs.delete(id);
    }
  }
  function get(id) {
    clean();
    const job = jobs.get(id);
    if (!job)
      throw problem(
        'Dışa aktarım kaydı bulunamadı. Yeniden dışa aktarın.',
        404,
      );
    return job;
  }
  function status(id) {
    const { request: _request, cancel: _cancel, ...visible } = get(id);
    return visible;
  }
  function create(request) {
    clean();
    const id = randomUUID();
    jobs.set(id, {
      id,
      request,
      state: 'pending',
      sentBytes: 0,
      sourceBytes: null,
      entries: null,
      updatedAt: Date.now(),
    });
    return status(id);
  }
  function cancel(id) {
    const job = get(id);
    if (terminal.has(job.state)) return status(id);
    job.state = 'cancelled';
    job.error = 'Dışa aktarım iptal edildi.';
    job.updatedAt = Date.now();
    job.cancel?.();
    return status(id);
  }
  async function download(id, req, res) {
    const job = get(id);
    if (req.method !== 'GET')
      throw problem('Bu indirme için GET kullanın.', 405);
    if (req.headers.range)
      throw problem('Bu aktarım devam ettirilemez. Yeniden dışa aktarın.', 409);
    if (job.state !== 'pending')
      throw problem(
        'Bu indirme zaten başlatıldı. Yeni bir dışa aktarım oluşturun.',
        409,
      );
    job.state = 'preparing'; // Claim before awaiting SSH/profile lookup.
    let child;
    const stop = () => {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.kill();
    };
    job.cancel = () => {
      stop();
      res.destroy();
    };
    const disconnected = () => {
      if (!res.writableFinished && !terminal.has(job.state)) cancel(id);
    };
    res.on('close', disconnected);
    try {
      child = await openStream(job.request);
      if (job.state === 'cancelled') {
        stop();
        return;
      }
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 8192)
          stderr += chunk.toString().slice(0, 8192 - stderr.length);
      });
      child.stdin.on('error', () => {});
      const closed = new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: -1, error }));
        child.once('close', (code) => resolve({ code }));
      });
      child.stdin.write(
        JSON.stringify({ ...job.request, action: 'export-stream' }) + '\n',
      );
      let header = Buffer.alloc(0),
        ready = false;
      for await (let chunk of child.stdout) {
        if (job.state === 'cancelled') break;
        if (!ready) {
          const newline = chunk.indexOf(10);
          if (header.length + (newline < 0 ? chunk.length : newline) > 16384)
            throw problem('Dışa aktarım başlığı geçersiz.', 502);
          if (newline < 0) {
            header = Buffer.concat([header, chunk]);
            continue;
          }
          const metadata = JSON.parse(
            Buffer.concat([header, chunk.subarray(0, newline)]).toString(),
          );
          if (
            metadata.ok !== true ||
            typeof metadata.name !== 'string' ||
            !Number.isSafeInteger(metadata.bytes) ||
            !Number.isSafeInteger(metadata.entries)
          )
            throw problem('Dışa aktarım başlığı geçersiz.', 502);
          job.sourceBytes = metadata.bytes;
          job.entries = metadata.entries;
          job.state = 'streaming';
          res.setHeader(
            'Content-Security-Policy',
            "sandbox; default-src 'none'; frame-ancestors 'none'",
          );
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(metadata.name).replaceAll("'", '%27')}`,
          );
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Accel-Buffering', 'no');
          ready = true;
          chunk = chunk.subarray(newline + 1);
        }
        if (!chunk.length) continue;
        if (!res.write(chunk))
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              res.off('drain', drain);
              res.off('close', close);
              res.off('error', close);
            };
            const drain = () => {
              cleanup();
              resolve();
            };
            const close = () => {
              cleanup();
              reject(problem('İndirme bağlantısı kapandı.', 499));
            };
            res.once('drain', drain);
            res.once('close', close);
            res.once('error', close);
            if (res.destroyed) close();
          });
        job.sentBytes += chunk.length;
        job.updatedAt = Date.now();
      }
      if (job.state === 'cancelled') return;
      const result = await closed;
      if (result.code !== 0 || !ready) {
        let detail;
        try {
          detail = JSON.parse(stderr.trim().split('\n').at(-1));
        } catch {
          /* Never expose raw stderr. */
        }
        throw problem(
          detail?.error ||
            'Dışa aktarım tamamlanamadı. Sunucu bağlantısını ve kaynak dosyaları kontrol edin.',
          detail?.status || 503,
        );
      }
      // Only successful helper exit may finish the HTTP body; a truncated ZIP
      // must remain a failed download, even if Python wrote a central directory.
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          res.off('finish', finish);
          res.off('close', close);
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const close = () => {
          cleanup();
          reject(problem('İndirme bağlantısı kapandı.', 499));
        };
        res.once('finish', finish);
        res.once('close', close);
        res.end();
      });
      job.state = 'complete';
      await log(
        'file_export',
        `Dışa aktarım gönderildi: ${job.request.path}`,
      ).catch(() => {});
    } catch (error) {
      if (job.state !== 'cancelled') {
        job.state = 'failed';
        job.error = error.message;
        await log(
          'file_failed',
          `Dışa aktarım tamamlanamadı: ${job.request.path} — ${error.message}`,
        ).catch(() => {});
      }
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else res.status(error.status || 503).json({ error: job.error });
      }
    } finally {
      stop();
      res.off('close', disconnected);
      delete job.cancel;
      job.updatedAt = Date.now();
    }
  }
  return {
    create,
    status,
    cancel,
    download,
    shutdown() {
      for (const job of jobs.values())
        if (!terminal.has(job.state)) {
          job.state = 'cancelled';
          job.error = 'Sunucu yeniden başlatıldığı için aktarım kesildi.';
          job.updatedAt = Date.now();
          job.cancel?.();
        }
    },
  };
}
