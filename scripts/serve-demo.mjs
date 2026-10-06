import http from 'node:http';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDemoBasePath } from './build-demo.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };

export function createDemoServer(directory, baseValue = '') {
  const root = realpathSync(directory), basePath = normalizeDemoBasePath(baseValue);
  return http.createServer((request, response) => {
    const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(message); };
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Static demo: this server has no API.');
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); } catch { return fail(400, 'Invalid URL.'); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) return fail(400, 'Invalid path.');
    if (basePath && (pathname === '/' || pathname === basePath)) {
      response.writeHead(302, { Location: `${basePath}/`, 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if (basePath && !pathname.startsWith(basePath + '/')) return fail(404, 'Not found.');
    const relative = pathname.slice(basePath.length).replace(/^\/+/, '');
    if (relative === 'api' || relative.startsWith('api/') || relative.split('/').some(part => part.startsWith('.'))) return fail(404, 'Static demo: this server has no API.');
    let target = path.resolve(root, relative || 'index.html');
    try {
      if (lstatSync(target).isDirectory()) target = path.join(target, 'index.html');
      const actual = realpathSync(target), stat = lstatSync(target);
      if (!actual.startsWith(root + path.sep) || actual !== target || !stat.isFile()) return fail(404, 'Not found.');
      response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(target).on('error', () => response.destroy()).pipe(response);
    } catch { fail(404, 'Not found.'); }
  });
}

export function serveDemo(root = projectRoot, portValue = process.env.VIIOS_DEMO_PORT || '4180') {
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VIIOS_DEMO_PORT must be a valid port.');
  const metadata = JSON.parse(readFileSync(path.join(root, 'outputs', 'demo-site-latest.json'), 'utf8'));
  const directory = path.resolve(root, metadata.directory), allowed = path.resolve(root, 'outputs', 'demo-site');
  if (!directory.startsWith(allowed + path.sep) || !realpathSync(directory).startsWith(realpathSync(allowed) + path.sep)) throw new Error('Demo directory must be inside outputs/demo-site.');
  const server = createDemoServer(directory, metadata.basePath);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`ViiOS demo: http://127.0.0.1:${port}${metadata.basePath || ''}/`));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { serveDemo(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
