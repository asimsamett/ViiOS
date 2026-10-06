import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockedDirectories = new Set(['data', 'outputs', 'logs', 'work', 'node_modules', '.git', '.next', '.vinext', 'dist', 'coverage', '__pycache__', '.browsers', '.codex', '.claude', '.cursor']);
const blockedNames = new Set(['admin.json', 'servers.json', 'inventory.json', 'credentials.json', 'setup.token', 'master.key', 'id_rsa', 'id_ed25519']);
const blockedExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.ppk', '.log', '.sqlite', '.sqlite3', '.db', '.bak', '.zip', '.pyc']);

export function normalizeDemoBasePath(value = '') {
  if (value === '' || value === '/') return '';
  if (!/^\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/.test(value)) throw new Error('VIIOS_DEMO_BASE_PATH must be empty or a URL path such as /viios.');
  return value.replace(/\/$/, '');
}

export function copyPublicSources(root, destination) {
  const manifestPath = path.join(root, 'public-source-files.json');
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('Source manifest must be a regular file.');
  const files = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(files) || files.length !== new Set(files).size || !files.includes('package.json') || !files.includes('public-source-files.json')) throw new Error('Invalid public source manifest.');
  for (const name of files) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/')) throw new Error('Invalid public source path.');
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || blockedDirectories.has(part.toLowerCase()) || part.toLowerCase().startsWith('.aider'))) throw new Error(`Excluded source path: ${name}`);
    if (blockedNames.has(parts.at(-1).toLowerCase()) || blockedExtensions.has(path.extname(name).toLowerCase()) || (parts.some(part => part.toLowerCase().startsWith('.env')) && name !== '.env.example')) throw new Error(`Private artifact in source list: ${name}`);
    let source = root;
    for (const part of parts) {
      source = path.join(source, part);
      if (lstatSync(source).isSymbolicLink()) throw new Error(`Linked source path: ${name}`);
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(source) !== path.resolve(source)) throw new Error(`Source must be an ordinary file: ${name}`);
    const target = path.join(destination, ...parts);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return files.length;
}

function copyStaticFiles(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Static output must not contain links.');
    if (entry.isDirectory()) copyStaticFiles(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error('Unsupported static output entry.');
  }
}

export function buildDemo(root = projectRoot, baseValue = process.env.VIIOS_DEMO_BASE_PATH || '') {
  const basePath = normalizeDemoBasePath(baseValue);
  const stagingRoot = path.join(root, 'outputs', 'demo-build');
  mkdirSync(stagingRoot, { recursive: true });
  const stage = mkdtempSync(path.join(stagingRoot, 'build-'));
  const project = path.join(stage, 'project');
  mkdirSync(project);
  const count = copyPublicSources(root, project);
  const dependencies = path.join(root, 'node_modules');
  const node = path.join(dependencies, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const cli = path.join(dependencies, 'vinext', 'dist', 'cli.js');
  if (!existsSync(node) || !existsSync(cli)) throw new Error('Run npm ci before building the demo.');
  symlinkSync(dependencies, path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Inherit operating-system essentials only: local application secrets and NEXT_PUBLIC_* values never enter the demo build.
  const essentials = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'appdata', 'localappdata', 'lang', 'lc_all', 'term', 'ci', 'number_of_processors']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => essentials.has(key.toLowerCase())));
  env.NODE_ENV = 'production';
  env.NEXT_PUBLIC_VIIOS_DEMO = 'true';
  env.NEXT_PUBLIC_VIIOS_BASE_PATH = basePath;
  env.VIIOS_DEMO_BASE_PATH = basePath;
  console.log(`Building demo from ${count} reviewed source files at ${basePath || '/'}.`);
  const result = spawnSync(node, [cli, 'build'], { cwd: project, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Demo build failed (exit ${result.status ?? 'unknown'}).`);
  const client = path.join(project, 'dist', 'client');
  // vinext exports basePath as an actual directory. GitHub Pages mounts the artifact at that URL already.
  const exportedSite = path.join(client, basePath.replace(/^\//, ''));
  if (!existsSync(path.join(exportedSite, 'index.html'))) throw new Error('Missing static index.html. Demo export must set trailingSlash: true.');
  if (!existsSync(path.join(exportedSite, 'index.txt'))) throw new Error('Missing static React payload.');
  const directory = path.join(root, 'outputs', 'demo-site', path.basename(stage));
  copyStaticFiles(exportedSite, directory);
  if (basePath && existsSync(path.join(client, '404.html'))) copyFileSync(path.join(client, '404.html'), path.join(directory, '404.html'));
  writeFileSync(path.join(directory, '.nojekyll'), '');
  const metadata = { directory: path.relative(root, directory).split(path.sep).join('/'), basePath };
  writeFileSync(path.join(root, 'outputs', 'demo-site-latest.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `site_directory=${metadata.directory}\n`);
  console.log(`Static demo: ${directory}\nPreview: npm run demo:serve`);
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildDemo(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
