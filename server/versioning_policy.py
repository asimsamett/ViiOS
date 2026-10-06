"""Path policy shared by the unprivileged Git worker and the ACL broker."""
import fnmatch
from pathlib import Path

PROTECTED = ['/opt/viios-agent', '/opt/viios-agent-releases', '/var/lib/viios-agent', '/opt/containerd']
SKIP_DIRS = {'.ssh', '.gnupg', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__',
             '.cache', '.pytest_cache', '.mypy_cache', '.browsers', '.runtime',
             'vendor_wheels', 'wheels', 'embedding_model', '.codex_backups', '.codex_staging',
             '.codex_deploy', '.codex_uat', 'logs', 'logs_all', 'history_all'}
SKIP_FILES = ['.env', '.env.*', '*.pem', '*.key', '*.log', '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*', '.DS_Store']


def project_excludes(path, settings):
    return settings.get('projectExcludes', {}).get(str(path), [])


def excluded(relative, directory=False, extra=()):
    parts = Path(relative).parts
    for index in range(1, len(parts) + 1):
        prefix = '/'.join(parts[:index])
        if any(fnmatch.fnmatchcase(prefix, pattern.rstrip('/')) for pattern in extra):
            return True
    if any(part in SKIP_DIRS or part.startswith('.management-') for part in parts):
        return True
    return bool(parts) and not directory and parts[-1] not in ('.env.example', '.env.sample') and any(fnmatch.fnmatch(parts[-1], pattern) for pattern in SKIP_FILES)


def permitted(path, settings):
    roots = [Path(p) for p in settings.get('roots', [settings.get('pilotRoot', '/nonexistent')])]
    explicit = [Path(p) for p in settings.get('projectRoots', [])]
    return (any(root in path.parents for root in roots) or any(path == p or p in path.parents for p in explicit)) and not any(
        path == Path(p) or Path(p) in path.parents or path in Path(p).parents for p in PROTECTED)


def checked_path(value, settings):
    if not isinstance(value, str) or not value.startswith('/') or any(ord(c) < 32 for c in value) or len(value) > 4096 or any(p in ('.', '..') for p in value.split('/')):
        raise ValueError('Geçersiz proje klasörü.')
    path = Path(value)
    if not permitted(path, settings) or any(p in ('.git', '.ssh', '.gnupg') or p.startswith('.management-') for p in path.parts):
        raise ValueError('Bu klasör proje yönetimi kapsamı dışında veya sistem için korumalı.')
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise ValueError('Proje yolunda sembolik bağlantı bulunamaz.')
    if not path.is_dir():
        raise ValueError('Proje klasörüne erişilemiyor veya klasör bulunamadı.')
    return path


def find_root(path, settings):
    for candidate in [path, *path.parents]:
        if (candidate / '.git').exists():
            if not permitted(candidate, settings):
                raise ValueError('Git deposunun kökü izin verilen proje alanının dışında.')
            if not (candidate / '.git').is_dir() or (candidate / '.git').is_symlink():
                raise ValueError('Worktree ve alt modül depoları henüz desteklenmiyor.')
            return candidate, True
    return path, False
