import { Transform } from 'node:stream';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });

export function uploadRequest(query) {
  if (typeof query.path !== 'string' || !query.path.startsWith('/') || query.path.length > 4096 || query.path.includes('\0') ||
      typeof query.size !== 'string' || !/^\d+$/.test(query.size) || !Number.isSafeInteger(Number(query.size)))
    throw problem('Geçersiz yükleme yolu veya dosya boyutu.');
  return { action: 'upload-stream', path: query.path, size: Number(query.size) };
}

// Binary request bytes flow straight to the privileged helper with backpressure.
// Only a completely received HTTP request can append the commit marker.
export function createUploadReceiver({ openStream, log = async () => {} }) {
  return async function receive(req) {
    const request = uploadRequest(req.query);
    if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream')
      throw problem('Yükleme için ikili dosya akışı gerekiyor.', 415);
    if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== request.size)
      throw problem('Dosya boyutu istekle eşleşmiyor.');
    req.setTimeout?.(0);
    const child = await openStream();
    let output = '', failed, received = 0, killTimer;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > request.size) callback(problem('Gönderilen veri belirtilen dosya boyutunu aşıyor.'));
        else callback(null, chunk);
      },
    });
    const stop = () => {
      req.unpipe(counter); counter.unpipe(child.stdin); counter.destroy(); child.stdin.destroy();
      // EOF lets Python remove the stage; SIGTERM also has a cleanup handler.
      if (child.exitCode === null && child.signalCode === null && !killTimer)
        killTimer = setTimeout(() => child.kill(), 10000).unref();
    };
    const aborted = () => { failed = problem('Yükleme bağlantısı kesildi.', 499); stop(); };
    const ended = () => {
      if (!req.complete || received !== request.size) return aborted();
      child.stdin.end('\nMANAGEMENT-UPLOAD-COMMIT\n');
    };
    req.once('aborted', aborted);
    req.once('error', aborted);
    counter.once('end', ended);
    counter.once('error', error => { failed = error; stop(); });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    try {
      const closed = new Promise((resolve) => {
        child.once('error', () => resolve(-1));
        child.once('close', resolve);
      });
      child.stdout.on('data', chunk => {
        if (output.length + chunk.length > 16384) {
          failed = problem('Yükleme yanıtı geçersiz.', 502); stop();
        } else output += chunk;
      });
      if (req.aborted || req.destroyed) aborted();
      else {
        child.stdin.write(JSON.stringify(request) + '\n');
        req.pipe(counter).pipe(child.stdin, { end: false });
      }
      const code = await closed;
      if (failed) throw failed;
      let result;
      try { result = JSON.parse(output); } catch { /* Never expose helper output. */ }
      if (code !== 0 || !result?.ok)
        throw problem(result?.error || 'Yükleme tamamlanamadı. Bağlantıyı ve disk alanını kontrol edin.', result?.status || 503);
      await log('file_upload', `Dosya yüklendi: ${result.path}`).catch(() => {});
      return result;
    } catch (error) {
      await log('file_failed', `Dosya yüklenemedi: ${request.path}`).catch(() => {});
      throw error;
    } finally {
      req.off('aborted', aborted); req.off('error', aborted); counter.off('end', ended);
      stop();
      clearTimeout(killTimer);
      if (!req.destroyed && !req.complete) req.resume();
    }
  };
}
