import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, readConnectionProfile } from './ssh-transport.mjs';
import { sharedResourceSample } from './resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, 256) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function processRequest(value) {
  const fields = { list: ['action'], details: ['action', 'pid'], terminate: ['action', 'pid', 'token'] };
  const keys = value && !Array.isArray(value) && Object.hasOwn(fields,value.action) && fields[value.action];
  if (!keys || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw fail('Geçersiz süreç isteği.');
  if (value.action !== 'list' && (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647)) throw fail('Geçersiz PID.');
  if (value.action === 'terminate' && (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token))) throw fail('Geçersiz süreç kimliği.');
  return value;
}
export function publicProcess(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 0) throw fail('Geçersiz süreç yanıtı.', 502);
  const token = typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token) ? value.token : null;
  return { pid: value.pid, name: text(value.name), user: text(value.user), state: text(value.state),
    parentPid: number(value.parentPid), cpuPercent: number(value.cpuPercent) === null ? null : Math.min(100, value.cpuPercent), memoryBytes: number(value.memoryBytes),
    startedAt: typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? new Date(value.startedAt).toISOString() : null,
    token, canTerminate: value.canTerminate === true && value.pid > 1 && !!token, reason: text(value.reason) };
}
export function processResponse(value, action) {
  if (!value || value.ok !== true) throw fail(value?.status === 409 ? 'Süreç kimliği değişti. Listeyi yenileyin.' : value?.status === 404 ? 'Süreç kapanmış veya artık görüntülenemiyor.' : value?.status === 403 ? 'Bu süreç korumalı veya sonlandırma yetkisi yok.' : 'Süreç işlemi yapılamadı. Agent sürümünü ve sunucu izinlerini kontrol edin.', [400,403,404,409,413,501,503].includes(value?.status) ? value.status : 503);
  if (action === 'terminate') return { ok: true, exited: value.exited === true };
  if (action === 'details') return { process: publicProcess(value.process) };
  if (!value.available || !Array.isArray(value.processes) || value.processes.length > 10000 || number(value.sampledAt) === null) throw fail('Süreç listesi alınamadı.', 502);
  return { available: true, platform: ['linux','windows'].includes(value.platform) ? value.platform : null, sampledAt: value.sampledAt,
    partial: value.partial === true, processes: value.processes.map(publicProcess) };
}
export function createProcessManager(config, dependencies = {}) {
  let closed = false, mutating = false;
  const workers = new Set();
  async function execute(request) {
    if (closed) throw fail('Süreç yöneticisi kapanıyor.', 503);
    const profile = await (dependencies.profile || readConnectionProfile)(config);
    if (closed) throw fail('Süreç yöneticisi kapanıyor.', 503);
    if (!profile) throw fail('Süreç yönetimi için yönetim bağlantısı gerekli.', 501);
    const args = profile.transport === 'ssh'
      ? ['-o','BatchMode=yes','-o','ConnectTimeout=8',profile.sshTarget,'sudo -n /usr/bin/python3 -I /opt/viios-agent/processes.py']
      : ['-n','/usr/bin/python3','-I',path.join(root,'server/processes.py')];
    const raw = await new Promise((resolve, reject) => {
      const child = (dependencies.spawn || spawn)(profile.transport === 'ssh' ? 'ssh' : 'sudo', args, {windowsHide:true,stdio:['pipe','pipe','pipe']});
      workers.add(child); let out = '', done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(timer); workers.delete(child); if (error) reject(error); else resolve(out); };
      const unavailable = () => fail('Süreçler alınamadı. Agent güncel olmayabilir veya sunucuya erişilemiyor.', 503);
      const timer = setTimeout(() => { child.kill(); finish(unavailable()); }, 45000);
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 8 * 1024 * 1024) { child.kill(); finish(unavailable()); } });
      child.stderr.resume(); child.stdin.on('error', () => finish(unavailable()));
      child.on('error', () => finish(unavailable())); child.on('close', code => finish(code === 0 ? null : unavailable()));
      child.stdin.end(JSON.stringify(request));
    });
    let data; try { data = JSON.parse(raw); } catch { throw fail('Geçersiz agent yanıtı.', 502); }
    return processResponse(data, request.action);
  }
  let list = sharedResourceSample(() => execute({ action: 'list' }));
  return {
    async run(value) {
      if (closed) throw fail('Süreç yöneticisi kapanıyor.', 503);
      const request = processRequest(value);
      if (request.action === 'list') return list();
      if (request.action === 'details') return execute(request);
      if (mutating) throw fail('Başka bir süreç işlemi sürüyor.', 409);
      mutating = true;
      try { return await execute(request); } finally { mutating = false; list = sharedResourceSample(() => execute({action:'list'})); }
    },
    shutdown() { closed = true; for (const child of workers) child.kill(); },
  };
}
export function processRouter(manager) {
  const router = express.Router();
  const pid = req => { if (!/^[1-9]\d{0,9}$/.test(req.params.pid)) throw fail('Geçersiz PID.'); return Number(req.params.pid); };
  router.get('/', async (_req,res) => res.json(await manager.run({action:'list'})));
  router.get('/:pid', async (req,res) => res.json(await manager.run({action:'details',pid:pid(req)})));
  router.post('/:pid/terminate', async (req,res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body,'token')) throw fail('Yalnız süreç kimliği gönderilmelidir.');
    res.json(await manager.run({action:'terminate',pid:pid(req),token:req.body.token}));
  });
  return router;
}
