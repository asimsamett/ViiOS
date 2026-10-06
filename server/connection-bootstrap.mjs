import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionError } from './connection-store.mjs';
import { executeSsh, openSshConnection, withSftp } from './ssh-transport.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
export const powershellCommand = script => 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from('$env:PSModulePath=[IO.Path]::Combine($PSHOME,"Modules");\n' + script, 'utf16le').toString('base64');
const requiredLinux = ['services.py', 'processes.py', 'scan.py', 'resources.py', 'storage.py', 'files.py', 'control.py', 'versioning.py', 'versioning_access.py', 'model_catalog.py', 'model_concurrency.py'];
const linuxToolPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export async function readAgentBundle(platform, { projectRoot = projectDirectory } = {}) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'server', 'agent', 'manifest.json'), 'utf8'));
  const entries = manifest[platform];
  if (manifest.version !== 1 || !Array.isArray(entries) || !entries.length || entries.length > 100) throw connectionError('INVALID_BUNDLE', 'Kurulum paketi geçersiz.', 500);
  const serverDirectory = path.resolve(projectRoot, 'server');
  const names = new Set();
  const files = [];
  for (const entry of entries) {
    const name = entry.name;
    const filename = path.resolve(projectRoot, entry.source || '');
    if (typeof name !== 'string' || name.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') ||
        !filename.startsWith(serverDirectory + path.sep) || names.has(name)) throw connectionError('INVALID_BUNDLE', 'Kurulum paketi dosya yolu geçersiz.', 500);
    names.add(name);
    const content = await readFile(filename);
    if (content.length > 4 * 1024 * 1024) throw connectionError('INVALID_BUNDLE', 'Kurulum paketi dosyası çok büyük.', 500);
    files.push({ name, filename, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  for (const name of platform === 'linux' ? requiredLinux : ['windows-agent.ps1']) {
    if (!names.has(name)) throw connectionError('INVALID_BUNDLE', 'Kurulum paketi eksik.', 500);
  }
  return files;
}

const dependencyScript = [
  'set -eu',
  'export PATH=' + linuxToolPath,
  'if command -v python3 >/dev/null && command -v ss >/dev/null && command -v git >/dev/null && command -v visudo >/dev/null && command -v useradd >/dev/null; then exit 0; fi',
  'if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=60 update -qq; apt-get -o DPkg::Lock::Timeout=60 install -y -qq python3 iproute2 git sudo passwd;',
  'elif command -v dnf >/dev/null; then dnf install -y python3 iproute git sudo shadow-utils;',
  'elif command -v yum >/dev/null; then yum install -y python3 iproute git sudo shadow-utils;',
  'elif command -v zypper >/dev/null; then zypper --non-interactive install python3 iproute2 git sudo shadow;',
  'elif command -v apk >/dev/null; then apk add python3 iproute2 git sudo shadow;',
  'elif command -v pacman >/dev/null; then pacman -S --noconfirm --needed python iproute2 git sudo shadow;',
  'else exit 69; fi',
  'command -v python3 >/dev/null; command -v ss >/dev/null; command -v git >/dev/null; command -v visudo >/dev/null; command -v useradd >/dev/null',
].join('\n');
// Tool presence is optional and says nothing about filesystem ACL/xattr support.
const aclToolProbe = '/bin/sh -c ' + shellQuote('export PATH=' + linuxToolPath + '; command -v getfacl >/dev/null 2>&1 && command -v setfacl >/dev/null 2>&1');

/** The embedded installer only consumes this bundled manifest, never UI script text. */
export function linuxInstaller({ stage, release, files, username, host }) {
  const config = Buffer.from(JSON.stringify({ stage, release, files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })), username, host })).toString('base64');
  return [
    'import base64, hashlib, json, os, pathlib, pwd, re, shutil, stat, subprocess',
    'os.environ["PATH"]=' + JSON.stringify(linuxToolPath),
    'c=json.loads(base64.b64decode("' + config + '"))',
    'if os.geteuid()!=0: raise RuntimeError("root required")',
    'if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_.-]*[$]?",c["username"]): raise RuntimeError("unsupported Linux username")',
    'base=pathlib.Path("/opt/viios-agent-releases"); link=pathlib.Path("/opt/viios-agent")',
    'def trusted_dir(p):',
    ' s=p.lstat()',
    ' if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022: raise RuntimeError("unsafe installation directory")',
    'for p in [pathlib.Path("/opt"),pathlib.Path("/etc/sudoers.d")]: trusted_dir(p)',
    'if not base.exists(): base.mkdir(mode=0o755)',
    'trusted_dir(base)',
    'if link.exists() or link.is_symlink():',
    ' if not link.is_symlink() or link.lstat().st_uid!=0 or base.resolve() not in link.resolve().parents or not (link/".viios-agent.json").is_file(): raise RuntimeError("existing installation conflict")',
    'target=base/("release-"+c["release"]); target.mkdir(mode=0o755)',
    'rootfd=os.open(c["stage"],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)',
    'try:',
    ' for entry in c["files"]:',
    '  parts=entry["name"].split("/")',
    '  if any(not re.fullmatch(r"[a-zA-Z0-9_.-]+",x) or x in (".","..") for x in parts): raise RuntimeError("unsafe manifest")',
    '  fd=os.dup(rootfd)',
    '  try:',
    '   for part in parts[:-1]:',
    '    nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nextfd',
    '   source=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)',
    '   with os.fdopen(source,"rb") as stream:',
    '    info=os.fstat(stream.fileno())',
    '    if not stat.S_ISREG(info.st_mode) or info.st_size!=entry["size"]: raise RuntimeError("invalid staged file")',
    '    content=stream.read(4194305)',
    '   if hashlib.sha256(content).hexdigest()!=entry["sha256"]: raise RuntimeError("file digest mismatch")',
    '   if entry["name"].endswith(".py"): compile(content,entry["name"],"exec")',
    '   dest=target/entry["name"]; dest.parent.mkdir(parents=True,exist_ok=True,mode=0o755)',
    '   with open(dest,"xb") as stream: stream.write(content)',
    '   os.chmod(dest,0o644)',
    '  finally: os.close(fd)',
    'finally: os.close(rootfd)',
    'try: account=pwd.getpwnam("viios-agent")',
    'except KeyError:',
    ' shell=shutil.which("nologin") or "/bin/false"',
    ' subprocess.run(["useradd","--system","--user-group","--no-create-home","--home-dir","/var/lib/viios-agent","--shell",shell,"viios-agent"],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)',
    ' account=pwd.getpwnam("viios-agent")',
    'if account.pw_uid==0 or not account.pw_shell.endswith(("nologin","false")): raise RuntimeError("existing account conflict")',
    'state=pathlib.Path("/var/lib/viios-agent")',
    'if not state.exists(): state.mkdir(mode=0o755)',
    'trusted_dir(state)',
    'versions=state/"versioning"',
    'if versions.is_symlink(): raise RuntimeError("unsafe versioning directory")',
    'versions.mkdir(mode=0o700,exist_ok=True); os.chown(versions,account.pw_uid,account.pw_gid); os.chmod(versions,0o700)',
    'catalog=target/"model-catalog-targets.json"',
    'if catalog.exists():',
    ' data=json.loads(catalog.read_text()); data["primaryHost"]=c["host"]; data["allowedHosts"]=["127.0.0.1","localhost",c["host"]]; catalog.write_text(json.dumps(data))',
    'helpers=["services.py","processes.py","scan.py 1 65535","resources.py","storage.py","files.py","control.py","versioning_access.py","model_catalog.py","model_concurrency.py"]',
    'sudoers=c["username"]+" ALL=(root) NOPASSWD: "+", ".join("/usr/bin/python3 -I /opt/viios-agent/"+h for h in helpers)+"\\n"',
    'sudoers+=c["username"]+" ALL=(viios-agent) NOPASSWD: /usr/bin/python3 -I /opt/viios-agent/versioning.py\\n"',
    'rules=pathlib.Path("/etc/sudoers.d")/("viios-agent-"+hashlib.sha256(c["username"].encode()).hexdigest()[:16])',
    'candidate=rules.parent/(".viios-"+c["release"])',
    'with open(candidate,"x") as stream: stream.write(sudoers)',
    'os.chmod(candidate,0o440)',
    'try:',
    ' subprocess.run(["visudo","-cf",str(candidate)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)',
    ' (target/".viios-agent.json").write_text(json.dumps({"version":1,"release":c["release"]}))',
    ' temp=pathlib.Path("/opt")/(".viios-link-"+c["release"]); temp.symlink_to(target)',
    ' os.replace(temp,link); os.replace(candidate,rules)',
    'finally:',
    ' if candidate.exists(): candidate.unlink()',
    'print(json.dumps({"installed":True,"release":c["release"]}))',
  ].join('\n');
}

export function windowsInstaller({ stage, file }) {
  const source = (stage + '/' + file.name).replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');
  return [
    '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"',
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity)',
    'if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Administrator SSH account required" }',
    '$base="C:\\ProgramData\\ViiOS"; $agent=Join-Path $base "agent"; $target=Join-Path $agent "windows-agent.ps1"; $marker=Join-Path $agent ".viios-agent.json"',
    'if ((Test-Path $target) -and !(Test-Path $marker)) { throw "Existing installation conflict" }',
    'foreach ($p in @($base,$agent)) { if ((Test-Path $p) -and ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe installation directory" } }',
    'New-Item -ItemType Directory -Force -Path $agent | Out-Null',
    '$admins=New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544"); $system=New-Object Security.Principal.SecurityIdentifier("S-1-5-18")',
    'foreach ($p in @($base,$agent)) { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($admins); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($admins,$system)) { $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule) }; [IO.Directory]::SetAccessControl($p,$acl) }',
    'foreach ($p in @(Get-ChildItem -LiteralPath $agent -Force)) { if ($p.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsafe existing agent entry" }; if (!$p.PSIsContainer) { $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetOwner($admins); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($admins,$system)) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow"))) }; [IO.File]::SetAccessControl($p.FullName,$acl) } }',
    '$source=' + psQuote(source),
    'if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne ' + psQuote(file.sha256) + ') { throw "File digest mismatch" }',
    '$temp=Join-Path $agent ("install-"+[Guid]::NewGuid().ToString("N")+".ps1"); Copy-Item -LiteralPath $source -Destination $temp',
    'if (Test-Path $target) { [IO.File]::Replace($temp,$target,(Join-Path $agent "windows-agent.previous.ps1")) } else { [IO.File]::Move($temp,$target) }',
    '[IO.File]::WriteAllText($marker,\'{"version":1}\')',
    '\'{"installed":true}\'',
  ].join('\n');
}

const sftpCall = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, result) => error ? reject(error) : resolve(result)));
async function cleanupStage(client, stage, files, io) {
  try {
    await io.withSftp(client, async sftp => {
      for (const file of files) { try { await sftpCall(sftp, 'unlink', stage + '/' + file.name); } catch { /* Already removed or upload incomplete. */ } }
      const directories = new Set();
      for (const file of files) {
        const parts = file.name.split('/').slice(0, -1);
        while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
      }
      for (const dir of [...directories].sort((a, b) => b.length - a.length)) { try { await sftpCall(sftp, 'rmdir', stage + '/' + dir); } catch { /* Never recursively remove unknown files. */ } }
      try { await sftpCall(sftp, 'rmdir', stage); } catch { /* Best-effort private staging cleanup. */ }
    });
  } catch { /* Disconnected sessions cannot remove their private staging directory. */ }
}
async function uploadBundle(client, files, platform, token, io) {
  let stage;
  try {
    await io.withSftp(client, async sftp => {
      const home = platform === 'windows' ? await sftpCall(sftp, 'realpath', '.') : '/tmp';
      stage = home.replace(/\/$/, '') + '/viios-bootstrap-' + token;
      await sftpCall(sftp, 'mkdir', stage, { mode: 0o700 });
      const made = new Set();
      for (const file of files) {
        const parts = file.name.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          const directory = parts.slice(0, i).join('/');
          if (!made.has(directory)) { await sftpCall(sftp, 'mkdir', stage + '/' + directory, { mode: 0o700 }); made.add(directory); }
        }
        await sftpCall(sftp, 'fastPut', file.filename, stage + '/' + file.name, { mode: 0o600 });
      }
    });
    return stage;
  } catch {
    if (stage) await cleanupStage(client, stage, files, io);
    throw connectionError('UPLOAD_FAILED', 'Kurulum dosyaları aktarılamadı. SFTP erişimini ve disk alanını kontrol edin.', 503);
  }
}

function parseResult(result) { try { return result.code === 0 ? JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) : null; } catch { return null; } }
export async function bootstrapConnection(profile, { sudoPassword, onProgress = async () => {}, signal, io: injected, projectRoot = projectDirectory } = {}) {
  const io = { openSshConnection, executeSsh, withSftp, ...injected };
  const files = await readAgentBundle(profile.platform, { projectRoot });
  let client, stage;
  const token = randomBytes(12).toString('hex');
  const check = () => { if (signal?.aborted) throw connectionError('CANCELLED', 'Kurulum iptal edildi.', 409); };
  const progress = async (phase, message) => { check(); await onProgress({ status: 'installing', phase, message }); };
  const abort = () => client?.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await progress('connecting', 'Onaylanan SSH anahtarıyla bağlantı kuruluyor.');
    client = await io.openSshConnection(profile);
    check();
    await progress('checking', 'İşletim sistemi ve kurulum yetkileri denetleniyor.');
    if (profile.platform === 'windows') {
      const detect = parseResult(await io.executeSsh(client, powershellCommand('$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); @{os=[Environment]::OSVersion.Platform.ToString();administrator=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress')));
      if (detect?.os !== 'Win32NT') throw connectionError('PLATFORM_MISMATCH', 'Bu SSH hedefinde Windows algılanamadı.', 400);
      if (!detect.administrator) throw connectionError('ADMIN_REQUIRED', 'Windows kurulumu için yönetici yetkili SSH hesabı gereklidir.', 403);
      await progress('uploading', 'Windows yönetim bileşeni aktarılıyor.');
      stage = await uploadBundle(client, files, 'windows', token, io);
      await progress('installing', 'Windows yönetim bileşeni güvenli dizine kuruluyor.');
      const installed = parseResult(await io.executeSsh(client, powershellCommand(windowsInstaller({ stage, file: files.find(file => file.name === 'windows-agent.ps1') }))));
      if (!installed?.installed) throw connectionError('INSTALL_FAILED', 'Windows bileşeni kurulamadı. Yönetici izinlerini ve mevcut kurulum dizinini kontrol edin.', 503);
      await progress('verifying', 'Windows yönetim özellikleri doğrulanıyor.');
      const response = parseResult(await io.executeSsh(client, 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\ViiOS\\agent\\windows-agent.ps1" -Helper capabilities'));
      if (!response?.available || !response.capabilities) throw connectionError('VERIFY_FAILED', 'Windows bileşeni kuruldu ancak doğrulama yanıtı alınamadı.', 503);
      const capabilities = { reasons: response.limitations || {} };
      for (const key of ['inventory', 'resources', 'processes', 'services', 'storage', 'files', 'control', 'versions', 'models', 'concurrency']) capabilities[key] = response.capabilities[key] === true;
      capabilities.uat = false;
      return capabilities;
    }
    const detected = await io.executeSsh(client, 'uname -s && id -u');
    const [os, uid] = detected.stdout.trim().split(/\r?\n/);
    if (detected.code !== 0 || os !== 'Linux' || !/^\d+$/.test(uid || '')) throw connectionError('PLATFORM_MISMATCH', 'Bu SSH hedefinde Linux algılanamadı.', 400);
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/.test(profile.username)) throw connectionError('INVALID_USERNAME', 'Linux için standart yerel kullanıcı adı gereklidir.', 400);
    let sudoMode = uid === '0' ? 'root' : 'nopass';
    let elevationPassword;
    if (sudoMode !== 'root' && (await io.executeSsh(client, 'sudo -n true')).code !== 0) {
      elevationPassword = sudoPassword || (profile.authType === 'password' ? profile.password : null);
      if (!elevationPassword || /[\r\n]/.test(elevationPassword)) throw connectionError('SUDO_REQUIRED', 'Kurulum için sudo şifresi veya şifresiz sudo yetkisi gereklidir.', 403);
      if ((await io.executeSsh(client, "sudo -k -S -p '' true", { input: elevationPassword + '\n' })).code !== 0) throw connectionError('SUDO_REQUIRED', 'Sudo yetkisi doğrulanamadı. Sudo şifresini ve kullanıcı yetkisini kontrol edin.', 403);
      sudoMode = 'password';
    }
    const privileged = command => sudoMode === 'root' ? command : (sudoMode === 'password' ? "sudo -k -S -p '' " : 'sudo -n ') + command;
    const input = sudoMode === 'password' ? elevationPassword + '\n' : '';
    await progress('dependencies', 'Gerekli Linux araçları hazırlanıyor.');
    if ((await io.executeSsh(client, privileged('/bin/sh -c ' + shellQuote(dependencyScript)), { input, timeoutMs: 600000, maxBytes: 4 * 1024 * 1024 })).code !== 0) throw connectionError('DEPENDENCIES_FAILED', 'Python 3, Git, iproute2, sudo ve kullanıcı yönetimi araçları hazırlanamadı. Paket yöneticisi erişimini kontrol edin.', 503);
    await progress('uploading', 'Linux yönetim bileşenleri aktarılıyor.');
    stage = await uploadBundle(client, files, 'linux', token, io);
    await progress('installing', 'Dosyalar doğrulanıyor ve sınırlı yönetim izinleri kuruluyor.');
    const installer = linuxInstaller({ stage, release: token, files, username: profile.username, host: profile.host });
    const installed = parseResult(await io.executeSsh(client, privileged('/usr/bin/python3 -I -c ' + shellQuote(installer)), { input }));
    elevationPassword = undefined;
    if (!installed?.installed) throw connectionError('INSTALL_FAILED', 'Linux bileşenleri kurulamadı. Mevcut ViiOS dizinlerini, Python sürümünü ve sudo izinlerini kontrol edin.', 503);
    await progress('verifying', 'Yönetim özelliklerinin çalışması doğrulanıyor.');
    let aclTools = false;
    try { aclTools = (await io.executeSsh(client, aclToolProbe)).code === 0; }
    catch { /* Optional CLI tools never block agent installation. */ }
    check();
    const capabilities = { aclTools, uat: false, reasons: { uat: 'UAT çalışma ortamı bu sürümde desteklenmiyor.' } };
    if (!aclTools) capabilities.reasons.aclTools = 'İsteğe bağlı ACL komut satırı araçları bulunamadı veya doğrulanamadı. Bu, dosya sisteminin ACL desteği hakkında bilgi vermez.';
    const checks = [
      ['inventory', 'scan.py 1 65535', '', data => Array.isArray(data?.apps)],
      ['services', 'services.py', '{"action":"list"}', data => data?.available === true && Array.isArray(data.services)],
      ['resources', 'resources.py', '', data => data?.available === true],
      ['processes', 'processes.py', '{"action":"list"}', data => data?.available === true && Array.isArray(data.processes)],
      ['storage', 'storage.py', '{"action":"overview"}', data => data?.available === true],
      ['files', 'files.py', '{"action":"capabilities"}', data => data?.available === true],
      ['control', 'control.py', '{"action":"status"}', data => data?.ok === true],
      ['versions', 'versioning.py', '{"action":"capabilities"}', data => data?.available === true],
      ['models', 'model_catalog.py', '', data => Array.isArray(data?.models)],
      ['concurrency', 'model_concurrency.py', '', data => Array.isArray(data?.services)],
    ];
    for (const [key, helper, payload, accepts] of checks) {
      check();
      const prefix = helper === 'versioning.py' ? 'sudo -n -u viios-agent ' : uid === '0' ? '' : 'sudo -n ';
      try { capabilities[key] = accepts(parseResult(await io.executeSsh(client, prefix + '/usr/bin/python3 -I /opt/viios-agent/' + helper, { input: payload, timeoutMs: key === 'inventory' || key === 'models' ? 120000 : 45000 }))); }
      catch { capabilities[key] = false; }
      if (!capabilities[key]) capabilities.reasons[key] = 'Bileşen kuruldu ancak özellik doğrulanamadı.';
    }
    if (!capabilities.resources && !capabilities.storage && !capabilities.files) throw connectionError('VERIFY_FAILED', 'Kurulum tamamlandı ancak temel yönetim özellikleri doğrulanamadı.', 503);
    return capabilities;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (client && stage && !signal?.aborted) await cleanupStage(client, stage, files, io);
    client?.end();
  }
}
