"""Small, unprivileged Git project broker. No network commands or shell execution."""
import contextlib
import importlib.util
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

APP = Path(__file__).resolve().parent
CONFIG = APP / 'versioning.json'
STORE = Path('/var/lib/viios-agent/versioning')
MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 100000
_spec = importlib.util.spec_from_file_location('versioning_policy', Path(__file__).with_name('versioning_policy.py'))
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)
IGNORE = ['.env', '.env.*', '!.env.example', '!.env.sample', '*.pem', '*.key',
          'node_modules/', '.next/', 'dist/', 'build/', '.venv/', 'venv/',
          '__pycache__/', '*.log', '.DS_Store']


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def config():
    value = json.loads(CONFIG.read_text())
    if not value.get('enabled'):
        raise Problem('Sürüm yönetimi kapalı.', 403)
    return value


def project_path(value):
    try:
        return policy.checked_path(value, config())
    except ValueError as error:
        raise Problem(str(error), 403)


def environment():
    return {'PATH': '/usr/bin:/bin', 'HOME': str(STORE / 'empty-home'),
            'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
            'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}


def git(path, *args, allowed=(0,)):
    command = ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
               '-c', 'safe.directory=' + str(path),
               '-c', 'core.excludesFile=' + str(APP / 'versioning-ignore'),
               '-c', 'commit.gpgSign=false', '-c', 'core.pager=cat', '-c', 'gc.auto=0',
               '-c', 'core.quotePath=false', '-C', str(path), *args]
    # File-backed output avoids allocating an unbounded diff in memory.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err, tempfile.TemporaryDirectory(prefix='management-git-ignore-') as folder:
        # Ubuntu's patched Git 2.34 accepts safe.directory only in global/system
        # configuration. Use a private per-command file, never the user's config.
        trust = Path(folder) / 'trusted-config'
        quoted = str(path).replace('\\', '\\\\').replace('"', '\\"')
        trust.write_text('[safe]\n\tdirectory = "' + quoted + '"\n')
        env = {**environment(), 'GIT_CONFIG_GLOBAL': str(trust)}
        extra = policy.project_excludes(path, config())
        if extra:
            ignore_file = Path(folder) / 'exclude'
            ignore_file.write_text((APP / 'versioning-ignore').read_text() + '\n' + '\n'.join(extra) + '\n')
            command[command.index('core.excludesFile=' + str(APP / 'versioning-ignore'))] = 'core.excludesFile=' + str(ignore_file)
        try:
            result = subprocess.run(command, env=env, stdin=subprocess.DEVNULL,
                                    stdout=out, stderr=err, timeout=120)
        except subprocess.TimeoutExpired:
            raise Problem('Git işlemi zaman aşımına uğradı. Yenileyerek sonucu kontrol edin.', 503)
        if result.returncode not in allowed:
            raise Problem('Git işlemi tamamlanamadı (' + args[0] + '). Dosya izinlerini ve depo durumunu kontrol edin.', 409)
        if out.tell() > 4 * 1024 * 1024:
            raise Problem('Git çıktısı görüntüleme sınırını aşıyor.', 413)
        out.seek(0)
        return out.read(), result.returncode


def text(path, *args, allowed=(0,)):
    return git(path, *args, allowed=allowed)[0].decode('utf-8', 'replace').strip()


def metadata_files(path):
    root = path / '.git'
    if not root.exists():
        return []
    result = []
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            item = Path(folder) / name
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or (stat.S_ISREG(info.st_mode) and info.st_nlink > 1):
                raise Problem('Git metadata alanında bağlantı veya özel dosya bulunamaz.', 403)
            if stat.S_ISREG(info.st_mode):
                result.append(item)
            if len(result) > MAX_FILES:
                raise Problem('Git geçmişi dosya sınırını aşıyor.', 413)
    return result


def source_files(path):
    if (path / '.git').exists():
        raw = git(path, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')[0]
    else:
        STORE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix='inspect-', dir=STORE) as folder:
            git(Path(folder), 'init', '--bare', '--template=')
            raw = git(path, '--git-dir=' + folder, '--work-tree=' + str(path), 'ls-files', '--others', '--exclude-standard', '-z')[0]
    names = sorted(set(raw.decode('utf-8', 'surrogateescape').split('\0')) - {''})
    if len(names) > MAX_FILES:
        raise Problem('Kaynak dosya sınırı 100.000. Bağımlılık ve çıktı klasörlerini .gitignore ile dışlayın.', 413)
    result = []
    for name in names:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
            raise Problem('Geçersiz Git dosya yolu.', 403)
        item = path / name
        for parent in [item, *item.parents]:
            if parent == path:
                break
            if parent.is_symlink():
                raise Problem('Sürüm kapsamındaki dosyalarda sembolik bağlantı bulunamaz.', 403)
        if item.exists():
            info = item.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                raise Problem('Sürüm kapsamındaki öğe normal dosya değil veya hardlink içeriyor.', 403)
            result.append(item)
    return result


def inventory(path):
    digest = hashlib.sha256()
    total = 0
    sources = source_files(path)
    for item in sources + metadata_files(path):
        info = item.stat()
        total += info.st_size
        if total > MAX_BYTES:
            raise Problem('Sürüm kapsamı ve Git geçmişi toplam 2 GB sınırını aşıyor. Büyük veri/çıktı dosyalarını .gitignore ile ayırın.', 413)
        relative = str(item.relative_to(path))
        digest.update(relative.encode('utf-8', 'surrogateescape'))
        digest.update(str((info.st_mode, info.st_size)).encode())
        if relative.startswith('.git/objects/'):
            digest.update(str((info.st_mtime_ns, info.st_ino)).encode())
        else:
            with item.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
    return digest.hexdigest()


def repository(selected):
    try:
        path, exists = policy.find_root(selected, config())
    except ValueError as error:
        raise Problem(str(error), 409)
    if exists:
        metadata_files(path)
        check_config(path)
        if Path(text(path, 'rev-parse', '--show-toplevel')) != path:
            raise Problem('Git deposu kökü seçilen klasörle uyuşmuyor.', 403)
    inventory(path)
    return path, exists


def check_config(path):
    raw = (path / '.git/config').read_text()
    # Includes can import commands or redirect objects before a -c override applies.
    if re.search(r'^\s*\[\s*(include|includeIf|filter|extensions|diff)\b', raw, re.I | re.M):
        raise Problem('Bu depo özel Git yapılandırması kullanıyor; bu panelde desteklenmiyor.', 409)
    output = text(path, 'config', '--local', '--no-includes', '--list')
    permitted_core = {'repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'autocrlf', 'eol', 'symlinks', 'quotepath'}
    for line in output.splitlines():
        key, _, value = line.partition('=')
        key = key.lower()
        if key.startswith('core.') and key[5:] not in permitted_core:
            raise Problem('Bu depo özel core ayarları kullanıyor; bu panelde desteklenmiyor.', 409)
        if key == 'core.bare' and value.lower() == 'true':
            raise Problem('Çalışma klasörü olmayan depolar desteklenmiyor.', 409)
        if key.startswith(('filter.', 'include.', 'includeif.', 'extensions.')):
            raise Problem('Depo ayarı bu panelde desteklenmiyor.', 409)
    for item in ['objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'shallow', 'info/grafts', 'info/sparse-checkout']:
        if (path / '.git' / item).exists():
            raise Problem('Paylaşılan, sığ veya seyrek Git depoları bu panelde desteklenmiyor.', 409)


def blocked_name(name):
    parts = Path(name).parts
    leaf = parts[-1] if parts else ''
    return (any(p in ('node_modules', '.ssh', '.gnupg', '.git') for p in parts)
            or (leaf.startswith('.env') and leaf not in ('.env.example', '.env.sample'))
            or leaf.endswith(('.pem', '.key')))


def registry():
    file = STORE / 'projects.json'
    return json.loads(file.read_text()) if file.exists() else []


def save_registry(values):
    file = STORE / 'projects.json'
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(values, ensure_ascii=False, indent=2))
    os.replace(temp, file)


def get_project(ident):
    if not isinstance(ident, str) or not re.fullmatch('[a-f0-9]{32}', ident):
        raise Problem('Geçersiz proje kimliği.')
    item = next((p for p in registry() if p['id'] == ident), None)
    if not item:
        raise Problem('Proje kaydı bulunamadı.', 404)
    path, exists = repository(project_path(item['path']))
    if not exists or str(path) != item['path']:
        raise Problem('Kayıtlı depo taşınmış veya değiştirilmiş.', 409)
    return item, path


def changes(path):
    raw = git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')[0]
    return [{'status': record[:2].decode(), 'path': record[3:].decode('utf-8', 'replace')}
            for record in raw.split(b'\0') if record]


def state(path):
    check_config(path)
    head = text(path, 'rev-parse', '--verify', 'HEAD', allowed=(0, 128))
    branch = text(path, 'symbolic-ref', '--short', '-q', 'HEAD', allowed=(0, 1))
    changed = changes(path)
    tracked = git(path, 'ls-files', '-z')[0].decode('utf-8', 'replace').split('\0')
    problems = []
    if not branch:
        problems.append('Bir dal seçili değil; bu depoda kayıt alınamaz.')
    if any((path / '.git' / name).exists() for name in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'index.lock']):
        problems.append('Devam eden Git işlemi veya kilidi var.')
    if any(blocked_name(p) for p in tracked if p) or any(blocked_name(c['path']) for c in changed):
        problems.append('Hassas veya bağımlılık dosyası kayıt kapsamına giriyor. Kayıttan önce dışlama kurallarını düzenleyin.')
    modes = text(path, 'ls-files', '--stage')
    if any(line.startswith(('120000 ', '160000 ')) for line in modes.splitlines()):
        problems.append('Sembolik bağlantı ve alt modüller bu panelde desteklenmiyor.')
    entries = []
    if head:
        raw = git(path, 'log', '-50', '--format=%H%x00%h%x00%aI%x00%s%x00%d%x00')[0].decode('utf-8', 'replace')
        fields = raw.split('\0')
        for index in range(0, len(fields) - 5, 5):
            sha, short, date, message, refs = fields[index:index + 5]
            entries.append({'id': sha.strip(), 'short': short, 'date': date, 'message': message, 'refs': refs.strip()})
    return {'path': str(path), 'name': path.name, 'head': head or None, 'branch': branch or 'Dalsız',
            'changes': changed, 'history': entries, 'blocked': ' '.join(problems),
            'trackedCount': len([name for name in tracked if name]),
            'revision': inventory(path), 'remoteNames': text(path, 'remote').splitlines(),
            'ignoredCount': len([p for p in git(path, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')[0].split(b'\0') if p])}


def backup(path, action):
    ident = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
    folder = STORE / 'backups' / ident
    folder.mkdir(parents=True, mode=0o700)
    inventory(path)
    sources = source_files(path)
    size = sum(item.stat().st_size for item in sources + metadata_files(path))
    if shutil.disk_usage(STORE).free < size + 512 * 1024 * 1024:
        raise Problem('Yedek için yeterli disk alanı yok; proje değiştirilmedi.', 507)
    with tarfile.open(folder / 'project.tar.gz', 'w:gz') as archive:
        archive.add(path, arcname=path.name, recursive=False)
        if (path / '.git').exists():
            archive.add(path / '.git', arcname=path.name + '/.git')
        for item in sources:
            archive.add(item, arcname=str(Path(path.name) / item.relative_to(path)), recursive=False)
    (folder / 'receipt.json').write_text(json.dumps({'path': str(path), 'action': action, 'at': time.time(), 'scope': 'Git metadata and tracked/eligible source files; ignored runtime files stay in place.'}, indent=2))
    return ident


def audit(action, path, **extra):
    with (STORE / 'events.jsonl').open('a') as file:
        file.write(json.dumps({'at': time.time(), 'action': action, 'path': str(path), **extra}) + '\n')


def message(value):
    if value is None or value == '':
        return 'Sürüm kaydı · ' + time.strftime('%Y-%m-%d %H:%M:%S')
    if not isinstance(value, str) or len(value) > 300 or '\0' in value:
        raise Problem('Açıklama en fazla 300 karakter olabilir.')
    return value.strip() or 'Sürüm kaydı'


def commit(path, description):
    git(path, 'add', '--all', '--', '.')
    if text(path, 'diff', '--cached', '--name-only'):
        git(path, '-c', 'user.name=All Management', '-c', 'user.email=all-management@localhost',
            'commit', '--no-gpg-sign', '-m', description)
    return text(path, 'rev-parse', '--verify', 'HEAD', allowed=(0, 128))


def verify_revision(path, expected):
    current = state(path)
    if not isinstance(expected, str) or expected != current['revision']:
        raise Problem('Dosyalar veya Git geçmişi değişti. Yenileyip tekrar deneyin.', 409)
    if current['blocked']:
        raise Problem(current['blocked'], 409)
    return current


def target_commit(path, sha):
    if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha):
        raise Problem('Geçersiz sürüm kimliği.')
    if git(path, 'merge-base', '--is-ancestor', sha, 'HEAD', allowed=(0, 1, 128))[1] != 0:
        raise Problem('Bu sürüm mevcut dalın geçmişinde bulunamadı.', 409)
    tree = git(path, 'ls-tree', '-r', '-z', sha)[0].decode('utf-8', 'replace')
    for record in tree.split('\0'):
        if not record:
            continue
        meta, name = record.split('\t', 1)
        if blocked_name(name) or not meta.startswith(('100644 ', '100755 ')):
            raise Problem('Bu sürüm geri getirilemeyen dosyalar içeriyor.', 409)
    return sha


def timeline(path, offset):
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > 1000000:
        raise Problem('Geçersiz sürüm sayfası.')
    branch = text(path, 'symbolic-ref', '--short', '-q', 'HEAD', allowed=(0, 1))
    if not branch:
        raise Problem('Bu depoda seçili dal bulunmuyor.', 409)
    total = int(text(path, 'rev-list', '--count', 'HEAD', allowed=(0, 128)) or 0)
    raw = git(path, 'log', '--skip=' + str(offset), '-50',
              '--format=%H%x00%h%x00%aI%x00%an%x00%s%x00%d%x00')[0].decode('utf-8', 'replace') if total else ''
    fields = raw.split('\0')
    history = []
    for index in range(0, len(fields) - 6, 6):
        sha, short, date, author, description, refs = fields[index:index + 6]
        if not re.fullmatch('[a-f0-9]{40}', sha.strip()):
            continue
        history.append({'id': sha.strip(), 'short': short, 'date': date, 'author': author,
                        'message': description, 'refs': refs.strip(), 'number': total - offset - len(history)})
    return {'branch': branch, 'total': total, 'offset': offset, 'history': history,
            'hasMore': offset + len(history) < total}


def commit_files(path, sha):
    target_commit(path, sha)
    raw = git(path, 'diff-tree', '--root', '-m', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', sha)[0]
    values = [item.decode('utf-8', 'replace') for item in raw.split(b'\0') if item]
    result = []
    seen = set()
    for index in range(0, len(values) - 1, 2):
        status, name = values[index:index + 2]
        if name not in seen:
            result.append({'status': status, 'path': name})
            seen.add(name)
    if any(blocked_name(item['path']) for item in result):
        raise Problem('Bu kaydın dosya listesi hassas adlar içeriyor; gösterilmedi.', 403)
    return result


def graph(path):
    total = int(text(path, 'rev-list', '--all', '--count') or 0)
    if not total:
        return {'rows': [], 'total': 0, 'truncated': False}
    raw = git(path, 'log', '--all', '--graph', '--topo-order', '--date-order',
              '--max-count=120', '--format=%x1e%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%D%x1f%P')[0]
    rows = []
    # splitlines() treats the record separator (\x1e) as a line ending.
    for line in raw.decode('utf-8', 'replace').split('\n'):
        if '\x1e' not in line:
            if line.strip():
                rows.append({'graph': line[:80]})
            continue
        prefix, _, detail = line.partition('\x1e')
        fields = detail.split('\x1f')
        if len(fields) != 7 or not re.fullmatch('[a-f0-9]{40}', fields[0]):
            continue
        sha, short, date, author, subject, decorations, parents = fields
        rows.append({'graph': prefix[:80], 'commit': {
            'id': sha, 'short': short, 'date': date, 'author': author[:120],
            'message': subject[:300], 'refs': [ref.strip() for ref in decorations.split(',') if ref.strip()],
            'parents': parents.split()}})
    return {'rows': rows, 'total': total, 'truncated': total > 120}


def graph_commit(path, sha):
    if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha):
        raise Problem('Geçersiz sürüm kimliği.')
    if not any(row.get('commit', {}).get('id') == sha for row in graph(path)['rows']):
        raise Problem('Bu sürüm Git ağacında bulunamadı. Ağacı yenileyin.', 404)
    return sha


def tree_files(path, sha):
    graph_commit(path, sha)
    raw = git(path, 'ls-tree', '-r', '-z', sha)[0]
    files = []
    total = 0
    for record in raw.split(b'\0'):
        if not record:
            continue
        meta, _, name = record.partition(b'\t')
        if not meta.startswith((b'100644 ', b'100755 ')):
            continue
        decoded = name.decode('utf-8', 'replace')
        if blocked_name(decoded):
            continue
        total += 1
        if len(files) < 3000:
            files.append(decoded)
    return {'files': files, 'total': total, 'truncated': total > len(files)}


def tree_file(path, sha, name):
    if not isinstance(name, str) or not name or len(name) > 4096 or name.startswith('/') or '\0' in name or any(p in ('.', '..') for p in name.split('/')) or blocked_name(name):
        raise Problem('Geçersiz dosya yolu.')
    if name not in tree_files(path, sha)['files']:
        raise Problem('Dosya bu sürüm ağacında bulunamadı.', 404)
    size = int(text(path, 'cat-file', '-s', sha + ':' + name))
    if size > 200000:
        return {'text': '', 'truncated': True, 'note': 'Dosya 200 KB önizleme sınırını aşıyor.'}
    raw = git(path, 'show', sha + ':' + name)[0]
    if b'\0' in raw:
        return {'text': '', 'truncated': False, 'note': 'İkili dosya önizlenemiyor.'}
    return {'text': raw.decode('utf-8', 'replace'), 'truncated': False, 'note': ''}


def dispatch(request):
    action = request.get('action')
    settings = config()
    if action == 'capabilities':
        return {'available': True, 'pilot': False, 'root': settings.get('roots', [settings['pilotRoot']])[0], 'demoRoot': settings['pilotRoot'],
                'roots': settings.get('roots', [settings['pilotRoot']]), 'projectRoots': settings.get('projectRoots', []),
                'gitVersion': text(Path(settings['pilotRoot']), '--version'),
                'automatic': False, 'ignore': (APP / 'versioning-ignore').read_text().splitlines(),
                'maxBytes': MAX_BYTES, 'maxFiles': MAX_FILES}
    if action == 'list':
        return {'projects': registry()}
    if action in ('inspect', 'register'):
        selected = project_path(request.get('path'))
        path, exists = repository(selected)
        revision = inventory(path)
        if action == 'inspect':
            return {'path': str(path), 'selectedPath': str(selected), 'name': path.name,
                    'exists': exists, 'revision': revision, 'ignore': (APP / 'versioning-ignore').read_text().splitlines() + policy.project_excludes(path, settings),
                    'registered': next((p['id'] for p in registry() if p['path'] == str(path)), None),
                    **({'branch': state(path)['branch']} if exists else {})}
        if request.get('revision') != revision:
            raise Problem('Klasör değişti. Yeniden inceleyin.', 409)
        values = registry()
        existing = next((p for p in values if p['path'] == str(path)), None)
        if existing:
            return {'project': existing, 'state': state(path)}
        receipt = None
        if not exists:
            receipt = backup(path, 'initialize')
            git(path, 'init', '--initial-branch=main', '--template=')
            (path / '.git/info').mkdir(exist_ok=True)
            with (path / '.git/info/exclude').open('a') as file:
                file.write('\n# All Management\n' + (APP / 'versioning-ignore').read_text() + '\n' + '\n'.join(policy.project_excludes(path, settings)) + '\n')
            current = state(path)
            if current['blocked']:
                raise Problem(current['blocked'], 409)
            commit(path, 'İlk sürüm · All Management')
            if not text(path, 'rev-parse', '--verify', 'HEAD', allowed=(0, 128)):
                git(path, '-c', 'user.name=All Management', '-c', 'user.email=all-management@localhost',
                    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'İlk sürüm · All Management')
        item = {'id': uuid.uuid4().hex, 'path': str(path), 'name': path.name, 'addedAt': time.time(), 'existing': exists}
        values.append(item)
        save_registry(values)
        audit('register', path, backup=receipt)
        return {'project': item, 'state': state(path), 'backup': receipt}
    item, path = get_project(request.get('id'))
    if action == 'status':
        return {'project': item, 'state': state(path)}
    if action == 'timeline':
        return timeline(path, request.get('offset'))
    if action == 'graph':
        return graph(path)
    if action == 'treeFiles':
        return tree_files(path, request.get('commit'))
    if action == 'treeFile':
        return tree_file(path, request.get('commit'), request.get('file'))
    if action == 'commitFiles':
        return {'files': commit_files(path, request.get('commit'))}
    if action == 'fileDiff':
        sha = request.get('commit')
        name = request.get('file')
        if not isinstance(name, str) or not name or len(name) > 4096 or name.startswith('/') or '\0' in name or any(p in ('.', '..') for p in name.split('/')):
            raise Problem('Geçersiz dosya yolu.')
        if name not in {item['path'] for item in commit_files(path, sha)}:
            raise Problem('Dosya bu sürümde değişmemiş.', 404)
        out = git(path, 'diff-tree', '--root', '-m', '--no-commit-id', '-p', '--no-ext-diff', '--no-textconv', '--no-renames', sha, '--', name)[0]
        limit = 120000
        return {'text': out[:limit].decode('utf-8', 'replace'), 'truncated': len(out) > limit,
                'note': 'İkili dosyalar için metin farkı gösterilemez.'}
    if action == 'workingFileDiff':
        name = request.get('file')
        if not isinstance(name, str) or not name or len(name) > 4096 or name.startswith('/') or '\0' in name or any(p in ('.', '..') for p in name.split('/')):
            raise Problem('Geçersiz dosya yolu.')
        current = state(path)
        if current['blocked']:
            raise Problem(current['blocked'], 409)
        selected = next((item for item in current['changes'] if item['path'] == name), None)
        if selected is None:
            raise Problem('Dosya çalışma alanında değişmemiş.', 404)
        if selected['status'] == '??':
            return {'text': '', 'truncated': False, 'note': 'Yeni dosya henüz Git tarafından izlenmiyor. İçerik sürüm kaydına kadar fark olarak gösterilmez.'}
        out = git(path, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', name)[0] if current['head'] else b''
        limit = 120000
        return {'text': out[:limit].decode('utf-8', 'replace'), 'truncated': len(out) > limit,
                'note': 'İkili dosyalar için metin farkı gösterilemez.'}
    if action == 'diff':
        current = state(path)
        if current['blocked']:
            raise Problem(current['blocked'], 409)
        if request.get('commit'):
            sha = target_commit(path, request['commit'])
            changed_names = git(path, 'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha)[0].decode('utf-8', 'replace').split('\0')
            if any(blocked_name(name) for name in changed_names if name):
                raise Problem('Bu kaydın farkı hassas dosya adları içeriyor; içerik gösterilmedi.', 403)
            out = git(path, 'show', '--format=short', '--no-ext-diff', '--no-textconv', '--no-renames', sha, '--', '.')[0]
        elif current['head']:
            out = git(path, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', '.')[0]
        else:
            out = b''
        limit = 120000
        return {'text': out[:limit].decode('utf-8', 'replace'), 'truncated': len(out) > limit,
                'note': 'Yeni, henüz izlenmeyen dosyalar değişiklik listesinde gösterilir.'}
    if action not in ('commit', 'restore'):
        raise Problem('Geçersiz sürüm işlemi.')
    current = verify_revision(path, request.get('revision'))
    description = message(request.get('message')) if action == 'commit' else None
    sha = target_commit(path, request.get('commit')) if action == 'restore' else None
    if sha:
        # Runtime paths can be excluded symlinks. Never restore a historical
        # tracked file through (or over) a link that is now outside Git's scope.
        for name in git(path, 'ls-tree', '-r', '--name-only', '-z', sha)[0].split(b'\0'):
            if not name:
                continue
            destination = path / os.fsdecode(name)
            for parent in [destination, *destination.parents]:
                if parent == path:
                    break
                if parent.is_symlink():
                    raise Problem('Eski sürüm dışlanan bir sembolik bağlantıyla çakışıyor; çalışma dosyaları korundu.', 409)
    if action == 'commit' and not current['changes']:
        return {'project': item, 'state': current, 'unchanged': True}
    receipt = backup(path, action)
    # Confirm the view again after the backup, before any Git write.
    verify_revision(path, request.get('revision'))
    checkpoint = None
    try:
        if action == 'commit':
            commit(path, description)
        else:
            # Dirty tracked/untracked files become a reachable checkpoint commit.
            if current['changes']:
                checkpoint = commit(path, 'Geri getirme öncesi çalışma kaydı')
            current_names = set(git(path, 'ls-files', '-z')[0].split(b'\0'))
            for name in git(path, 'ls-tree', '-r', '--name-only', '-z', sha)[0].split(b'\0'):
                if name and name not in current_names and (path / os.fsdecode(name)).exists():
                    raise Problem('Dışlanan bir çalışma dosyası eski sürümle çakışıyor; dosya korunuyor.', 409)
            git(path, 'restore', '--source=' + sha, '--staged', '--worktree', '--', '.')
            commit(path, 'Sürüm geri getirildi · ' + sha[:8])
        audit(action, path, backup=receipt, checkpoint=checkpoint)
    except Exception:
        audit(action + '_failed', path, backup=receipt, checkpoint=checkpoint)
        raise Problem('İşlem tamamlanamadı. Yenileyin; işlem öncesi kaynak ve Git yedeği korundu: ' + receipt, 409)
    return {'project': item, 'state': state(path), 'backup': receipt, 'checkpoint': checkpoint}


@contextlib.contextmanager
def lock():
    STORE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STORE / 'operation.lock').open('a') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Problem('Başka bir sürüm işlemi sürüyor. Biraz sonra yenileyin.', 409)
        yield


def main():
    os.umask(0o077)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Problem('Sürüm işlemi zaman aşımına uğradı.', 503)))
    signal.alarm(590)
    try:
        if os.geteuid() == 0:
            raise Problem('Git servisi root olarak çalıştırılamaz.', 403)
        request = json.loads(sys.stdin.buffer.read(16385))
        with lock():
            result = dispatch(request)
    except Problem as error:
        result = {'error': str(error), 'status': error.status}
    except Exception:
        result = {'error': 'Sürüm işlemi tamamlanamadı. Klasör izinlerini ve yapılandırmayı kontrol edin.', 'status': 500}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
