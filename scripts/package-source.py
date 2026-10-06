"""Build a public source ZIP from an explicitly reviewed list; never walk runtime data.

Python 3.9+ is needed only by release maintainers, not to start the controller.
"""

import argparse
import hashlib
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile


MANIFEST = 'public-source-files.json'
ARCHIVE_ROOT = 'ViiOS-Standalone/'
BLOCKED_PARTS = {
    'data', 'outputs', 'logs', 'work', 'node_modules', '.git', '.next', '.vinext',
    'dist', 'coverage', '__pycache__', '.browsers', '.codex', '.claude', '.cursor',
}
BLOCKED_NAMES = {
    'admin.json', 'servers.json', 'inventory.json', 'credentials.json',
    'setup.token', 'master.key', 'id_rsa', 'id_ed25519',
}
BLOCKED_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.ppk', '.log', '.sqlite', '.sqlite3', '.db', '.bak', '.zip', '.pyc'}
IMAGE_FILES = {
    'public/favicon.ico', 'public/favicon.png', 'public/apple-touch-icon.png',
    'public/brand/viios-mark.png',
    'public/brand/viios-wordmark-dark.png', 'public/brand/viios-wordmark-light.png',
    *('public/brand/viios-icon-%s.png' % size for size in (16, 32, 48, 64, 180, 192, 512)),
}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(net) for net in ((0x0A000000, 8), (0xAC100000, 12), (0xC0A80000, 16)))
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
KEY_BLOCK = re.compile(r'-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{64,}-----END ')
TOKEN = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|AKIA[A-Z0-9]{16})\b')
GENERIC_CONFIGS = {
    'server/apps.json': {}, 'server/projects.json': [],
    'server/file-targets.json': {}, 'server/model-targets.json': [],
    'server/versioning.json': {
        'enabled': True, 'roots': ['/home', '/opt', '/srv', '/var/www', '/mnt', '/media'],
        'projectRoots': [], 'projectExcludes': {},
    },
    'server/model-catalog-targets.json': {
        'primaryHost': '127.0.0.1', 'primaryName': 'Sunucu',
        'allowedHosts': ['127.0.0.1', 'localhost', '::1'],
        'endpoints': [{'url': 'http://127.0.0.1:11434', 'runtime': 'Ollama', 'source': 'Yerel model servisi'}],
        'ollamaRoots': ['/root/.ollama/models', '/usr/share/ollama/.ollama/models', '/var/lib/ollama/.ollama/models'],
        'modelRoots': ['/opt/models', '/home/models', '/models'], 'additionalProfiles': [],
    },
}


class PublicationError(ValueError):
    pass


def source_path(root, name):
    """Reject path traversal, secret artifacts and links before any source read."""
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise PublicationError('Invalid source path')
    path = PurePosixPath(name)
    if path.is_absolute() or str(path) != name or any(part in ('', '.', '..') for part in path.parts):
        raise PublicationError('Invalid source path')
    lower = [part.lower() for part in path.parts]
    if any(part in BLOCKED_PARTS or part.startswith('.aider') for part in lower):
        raise PublicationError('Excluded directory in source list: ' + name)
    if lower[-1] in BLOCKED_NAMES or path.suffix.lower() in BLOCKED_SUFFIXES:
        raise PublicationError('Private artifact in source list: ' + name)
    if any(part.startswith('.env') for part in lower) and name != '.env.example':
        raise PublicationError('Environment data in source list: ' + name)
    current = root
    for part in path.parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise PublicationError('Linked source path: ' + name)
    if not current.is_file():
        raise PublicationError('Source is not a file: ' + name)
    if info.st_nlink != 1:
        raise PublicationError('Hard-linked source file: ' + name)
    return current


def audit_content(name, content):
    if name in IMAGE_FILES:
        return
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise PublicationError('Unreviewed binary file: ' + name) from exc
    for match in IPV4.finditer(text):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if any(address in network for network in PRIVATE_NETWORKS):
            line = text.count('\n', 0, match.start()) + 1
            raise PublicationError('%s:%s: private-network address; use a documentation address for examples' % (name, line))
    if KEY_BLOCK.search(text) or TOKEN.search(text):
        raise PublicationError('Potential credential material in ' + name)
    if name in GENERIC_CONFIGS and json.loads(text) != GENERIC_CONFIGS[name]:
        raise PublicationError('Configuration must match reviewed generic defaults: ' + name)


def collect_sources(root):
    root = Path(root).resolve()
    names = json.loads(source_path(root, MANIFEST).read_text(encoding='utf-8-sig'))
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names) or len(names) != len(set(names)):
        raise PublicationError('Source list must contain unique paths')
    if MANIFEST not in names or 'package.json' not in names:
        raise PublicationError('Source list is missing required metadata')
    contents = {}
    for name in sorted(names):
        content = source_path(root, name).read_bytes()
        audit_content(name, content)
        contents[name] = content
    return contents


def build_archive(root, contents):
    root = Path(root).resolve()
    version = json.loads(contents['package.json'])['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise PublicationError('Invalid package version')
    manifest = {
        'format': 1, 'version': version, 'purpose': 'public source only',
        'files': [{'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
                  for name, content in sorted(contents.items())],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    digest = hashlib.sha256(manifest_bytes).hexdigest()[:12]
    output = root / 'outputs' / 'releases'
    for parent in (root / 'outputs', output):
        if parent.exists():
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise PublicationError('Linked output directory')
    output.mkdir(parents=True, exist_ok=True)
    if not output.resolve().is_relative_to(root):
        raise PublicationError('Output directory must stay inside the project')
    archive = output / ('ViiOS-Standalone-%s-public-source-%s.zip' % (version, digest))
    entries = {**contents, 'PUBLIC-SOURCE-MANIFEST.json': manifest_bytes}
    if not archive.exists():
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
            for name, content in sorted(entries.items()):
                info = zipfile.ZipInfo(ARCHIVE_ROOT + name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100755 if name == 'start.sh' else 0o100644) << 16
                bundle.writestr(info, content)
    with zipfile.ZipFile(archive) as bundle:
        expected = {ARCHIVE_ROOT + name for name in entries}
        if len(bundle.namelist()) != len(expected) or set(bundle.namelist()) != expected or bundle.testzip() is not None:
            raise PublicationError('Archive entry verification failed')
        for name, content in entries.items():
            if bundle.read(ARCHIVE_ROOT + name) != content:
                raise PublicationError('Archive content verification failed: ' + name)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.sha256').write_text(checksum + '  ' + archive.name + '\n', encoding='utf-8')
    return archive, checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate the public source list without writing an archive')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    contents = collect_sources(root)
    print('Validated %s explicitly listed source files.' % len(contents))
    if not args.check:
        archive, checksum = build_archive(root, contents)
        print(archive)
        print('SHA256: ' + checksum)


if __name__ == '__main__':
    try:
        main()
    except (PublicationError, OSError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit('Public source packaging stopped: ' + str(error)) from error
