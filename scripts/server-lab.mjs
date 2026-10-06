// Explicit local integration lab. No imports from the production startup path.
import { generateKeyPairSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processRequest } from '../server/processes.mjs';
import { serviceRequest } from '../server/services.mjs';
import { createLabService,labServiceName } from './lab-service.mjs';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ssh2 from 'ssh2';
import { createConnectionStore, privatePermissions, securePrivateDirectory } from '../server/connection-store.mjs';
import { createAdminSetup } from '../server/admin-setup.mjs';
import { managedCommand, probeHost } from '../server/ssh-transport.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpers = new Map(['resources','processes','services','storage','scan','control','files'].map(helper => [managedCommand(`sudo -n /usr/bin/python3 -I /opt/viios-agent/${helper}.py${helper === 'scan' ? ' 1 65535' : ''}`, 'windows'), helper]));
export const labHelper = command => helpers.get(command) || null;
export const labForward = info => info.destIP === '127.0.0.1' && info.destPort === 3281;
export function labProcessRequest(request, worker) {
  processRequest(request);
  return request.action !== 'terminate' || (!!worker && request.pid === worker.pid && request.token === worker.token);
}
const same = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

async function listen(server, port) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}
export async function startLab() {
  if (process.platform !== 'win32') throw new Error('This lab uses the real Windows adapter. Run it on Windows.');
  const labDir = path.join(root, 'data', 'server-lab'), dataDir = path.join(labDir, 'controller');
  await securePrivateDirectory(labDir);
  const lockPath = path.join(labDir, 'running.lock');
  try {
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lab lock; inspect data/server-lab/running.lock.');
    try { process.kill(pid, 0); throw new Error('A lab process is already running.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; await rm(lockPath); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close();
  let controller, sshServer, httpServer, labService, stopping = false;
  const clients = new Set(), children = new Set();
  let fixture = null;
  const stop = async () => {
    if (stopping) return; stopping = true;
    controller?.kill(); for (const child of children) child.kill();
    await labService?.shutdown().catch(()=>{});
    for (const client of clients) client.destroy();
    sshServer?.close(); httpServer?.close(); httpServer?.closeAllConnections();
    await rm(lockPath, { force: true });
  };
  try {
    // Reserve the controller port before provisioning; never replace an existing app.
    const reservation = net.createServer(); await listen(reservation, 3280); await new Promise(resolve => reservation.close(resolve));
    const runtimeFile = path.join(labDir, 'runtime.json');
    let runtime;
    try { runtime = JSON.parse(await readFile(runtimeFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      runtime = { sshPassword: randomBytes(24).toString('base64url'), adminPassword: randomBytes(15).toString('base64url'),
        hostKey: generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey };
      await writeFile(runtimeFile, JSON.stringify(runtime), { flag: 'wx', mode: 0o600 }); await privatePermissions(runtimeFile);
    }
    const filesDir = path.join(labDir, 'sample-files'); await mkdir(path.join(filesDir, 'example-app'), { recursive: true });
    for (const [name, content] of [['README.txt','ViiOS storage lab. Synthetic sample files only.'],['example-app/example.log','Example service started.\n'.repeat(400)]]) {
      try { await writeFile(path.join(filesDir,name),content,{flag:'wx'}); } catch(error) { if(error.code!=='EEXIST')throw error; }
    }
    const startFixture = async () => {
      if (stopping) return;
      const worker = spawn(process.execPath,[path.join(root,'scripts/lab-worker.mjs')],{windowsHide:true,stdio:'ignore'});
      children.add(worker);
      worker.on('error', () => {});
      worker.on('exit', () => {children.delete(worker);if(fixture?.pid===worker.pid)fixture=null;if(!stopping)setTimeout(()=>void startFixture().catch(()=>{}),1000);});
      await new Promise((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject);});
      const {stdout} = await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${worker.pid}).StartTime.ToFileTimeUtc().ToString()`],{windowsHide:true,timeout:10000});
      if(worker.exitCode!==null || !/^\d+$/.test(stdout.trim()))return;
      fixture={pid:worker.pid,token:createHash('sha256').update(`${worker.pid}:${stdout.trim()}`).digest('hex')};
      await writeFile(path.join(labDir,'worker.json'),JSON.stringify(fixture));
    };
    await startFixture();
    labService=await createLabService({root,dataDir:labDir});
    httpServer = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('<!doctype html><html lang="en"><title>ViiOS Local Test Server</title><style>body{background:#102531;color:#d9f6ef;font:18px system-ui;padding:64px}b{color:#39e8bf}</style><h1>ViiOS <b>Local Test Server</b></h1><p>Live loopback HTTP application on port 3281.</p><p>This is a local Windows test process, not a virtual machine.</p></html>'); });
    await listen(httpServer, 3281);
    sshServer = new ssh2.Server({ hostKeys: [runtime.hostKey] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
      client.on('authentication', context => context.method === 'password' && context.username === 'viios-lab' && same(context.password, runtime.sshPassword) ? context.accept() : context.reject());
      client.on('ready', () => {
        client.on('session', accept => {
          const session = accept();
          session.on('exec', (acceptExec, reject, info) => {
            const helper = labHelper(info.command); if (!helper) return reject();
            const stream = acceptExec(); stream.on('error', () => {});
            const reply = value => { stream.exit(0); stream.end(JSON.stringify(value)); };
            const unavailable = (message, status = 501) => reply({ok:false,available:false,status,error:message});
            const run = request => {
            if (helper === 'services') {
              serviceRequest(request);
              if (request.name === labServiceName) { void labService.run(request).then(reply).catch(error=>unavailable(error.message,error.status||503));return; }
              if (!['list','details','logs'].includes(request.action)) return unavailable('Real Windows service mutations are disabled in the lab.',403);
            }
            if (helper === 'files' && !['capabilities','list','read','properties'].includes(request.action)) return unavailable('Lab files are read-only.',403);
            if (helper === 'control' && request.action !== 'status') return unavailable('Service mutations are disabled in the read-only lab.');
            if (helper === 'processes' && !labProcessRequest(request,fixture)) return unavailable('Only the lab-owned test process can be terminated.',403);
            // Fixed helpers only. Mutation is restricted to our disposable child.
            const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/server-lab-agent.ps1'),'-Helper',helper,'-Root',filesDir,'-AllowedProcessId',String(fixture?.pid??-1),'-AllowedProcessToken',fixture?.token||'none'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
            child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
            children.add(child); let length = 0, serviceOutput='';
            const timer = setTimeout(() => child.kill(), helper==='services'?60000:45000);
            child.stdout.on('data', chunk => { length += chunk.length; if (length > 3 * 1024 * 1024) child.kill(); else if(helper==='services'&&request.action==='list')serviceOutput+=chunk;else stream.write(chunk); });
            child.stderr.resume();
            child.on('error', () => { clearTimeout(timer); children.delete(child); stream.exit(1); stream.end(); });
            child.on('close', code => { clearTimeout(timer); children.delete(child); if (!stream.destroyed) { if(helper==='services'&&request.action==='list'&&code===0){try{const value=JSON.parse(serviceOutput);if(value.ok&&Array.isArray(value.services)){value.services=value.services.slice(0,1999);value.services.push(labService.row());}reply(value);return;}catch{unavailable('Invalid local service response.',502);return;}}stream.exit(code ?? 1); stream.end(); } });
            stream.on('close', () => child.kill());
            };
            if (['files','storage','control','processes','services'].includes(helper)) {
              let input = '';
              stream.on('data', chunk => { input += chunk; if (input.length > 16384) { unavailable('Request too large.',413); stream.destroy(); } });
              stream.on('end', () => { if (input.length > 16384) return; try { run(JSON.parse(input || '{}')); } catch { unavailable('Invalid request.',400); } });
            } else { stream.resume(); run({}); }
          });
        });
        client.on('tcpip', (accept, reject, info) => {
          if (!labForward(info)) return reject();
          const socket = net.connect(3281, '127.0.0.1');
          socket.on('error', () => { socket.destroy(); });
          socket.once('connect', () => { const stream = accept(); stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy()); socket.pipe(stream).pipe(socket); });
        });
      });
    });
    await listen(sshServer, 2222);
    const probe = await probeHost({ host: '127.0.0.1', port: 2222, platform: 'windows' });
    const store = createConnectionStore({ dataDir }); await store.initialize();
    // This target is pre-provisioned by this lab script. It does not simulate or
    // claim to validate the administrator-required production bootstrap.
    let record = store.list().find(record => record.host === '127.0.0.1' && record.port === 2222);
    if (!record) record = await store.add({ name: 'Local Windows Lab · gerçek ölçümler', host: '127.0.0.1', port: 2222, platform: 'windows', username: 'viios-lab', authType: 'password', password: runtime.sshPassword, fingerprint: probe.fingerprint });
    await store.patch(record.id, { status: 'ready', phase: 'complete', message: 'Local lab; only the dedicated test process permits termination. Production bootstrap not exercised.', capabilities: { inventory:true,resources:true,processes:true,services:true,storage:true,files:true,control:false,versions:false,models:false,lab:true } });
    await store.shutdown();
    const setup = await createAdminSetup({ dataDir }); if (setup.status().required) await setup.configure({ password: runtime.adminPassword, confirmPassword: runtime.adminPassword });
    const loginFile = path.join(labDir, 'LOGIN.txt');
    await writeFile(loginFile, `ViiOS local lab: http://127.0.0.1:3280/?view=overview\nPassword: ${runtime.adminPassword}\nReal Windows host metrics over a restricted local SSH target. No VM or production bootstrap.\n`); await privatePermissions(loginFile);
    controller = spawn(process.execPath, [path.join(root,'server/index.mjs')], { cwd:root, windowsHide:true, stdio:['ignore','inherit','inherit'], env:{...process.env,APP_HOST:'127.0.0.1',APP_PORT:'3280',DATA_DIR:dataDir,SESSION_COOKIE_NAME:'viios_lab_session',BACKGROUND_SCANS_ENABLED:'false'} });
    controller.on('error', () => void stop()); controller.on('exit', () => void stop());
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    console.log(`Local lab started. Login instructions: ${loginFile}`);
    return { stop, serverId: record.id };
  } catch (error) { await stop(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await startLab();
