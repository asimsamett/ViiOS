"""Fixed JSON broker for project files. Linux, root-owned installation, no shell."""
import base64
import ctypes
import errno
import fcntl
import hashlib
import io
import json
import os
import pathlib
import stat
import sys
import time
import uuid
import unicodedata
import zipfile
import threading
import signal
import pwd
import grp
from collections import deque
from contextlib import contextmanager

ROOTS = ['/home', '/opt', '/srv', '/var/www', '/mnt', '/media']
PROTECTED = ['/opt/viios-agent', '/opt/viios-agent-releases', '/var/lib/viios-agent', '/opt/containerd']
STORE = '/var/lib/viios-agent/files'
TEXT_LIMIT = 1024 * 1024
FILE_LIMIT = 16 * 1024 * 1024
COPY_LIMIT = 200 * 1024 * 1024
ENTRY_LIMIT = 5000
SEARCH_VISITS = 15000
SEARCH_RESULTS = 80
SEARCH_SECONDS = 0.8
SEARCH_DEPTH = 12
PROPERTIES_SECONDS = 20
SEARCH_SKIP = {'node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build'}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
LIBC = ctypes.CDLL(None, use_errno=True)


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def within(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def clean(path):
    if not isinstance(path, str) or not path.startswith('/') or len(path) > 4096 or '\x00' in path:
        raise Problem('Geçersiz dosya yolu.')
    if any(part in ('.', '..') for part in path.split('/')):
        raise Problem('Üst dizine kaçış içeren yollar kullanılamaz.')
    return '/' + '/'.join(part for part in path.split('/') if part)


def root_for(path):
    return next((root for root in sorted(ROOTS, key=len, reverse=True) if within(path, root)), None)


def protected(path):
    return any(within(path, p) for p in PROTECTED) or any(p in ('.ssh', '.gnupg') or p.startswith('.management-') for p in path.split('/'))


def allowed(path, mutation=False):
    path = clean(path)
    if not root_for(path) or protected(path):
        raise Problem('Bu alan korumalı veya dosya yönetimi kapsamı dışında.', 403)
    if mutation and (path in ROOTS or any(within(p, path) for p in PROTECTED)):
        raise Problem('Ana dizin veya korumalı alan içeren klasör değiştirilemez.', 403)
    return path


def name(value):
    if not isinstance(value, str) or not value.strip() or value in ('.', '..') or '/' in value or '\x00' in value or len(value.encode()) > 255:
        raise Problem('1–255 bayt uzunluğunda, / içermeyen bir ad girin.')
    if any(ord(c) < 32 for c in value):
        raise Problem('Dosya adı kontrol karakteri içeremez.')
    return value


@contextmanager
def directory(path):
    """Walk from / using directory descriptors; never traverse a symlink."""
    path = clean(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for part in path.split('/'):
            if not part:
                continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextmanager
def parent(path, mutation=False):
    path = allowed(path, mutation)
    folder, leaf = path.rsplit('/', 1)
    with directory(folder or '/') as fd:
        yield fd, leaf


def revision(info):
    return hashlib.sha256(json.dumps([info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                                     info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]).encode()).hexdigest()


def checked(fd, leaf, token=None, regular=False, archive_links=False):
    info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise Problem('Bağlantılar ve özel dosyalar bu bölümden açılamaz veya değiştirilemez.', 403)
    if stat.S_ISREG(info.st_mode) and info.st_nlink > 1 and not archive_links:
        raise Problem('Birden fazla fiziksel bağlantısı olan dosya korumalıdır.', 403)
    if regular and not stat.S_ISREG(info.st_mode):
        raise Problem('Bu işlem için normal bir dosya seçin.')
    if token is not None and (not isinstance(token, str) or revision(info) != token):
        raise Problem('Öğe değişmiş. Listeyi yenileyip tekrar deneyin; mevcut içerik korunuyor.', 409)
    return info


def no_replace(src_fd, source, dst_fd, target):
    # Linux renameat2(RENAME_NOREPLACE) is atomic even against external writers.
    if LIBC.renameat2(src_fd, source.encode(), dst_fd, target.encode(), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise Problem('Bu ad zaten var. Farklı bir ad seçin.', 409)
        if code == errno.EXDEV:
            raise Problem('Farklı diskler arasında taşıma yerine Kopyala kullanın.', 409)
        raise OSError(code, os.strerror(code))


def ensure_absent(fd, leaf):
    try:
        os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise Problem('Bu ad zaten var. Var olan öğenin üzerine yazılmadı.', 409)


def list_directory(request):
    path = clean(request.get('path', '/home'))
    if path != '/':
        allowed(path)
    query = request.get('query', '')
    if not isinstance(query, str) or len(query) > 200:
        raise Problem('Arama en fazla 200 karakter olabilir.')
    offset = request.get('offset', 0)
    if type(offset) is not int or not 0 <= offset <= 1000000:
        raise Problem('Geçersiz sayfa.')
    entries = []
    with directory(path) as fd:
        for item in os.scandir(fd):
            if len(entries) > 100000:
                raise Problem('Dizin çok büyük; daha dar bir klasör seçin.', 413)
            if query.casefold() not in item.name.casefold() or (not request.get('hidden', False) and item.name.startswith('.')):
                continue
            try:
                info = item.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            full = path.rstrip('/') + '/' + item.name
            kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else 'special'
            accessible = bool(root_for(full)) and not protected(full) and kind in ('file', 'directory') and not (kind == 'file' and info.st_nlink > 1)
            mutable = accessible and full not in ROOTS and not any(within(p, full) for p in PROTECTED)
            entries.append({'name': item.name, 'path': full, 'kind': kind, 'size': info.st_size if kind == 'file' else None,
                            'modifiedAt': info.st_mtime * 1000, 'mode': stat.filemode(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                            'revision': revision(info), 'accessible': accessible, 'mutable': mutable})
    entries.sort(key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
    return {'path': path, 'parent': path.rsplit('/', 1)[0] or '/', 'total': len(entries), 'offset': offset,
            'entries': entries[offset:offset + 200], 'writable': path != '/' and not protected(path)}


def file_properties(request):
    """Inspect metadata only. Never open file contents or follow symlink targets."""
    path = clean(request.get('path'))
    folder, leaf = path.rsplit('/', 1)
    folder = folder or '/'
    if folder != '/' and path not in ROOTS:
        allowed(folder)  # Only entries visible in an allowed parent can be inspected.
    with directory(folder) as parent_fd:
        info = os.stat(leaf or '.', dir_fd=parent_fd, follow_symlinks=False)
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else 'special'
        readable = bool(root_for(path)) and not protected(path)
        def identity_name(lookup, identity):
            try: return lookup(identity)[0]
            except KeyError: return str(identity)
        result = {
            'path': path, 'name': leaf or 'Sunucu kökü', 'parent': folder, 'kind': kind,
            'mode': stat.filemode(info.st_mode), 'permissions': format(stat.S_IMODE(info.st_mode), '04o'),
            'uid': info.st_uid, 'gid': info.st_gid, 'owner': identity_name(pwd.getpwuid, info.st_uid),
            'group': identity_name(grp.getgrgid, info.st_gid), 'modifiedAt': info.st_mtime * 1000,
            'accessedAt': info.st_atime * 1000, 'metadataChangedAt': info.st_ctime * 1000,
            'sizeBytes': info.st_size if kind in ('file', 'link') else None,
            'allocatedBytes': info.st_blocks * 512 if kind != 'directory' else None,
            'files': 0, 'directories': 0, 'links': 0, 'special': 0, 'sharedReferences': 0,
            'restricted': not readable, 'partial': False, 'skipped': 0, 'changed': False,
            'timedOut': False, 'scannedAt': time.time() * 1000,
        }
        if kind != 'directory' or not readable:
            return result
        root_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
        root_info = os.fstat(root_fd)
        if revision(root_info) != revision(info):
            os.close(root_fd)
            raise Problem('Öğe değişti. Özellikleri yeniden hesaplayın.', 409)
        result.update(sizeBytes=0, allocatedBytes=root_info.st_blocks * 512)
        seen = {(root_info.st_dev, root_info.st_ino)}
        ancestors = {(root_info.st_dev, root_info.st_ino)}
        frames = []
        started = time.monotonic()
        try:
            frames.append((root_fd, os.scandir(root_fd), path, root_info))
        except Exception:
            os.close(root_fd)
            raise
        try:
            while frames:
                if time.monotonic() - started >= PROPERTIES_SECONDS:
                    result['timedOut'] = True
                    break
                fd, entries, current_path, before = frames[-1]
                try:
                    entry = next(entries)
                except StopIteration:
                    if revision(os.fstat(fd)) != revision(before): result['changed'] = True
                    entries.close(); os.close(fd); frames.pop()
                    ancestors.remove((before.st_dev, before.st_ino))
                    continue
                except OSError:
                    result['skipped'] += 1
                    entries.close(); os.close(fd); frames.pop()
                    ancestors.remove((before.st_dev, before.st_ino))
                    continue
                full = current_path.rstrip('/') + '/' + entry.name
                try:
                    item = entry.stat(follow_symlinks=False)
                except OSError:
                    result['skipped'] += 1
                    continue
                isdir, isfile, islink = stat.S_ISDIR(item.st_mode), stat.S_ISREG(item.st_mode), stat.S_ISLNK(item.st_mode)
                result['directories' if isdir else 'files' if isfile else 'links' if islink else 'special'] += 1
                if protected(full):
                    result['skipped'] += 1
                    continue
                key = (item.st_dev, item.st_ino)
                if isfile:
                    result['sizeBytes'] += item.st_size
                    if key in seen: result['sharedReferences'] += 1
                if key not in seen:
                    result['allocatedBytes'] += item.st_blocks * 512
                    seen.add(key)
                if not isdir:
                    continue
                if key in ancestors:
                    result['skipped'] += 1
                    continue
                child_fd = None
                try:
                    child_fd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                    actual = os.fstat(child_fd)
                    if revision(actual) != revision(item):
                        os.close(child_fd)
                        result['changed'] = True; result['skipped'] += 1
                        continue
                    child_entries = os.scandir(child_fd)
                except OSError:
                    if child_fd is not None: os.close(child_fd)
                    result['skipped'] += 1
                    continue
                frames.append((child_fd, child_entries, full, actual))
                ancestors.add(key)
        finally:
            for fd, entries, _, _ in frames:
                entries.close(); os.close(fd)
        result['partial'] = bool(result['skipped'] or result['changed'] or result['timedOut'])
        result['scannedAt'] = time.time() * 1000
        return result


def search_fold(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold().replace('ı', 'i')) if not unicodedata.combining(c))


def search_files(request):
    query = request.get('query', '')
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 120:
        raise Problem('Arama için 2–120 karakter girin.')
    path = clean(request.get('path', '/'))
    if path != '/':
        allowed(path)
    roots = [r for r in ROOTS if os.path.isdir(r)] if path == '/' else [path]
    queue = deque((root, 0, None) for root in roots)
    words = search_fold(query).split()
    if not words:
        raise Problem('Aranabilir bir dosya adı girin.')
    entries, seen, reasons = [], set(), set()
    visited = folders = skipped = 0
    started = time.monotonic()
    stop = False
    while queue and not stop:
        folder, depth, expected = queue.popleft()
        try:
            allowed(folder)
            with directory(folder) as fd:
                info = os.fstat(fd)
                identity = (info.st_dev, info.st_ino)
                if expected is not None and identity != expected:
                    skipped += 1
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                folders += 1
                with os.scandir(fd) as children:
                    for child in children:
                        if visited >= SEARCH_VISITS or time.monotonic() - started >= SEARCH_SECONDS:
                            reasons.add('entry-limit' if visited >= SEARCH_VISITS else 'time-limit')
                            stop = True
                            break
                        visited += 1
                        full = folder.rstrip('/') + '/' + child.name
                        if protected(full) or (not request.get('hidden', False) and child.name.startswith('.')):
                            continue
                        try:
                            info = child.stat(follow_symlinks=False)
                        except OSError:
                            skipped += 1
                            continue
                        isdir = stat.S_ISDIR(info.st_mode)
                        if not isdir and (not stat.S_ISREG(info.st_mode) or info.st_nlink > 1):
                            continue
                        if all(word in search_fold(child.name) for word in words):
                            entries.append({'name': child.name, 'path': full, 'kind': 'directory' if isdir else 'file',
                                            'size': None if isdir else info.st_size, 'modifiedAt': info.st_mtime * 1000,
                                            'mode': stat.filemode(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                                            'revision': revision(info), 'accessible': True,
                                            'mutable': full not in ROOTS and not any(within(p, full) for p in PROTECTED)})
                            if len(entries) >= SEARCH_RESULTS:
                                reasons.add('result-limit')
                                stop = True
                                break
                        if isdir and child.name not in SEARCH_SKIP:
                            if depth >= SEARCH_DEPTH:
                                reasons.add('depth-limit')
                            else:
                                queue.append((full, depth + 1, (info.st_dev, info.st_ino)))
        except (OSError, Problem):
            skipped += 1
        if time.monotonic() - started >= SEARCH_SECONDS and queue:
            reasons.add('time-limit')
            break
    entries.sort(key=lambda e: (e['kind'] != 'directory', search_fold(e['name']), e['path']))
    return {'query': query, 'path': path, 'entries': entries, 'visited': visited, 'folders': folders,
            'truncated': bool(reasons), 'reasons': sorted(reasons), 'skipped': skipped,
            'excludedDirectories': sorted(SEARCH_SKIP)}


def read_bytes(path, token=None):
    with parent(path) as (fd, leaf):
        info = checked(fd, leaf, token, regular=True)
        if info.st_size > FILE_LIMIT:
            raise Problem('Görüntüleme/indirme sınırı 16 MB. Büyük dosyalar için SSH/SFTP kullanın.', 413)
        handle = os.open(leaf, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(handle, 'rb') as file:
            if revision(os.fstat(file.fileno())) != revision(info):
                raise Problem('Dosya okuma sırasında değişti. Yenileyin.', 409)
            data = file.read(FILE_LIMIT + 1)
            if len(data) > FILE_LIMIT or revision(os.fstat(file.fileno())) != revision(info):
                raise Problem('Dosya okuma sırasında değişti veya sınırı aştı.', 409)
        return data, info


def image_mime(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def view_file(request):
    path = allowed(request.get('path'))
    data, info = read_bytes(path)
    result = {'path': path, 'name': os.path.basename(path), 'size': info.st_size, 'revision': revision(info), 'editable': False}
    mime = image_mime(data)
    if mime:
        return {**result, 'kind': 'image', 'mime': mime}
    if len(data) <= TEXT_LIMIT and b'\x00' not in data:
        try:
            text = data.decode('utf-8')
            return {**result, 'kind': 'text', 'content': text, 'editable': True}
        except UnicodeDecodeError:
            pass
    return {**result, 'kind': 'binary', 'mime': 'application/octet-stream'}


def write_atomic(request, new=False):
    path = allowed(request.get('path'), True)
    if new:
        name(os.path.basename(path))
    content = request.get('content', '')
    if not isinstance(content, str) or len(content.encode('utf-8')) > TEXT_LIMIT or '\x00' in content:
        raise Problem('Metin UTF-8 olmalı ve 1 MB sınırını aşmamalı.', 413)
    data = content.encode('utf-8')
    with parent(path, True) as (fd, leaf):
        original = None if new else checked(fd, leaf, request.get('revision'), regular=True)
        if new:
            ensure_absent(fd, leaf)
        else:
            if not request.get('revision'):
                raise Problem('Kaydetmek için dosyanın güncel revizyonu gerekiyor.', 409)
            if original.st_size > TEXT_LIMIT or (original.st_mode & 0o6000):
                raise Problem('Bu dosya metin düzenlemeye uygun değil.', 403)
        owner = original or os.fstat(fd)
        temp = '.management-write-' + uuid.uuid4().hex
        handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(handle, 'wb') as file:
                file.write(data)
                os.fchown(file.fileno(), owner.st_uid, owner.st_gid)
                os.fchmod(file.fileno(), stat.S_IMODE(original.st_mode) if original else 0o644)
                file.flush()
                os.fsync(file.fileno())
            if new:
                no_replace(fd, temp, fd, leaf)
            else:
                checked(fd, leaf, request['revision'], regular=True)
                os.replace(temp, leaf, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass
    return {'path': path, 'message': 'Dosya oluşturuldu.' if new else 'Dosya kaydedildi.'}


def upload_stream(request, stream):
    path = allowed(request.get('path'), True)
    name(os.path.basename(path))
    expected = request.get('size')
    if type(expected) is not int or expected < 0 or expected > 9007199254740991:
        raise Problem('Geçersiz dosya boyutu.')
    with parent(path, True) as (fd, leaf):
        ensure_absent(fd, leaf)
        owner = os.fstat(fd)
        stage = '.management-upload-' + uuid.uuid4().hex
        os.mkdir(stage, 0o700, dir_fd=fd)
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
        stage_info = os.fstat(stage_fd)
        if stage_info.st_uid != 0 or stat.S_IMODE(stage_info.st_mode) != 0o700:
            os.close(stage_fd)
            raise Problem('Geçici yükleme alanı değişti. Yeniden deneyin.', 409)
        try:
            handle = os.open('payload', os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=stage_fd)
            with os.fdopen(handle, 'wb') as file:
                remaining = expected
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise Problem('Yükleme yarıda kesildi; eksik dosya kaydedilmedi.', 400)
                    file.write(chunk)
                    remaining -= len(chunk)
                if stream.readline(64) != b'\n' or stream.readline(64) != b'MANAGEMENT-UPLOAD-COMMIT\n' or stream.read(1):
                    raise Problem('Yükleme tamamlanmadı; eksik dosya kaydedilmedi.', 400)
                file.flush()
                os.fsync(file.fileno())
                os.makedirs(STORE, mode=0o700, exist_ok=True)
                store_info = os.lstat(STORE)
                if not stat.S_ISDIR(store_info.st_mode) or store_info.st_uid != 0 or stat.S_IMODE(store_info.st_mode) != 0o700:
                    raise Problem('Dosya kontrol deposu izinleri geçersiz.', 503)
                with os.fdopen(os.open(STORE + '/lock', os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600), 'w') as guard:
                    try:
                        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise Problem('Başka bir dosya işlemi sürüyor. Yüklemeyi tekrar deneyin.', 409)
                    with directory(path.rsplit('/', 1)[0] or '/') as current:
                        current_info = os.fstat(current)
                        if (current_info.st_dev, current_info.st_ino) != (owner.st_dev, owner.st_ino):
                            raise Problem('Hedef klasör yükleme sırasında değişti. Yeniden seçin.', 409)
                        os.fchown(file.fileno(), owner.st_uid, owner.st_gid)
                        os.fchmod(file.fileno(), 0o644)
                        no_replace(stage_fd, 'payload', current, leaf)
                        os.fsync(current)
                    with os.fdopen(os.open(STORE + '/events.jsonl', os.O_CREAT | os.O_APPEND | os.O_WRONLY | NOFOLLOW, 0o600), 'a') as log:
                        log.write(json.dumps({'action': 'upload', 'path': path, 'bytes': expected, 'at': time.time() * 1000}) + '\n')
        except OSError as error:
            if error.errno in (errno.ENOSPC, errno.EDQUOT):
                raise Problem('Sunucuda yeterli disk alanı yok. Yükleme tamamlanamadı.', 507)
            raise
        finally:
            try:
                os.unlink('payload', dir_fd=stage_fd)
            except FileNotFoundError:
                pass
            os.close(stage_fd)
            try:
                visible = os.stat(stage, dir_fd=fd, follow_symlinks=False)
                if (visible.st_dev, visible.st_ino) == (stage_info.st_dev, stage_info.st_ino):
                    os.rmdir(stage, dir_fd=fd)
            except FileNotFoundError:
                pass
    return {'path': path, 'bytes': expected, 'message': 'Dosya yüklendi.'}


def preflight(fd, leaf, path, budget, depth=0, exporting=False):
    allowed(path)
    if not exporting and depth > 48:
        raise Problem('Klasör derinliği sınırı aşıldı.', 413)
    info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    if exporting:
        archive_component(leaf)
    if exporting and stat.S_ISLNK(info.st_mode):
        # Preserve the link itself in a backup; never read its target.
        target = os.readlink(leaf, dir_fd=fd)
        if revision(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) != revision(info):
            raise Problem('Bağlantı dışa aktarım sırasında değişti.', 409)
        budget['entries'] += 1
        return {'info': info, 'children': [], 'link': target}
    info = checked(fd, leaf, archive_links=exporting)
    if exporting and stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
        key = (info.st_dev, info.st_ino)
        linked = budget.setdefault('_links', {}).setdefault(key, {'expected': info.st_nlink, 'entries': set()})
        if linked['expected'] != info.st_nlink:
            raise Problem('Kaynak bağlantıları işlem sırasında değişti.', 409)
        parent_info = os.fstat(fd)
        # Bind-mounted aliases must not count one physical directory entry twice.
        linked['entries'].add((parent_info.st_dev, parent_info.st_ino, leaf))
    budget['entries'] += 1
    budget['bytes'] += info.st_size if stat.S_ISREG(info.st_mode) else 0
    if not exporting and (budget['entries'] > ENTRY_LIMIT or budget['bytes'] > COPY_LIMIT):
        raise Problem('Kopyalama/taşıma sınırı: 5000 öğe ve 200 MB.', 413)
    children = []
    if stat.S_ISDIR(info.st_mode):
        child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
        try:
            for entry in os.listdir(child):
                children.append((entry, preflight(child, entry, path + '/' + entry, budget, depth + 1, exporting)))
            if revision(os.fstat(child)) != revision(info):
                raise Problem('Klasör işlem sırasında değişti. Yenileyin.', 409)
        finally:
            os.close(child)
    if exporting and depth == 0:
        for linked in budget.get('_links', {}).values():
            if len(linked['entries']) != linked['expected']:
                raise Problem('Seçilen klasör dışında fiziksel bağlantısı olan dosya korumalıdır. İlgili proje kökünü seçin.', 403)
    return {'info': info, 'children': children}


def remove_stage(fd, leaf):
    info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
        try:
            for entry in os.listdir(child):
                remove_stage(child, entry)
        finally:
            os.close(child)
        os.rmdir(leaf, dir_fd=fd)
    else:
        os.unlink(leaf, dir_fd=fd)


def archive_component(value):
    name(value)
    if any(c in value for c in '\\:'):
        raise Problem('ZIP içinde ters eğik çizgi veya : içeren ad kullanılamaz.', 400)
    return value


def archive_tree(archive, fd, leaf, arcname, plan):
    if 'link' in plan:
        info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
        if revision(info) != revision(plan['info']) or not stat.S_ISLNK(info.st_mode):
            raise Problem('Bağlantı dışa aktarım sırasında değişti.', 409)
        target = os.readlink(leaf, dir_fd=fd)
        if target != plan['link'] or revision(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) != revision(info):
            raise Problem('Bağlantı dışa aktarım sırasında değişti.', 409)
        item = zipfile.ZipInfo(arcname)
        item.create_system = 3
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(item, os.fsencode(target))
        return
    info = checked(fd, leaf, revision(plan['info']), archive_links=True)
    isdir = stat.S_ISDIR(info.st_mode)
    handle = os.open(leaf, os.O_RDONLY | NOFOLLOW | (os.O_DIRECTORY if isdir else os.O_NONBLOCK), dir_fd=fd)
    try:
        if revision(os.fstat(handle)) != revision(info):
            raise Problem('Kaynak dışa aktarım sırasında değişti. Yenileyin.', 409)
        stamp = time.localtime(info.st_mtime)[:6]
        item = zipfile.ZipInfo(arcname + ('/' if isdir else ''), stamp if 1980 <= stamp[0] <= 2107 else (1980, 1, 1, 0, 0, 0))
        item.create_system = 3
        item.compress_type = zipfile.ZIP_DEFLATED
        item.external_attr = ((stat.S_IFDIR if isdir else stat.S_IFREG) | (stat.S_IMODE(info.st_mode) & 0o777)) << 16
        if isdir:
            item.external_attr |= 0x10
            archive.writestr(item, b'')
            for child, child_plan in plan['children']:
                archive_tree(archive, handle, child, arcname + '/' + archive_component(child), child_plan)
        else:
            remaining = info.st_size
            item.file_size = info.st_size
            with archive.open(item, 'w', force_zip64=True) as out:
                while remaining:
                    chunk = os.read(handle, min(1024 * 1024, remaining))
                    if not chunk:
                        raise Problem('Kaynak dosya dışa aktarım sırasında değişti.', 409)
                    out.write(chunk)
                    remaining -= len(chunk)
        if revision(os.fstat(handle)) != revision(info):
            raise Problem('Kaynak dışa aktarım sırasında değişti. Yenileyin.', 409)
    finally:
        os.close(handle)


def export_archive(request):
    path = allowed(request.get('path'))
    token = request.get('revision')
    if not isinstance(token, str) or len(token) != 64:
        raise Problem('Dışa aktarmak için güncel öğe revizyonu gerekiyor.', 409)
    with parent(path) as (fd, leaf), io.BytesIO() as output:
        checked(fd, leaf, token)
        plan = preflight(fd, leaf, path, {'entries': 0, 'bytes': 0}, exporting=True)
        if revision(plan['info']) != token:
            raise Problem('Kaynak değişti. Klasörü yenileyin.', 409)
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive_tree(archive, fd, leaf, archive_component(leaf), plan)
        checked(fd, leaf, token)
        data = output.getvalue()
    return {'name': leaf + '.zip', 'mime': 'application/zip', 'size': len(data), 'data': base64.b64encode(data).decode()}


def export_stream(request):
    """A metadata line followed by ZIP64 bytes. No file-size/count or wall-clock cap."""
    # Also cancel during a long metadata scan, before the first ZIP byte exists.
    def disconnected():
        os.read(sys.stdin.fileno(), 1)
        os._exit(143)
    threading.Thread(target=disconnected, daemon=True).start()
    path = allowed(request.get('path'))
    token = request.get('revision')
    if not isinstance(token, str) or len(token) != 64:
        raise Problem('Dışa aktarmak için güncel öğe revizyonu gerekiyor.', 409)
    with parent(path) as (fd, leaf):
        checked(fd, leaf, token)
        budget = {'entries': 0, 'bytes': 0}
        plan = preflight(fd, leaf, path, budget, exporting=True)
        if revision(plan['info']) != token:
            raise Problem('Kaynak değişti. Klasörü yenileyin.', 409)
        # Node holds stdin open for the lifetime of the HTTP download. A lost
        # connection terminates even a root helper behind sudo or remote SSH.
        sys.stdout.buffer.write((json.dumps({'ok': True, 'name': leaf + '.zip', 'entries': budget['entries'], 'bytes': budget['bytes']}) + '\n').encode())
        sys.stdout.buffer.flush()
        with zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            archive_tree(archive, fd, leaf, archive_component(leaf), plan)
        checked(fd, leaf, token)
        sys.stdout.buffer.flush()


def copy_tree(src_fd, source, dst_fd, target, plan, outer=False):
    info = checked(src_fd, source, revision(plan['info']))
    if stat.S_ISDIR(info.st_mode):
        os.mkdir(target, 0o700, dir_fd=dst_fd)
        src = os.open(source, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=src_fd)
        dst = os.open(target, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=dst_fd)
        try:
            for leaf, child in plan['children']:
                copy_tree(src, leaf, dst, leaf, child)
            if revision(os.fstat(src)) != revision(info):
                raise Problem('Kaynak klasör değişti; kopya yayınlanmadı.', 409)
            if not outer:
                os.fchown(dst, info.st_uid, info.st_gid)
                os.fchmod(dst, stat.S_IMODE(info.st_mode) & 0o777)
        finally:
            os.close(src)
            os.close(dst)
    else:
        src = os.open(source, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=src_fd)
        dst = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=dst_fd)
        with os.fdopen(src, 'rb') as inp, os.fdopen(dst, 'wb') as out:
            if revision(os.fstat(inp.fileno())) != revision(info):
                raise Problem('Kaynak dosya değişti.', 409)
            remaining = info.st_size
            while remaining:
                chunk = inp.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise Problem('Kaynak dosya değişti.', 409)
                out.write(chunk)
                remaining -= len(chunk)
            if revision(os.fstat(inp.fileno())) != revision(info):
                raise Problem('Kaynak dosya değişti.', 409)
            if not outer:
                os.fchown(out.fileno(), info.st_uid, info.st_gid)
                os.fchmod(out.fileno(), stat.S_IMODE(info.st_mode) & 0o777)
            out.flush()
            os.fsync(out.fileno())


def transfer(request, move=False):
    source, target = allowed(request.get('path'), move), allowed(request.get('destination'), True)
    name(os.path.basename(target))
    if source == target or within(target, source):
        raise Problem('Bir klasör kendisine veya kendi içine kopyalanamaz/taşınamaz.')
    with parent(source, move) as (src, leaf), parent(target, True) as (dst, final):
        checked(src, leaf, request.get('revision'))
        if not request.get('revision'):
            raise Problem('Kaynağın güncel revizyonu gerekiyor.', 409)
        ensure_absent(dst, final)
        plan = preflight(src, leaf, source, {'entries': 0, 'bytes': 0})
        if move:
            checked(src, leaf, request['revision'])
            no_replace(src, leaf, dst, final)
        else:
            stage = '.management-copy-' + uuid.uuid4().hex
            try:
                copy_tree(src, leaf, dst, stage, plan, outer=True)
                stage_fd = os.open(stage, os.O_RDONLY | NOFOLLOW, dir_fd=dst)
                try:
                    no_replace(dst, stage, dst, final)
                    info = plan['info']
                    os.fchown(stage_fd, info.st_uid, info.st_gid)
                    os.fchmod(stage_fd, stat.S_IMODE(info.st_mode) & 0o777)
                finally:
                    os.close(stage_fd)
            finally:
                try:
                    remove_stage(dst, stage)
                except FileNotFoundError:
                    pass
        os.fsync(dst)
    return {'path': source, 'destination': target, 'message': 'Öğe taşındı.' if move else 'Kopya oluşturuldu.'}


def private_dir(fd, leaf):
    try:
        os.mkdir(leaf, 0o700, dir_fd=fd)
    except FileExistsError:
        pass
    child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
    info = os.fstat(child)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(child)
        raise Problem('Korumalı dosya deposu izinleri geçersiz.', 503)
    return child


@contextmanager
def private_open(path):
    with directory(path) as fd:
        info = os.fstat(fd)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise Problem('Korumalı dosya deposu izinleri geçersiz.', 503)
        yield fd


def trash_metadata(fd):
    info = checked(fd, 'meta.json', regular=True)
    if info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 8192:
        raise Problem('Çöp kaydı izinleri veya boyutu geçersiz.', 503)
    handle = os.open('meta.json', os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=fd)
    with os.fdopen(handle) as file:
        if revision(os.fstat(file.fileno())) != revision(info):
            raise Problem('Çöp kaydı değişti.', 409)
        return json.loads(file.read(8193))


def trash(request):
    path = allowed(request.get('path'), True)
    root = root_for(path)
    with directory(root) as root_fd, parent(path, True) as (src, leaf):
        checked(src, leaf, request.get('revision'))
        if not request.get('revision'):
            raise Problem('Güncel öğe revizyonu gerekiyor.', 409)
        # Reject protected descendants and links before moving an entire tree.
        preflight(src, leaf, path, {'entries': 0, 'bytes': 0})
        trash_fd = private_dir(root_fd, '.management-trash')
        ident = uuid.uuid4().hex
        item_fd = private_dir(trash_fd, ident)
        try:
            metadata = {'id': ident, 'root': root, 'path': path, 'name': leaf, 'deletedAt': time.time() * 1000}
            meta = os.open('meta.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=item_fd)
            with os.fdopen(meta, 'w') as output:
                json.dump(metadata, output)
                output.flush()
                os.fsync(output.fileno())
            checked(src, leaf, request['revision'])
            no_replace(src, leaf, item_fd, 'item')
            os.fsync(item_fd)
        finally:
            os.close(item_fd)
            os.close(trash_fd)
    return {**metadata, 'message': 'Öğe çöp kutusuna taşındı; geri yükleyebilirsiniz.'}


def trash_items():
    entries = []
    for root in ROOTS:
        try:
            with private_open(root + '/.management-trash') as fd:
                for ident in os.listdir(fd):
                    if len(ident) != 32 or any(c not in '0123456789abcdef' for c in ident):
                        continue
                    with private_open(root + '/.management-trash/' + ident) as entry:
                        try:
                            info = checked(entry, 'item')
                            meta = trash_metadata(entry)
                            entries.append({**meta, 'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file'})
                        except FileNotFoundError:
                            continue
        except FileNotFoundError:
            continue
    return {'entries': sorted(entries, key=lambda e: e['deletedAt'], reverse=True)[:1000]}


def restore(request):
    root, ident = request.get('root'), request.get('id')
    if root not in ROOTS or not isinstance(ident, str) or len(ident) != 32 or any(c not in '0123456789abcdef' for c in ident):
        raise Problem('Geçersiz çöp kaydı.')
    with private_open(root + '/.management-trash'), private_open(root + '/.management-trash/' + ident) as fd:
        meta = trash_metadata(fd)
        path = allowed(meta['path'], True)
        if root_for(path) != root:
            raise Problem('Çöp kaydı hedefi geçersiz.', 403)
        with parent(path, True) as (dst, leaf):
            checked(fd, 'item')
            no_replace(fd, 'item', dst, leaf)
            os.fsync(dst)
    return {'path': path, 'message': 'Öğe eski konumuna geri yüklendi.'}


def execute(request):
    if not isinstance(request, dict):
        raise Problem('Geçersiz dosya isteği.')
    action = request.get('action')
    if action == 'capabilities':
        return {'available': True, 'roots': [r for r in ROOTS if os.path.isdir(r)], 'defaultPath': '/home', 'textLimit': TEXT_LIMIT,
                'fileLimit': FILE_LIMIT, 'copyLimit': COPY_LIMIT, 'reason': 'Proje alanları yönetilebilir. Sistem alanları, panelin kendisi ve SSH anahtarları korumalıdır.'}
    if action == 'list':
        return list_directory(request)
    if action == 'search':
        return search_files(request)
    if action == 'properties':
        return file_properties(request)
    if action == 'read':
        return view_file(request)
    if action == 'export':
        return export_archive(request)
    if action == 'download':
        data, info = read_bytes(request.get('path'))
        return {'name': os.path.basename(request['path']), 'data': base64.b64encode(data).decode(), 'mime': image_mime(data), 'size': info.st_size}
    if action == 'upload':
        raise Problem('Dosya yüklemek için sayfayı yenileyip İçe aktar seçin.', 409)
    if action in ('write', 'create'):
        return write_atomic(request, new=action != 'write')
    if action in ('mkdir', 'upload-directory'):
        path = allowed(request.get('path'), True)
        name(os.path.basename(path))
        with parent(path, True) as (fd, leaf):
            try:
                os.mkdir(leaf, 0o755, dir_fd=fd)
            except FileExistsError:
                if action != 'upload-directory':
                    raise
                info = checked(fd, leaf)
                if not stat.S_ISDIR(info.st_mode):
                    raise Problem('Bu yolda bir dosya var; klasör oluşturulamadı.', 409)
                return {'path': path, 'existing': True}
            owner = os.fstat(fd)
            os.chown(leaf, owner.st_uid, owner.st_gid, dir_fd=fd, follow_symlinks=False)
        return {'path': path, 'message': 'Klasör oluşturuldu.'}
    if action in ('copy', 'move'):
        return transfer(request, move=action == 'move')
    if action == 'trash':
        return trash(request)
    if action == 'trash-list':
        return trash_items()
    if action == 'restore':
        return restore(request)
    raise Problem('Desteklenmeyen dosya işlemi.')


def main():
    request = {}
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise Problem('Dosya yardımcısı yalnızca yetkili yönetim servisi tarafından çalıştırılabilir.', 403)
        first_line = sys.stdin.buffer.readline(24 * 1024 * 1024 + 1)
        request = json.loads(first_line)
        if request.get('action') == 'upload-stream':
            def cancelled(_signum, _frame):
                raise Problem('Yükleme iptal edildi; geçici dosya temizlendi.', 499)
            signal.signal(signal.SIGTERM, cancelled)
            print(json.dumps({'ok': True, **upload_stream(request, sys.stdin.buffer)}, ensure_ascii=False))
            return
        if request.get('action') == 'export-stream':
            try:
                export_stream(request)
            except Exception as error:
                message = str(error) if isinstance(error, Problem) else 'Dışa aktarım tamamlanamadı. Kaynağı ve sunucu bağlantısını kontrol edin.'
                sys.stderr.write(json.dumps({'error': message, 'status': getattr(error, 'status', 503)}) + '\n')
                sys.stderr.flush()
                raise SystemExit(1)
            return
        if request.get('action') == 'export':
            raise Problem('Dışa aktarım için akışlı indirme kullanın.', 409)
        if request.get('action') == 'properties':
            print(json.dumps({'ok': True, **file_properties(request)}, ensure_ascii=False))
            return
        os.makedirs(STORE, mode=0o700, exist_ok=True)
        info = os.lstat(STORE)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise Problem('Dosya kontrol deposu izinleri geçersiz.', 503)
        lock = os.open(STORE + '/lock', os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600)
        with os.fdopen(lock, 'w') as guard:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Problem('Başka bir dosya işlemi sürüyor. Biraz sonra tekrar deneyin.', 409)
            result = execute(request)
            if request.get('action') in ('write', 'create', 'upload', 'upload-directory', 'mkdir', 'copy', 'move', 'trash', 'restore'):
                record = {k: result[k] for k in ('path', 'destination', 'id') if k in result}
                record.update(action=request['action'], at=time.time() * 1000)
                handle = os.open(STORE + '/events.jsonl', os.O_CREAT | os.O_APPEND | os.O_WRONLY | NOFOLLOW, 0o600)
                with os.fdopen(handle, 'a') as log:
                    log.write(json.dumps(record) + '\n')
            print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except Exception as error:
        status = getattr(error, 'status', 404 if isinstance(error, FileNotFoundError) else 409 if isinstance(error, FileExistsError) else 403 if isinstance(error, PermissionError) or isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR) else 400 if isinstance(error, (ValueError, TypeError)) else 503)
        message = str(error) if isinstance(error, Problem) else 'Dosya bulunamadı.' if status == 404 else 'İsim çakışması veya öğe değişikliği var.' if status == 409 else 'Bu yol güvenli şekilde açılamadı veya erişim korumalı.' if status == 403 else 'Dosya işlemi tamamlanamadı.'
        print(json.dumps({'ok': False, 'status': status, 'error': message}, ensure_ascii=False))


if __name__ == '__main__':
    main()
