"""Fixed root-only, metadata-only Linux filesystem capacity and directory usage."""
import json
import ctypes
import os
import pathlib
import re
import socket
import stat
import sys
import time

MAX_SECONDS = 45
MAX_NODES = 5000000
MAX_ENTRIES = 500
MAX_APPLICATIONS = 80
# Block-backed filesystems only. ZFS datasets share pool space and require pool
# accounting; virtual/network filesystems are intentionally outside capacity.
PERSISTENT = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs',
              'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk'}
CAPACITY_FIELDS = ('totalBytes', 'usedBytes', 'freeBytes', 'availableBytes', 'reservedBytes')


def enter_host_mount_namespace():
    """Fixed PID 1 namespace, never a client-supplied namespace or command.

    systemd PrivateTmp gives the service a private view of /tmp. Storage is a
    whole-server metadata view, so only this short-lived root helper joins the
    host mount namespace before it enumerates paths. Failure is fail-closed.
    """
    if os.stat('/proc/self/ns/mnt').st_ino == os.stat('/proc/1/ns/mnt').st_ino:
        return
    descriptor = os.open('/proc/1/ns/mnt', os.O_RDONLY | os.O_CLOEXEC)
    try:
        library = ctypes.CDLL(None, use_errno=True)
        if library.setns(descriptor, 0x00020000) != 0:  # CLONE_NEWNS
            raise OSError(ctypes.get_errno(), 'Host mount namespace unavailable')
    finally:
        os.close(descriptor)


def mount_unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), value)


def parse_mounts(raw):
    result = []
    for line in raw.splitlines():
        try:
            before, after = line.split(' - ', 1)
            fields, extra = before.split(), after.split()
            result.append({'device': fields[2], 'root': mount_unescape(fields[3]),
                           'mount': mount_unescape(fields[4]), 'options': fields[5].split(','),
                           'filesystem': extra[0], 'source': mount_unescape(extra[1])})
        except (ValueError, IndexError):
            continue
    return result


def persistent_mounts(mounts):
    candidates = [item for item in mounts if item['filesystem'] in PERSISTENT
                  and not re.match(r'^/dev/(?:loop|ram)\d', item['source'])]
    # Prefer a complete filesystem over a bind alias. Btrfs subvolumes share
    # statvfs capacity; counting every distinct mount root would multiply it.
    candidates.sort(key=lambda item: (item['root'] != '/', len(item['mount']), item['mount']))
    seen, result = set(), []
    for item in candidates:
        identity = ('btrfs', item['source']) if item['filesystem'] == 'btrfs' else ('device', item['device'])
        if identity in seen:
            continue
        seen.add(identity)
        result.append(item)
    return sorted(result, key=lambda item: (item['mount'] != '/', item['mount']))


def capacity(info):
    block_size = info.f_frsize or info.f_bsize
    total = max(0, info.f_blocks * block_size)
    free = min(total, max(0, info.f_bfree * block_size))
    available = min(free, max(0, info.f_bavail * block_size))
    used = total - free
    return {'totalBytes': total, 'usedBytes': used, 'freeBytes': free,
            'availableBytes': available, 'reservedBytes': free - available,
            'percent': round(used / total * 100, 2) if total else None}


def filesystem_overview(mounts=None, statvfs=None):
    if mounts is None:
        mounts = parse_mounts(pathlib.Path('/proc/self/mountinfo').read_text())
    statvfs = statvfs or os.statvfs
    volumes, failures = [], 0
    for item in persistent_mounts(mounts):
        volume = {key: item[key] for key in ('mount', 'filesystem', 'source')}
        volume['id'] = item['device'] + ':' + item['root']
        try:
            volume.update(capacity(statvfs(item['mount'])))
        except OSError:
            failures += 1
            volume.update({key: None for key in (*CAPACITY_FIELDS, 'percent')})
            volume['reason'] = 'Dosya sistemi kapasitesi okunamadı.'
        volumes.append(volume)
    complete = bool(volumes) and not failures
    summary = {key: sum(volume[key] for volume in volumes) if complete else None for key in CAPACITY_FIELDS}
    total, used = summary['totalBytes'], summary['usedBytes']
    summary.update({'percent': round(used / total * 100, 2) if total else None, 'volumeCount': len(volumes)})
    return {'available': complete, 'sampledAt': time.time() * 1000, 'hostname': socket.gethostname(),
            'summary': summary, 'volumes': volumes,
            **({'reason': 'Kalıcı dosya sistemlerinin tamamı ölçülemedi.'} if not complete else {})}


def valid_path(value):
    if (not isinstance(value, str) or not value.startswith('/') or len(value.encode('utf-8')) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or (value != '/' and (value.endswith('/') or '//' in value))
            or any(part in ('.', '..') for part in value.split('/'))):
        raise ValueError('Geçersiz dizin yolu.')
    return value


def validate_request(request):
    if not isinstance(request, dict) or request.get('action') not in ('overview', 'usage', 'apps'):
        raise ValueError('Geçersiz depolama isteği.')
    action = request['action']
    allowed = {'overview': {'action'}, 'usage': {'action', 'path'}, 'apps': {'action', 'paths'}}[action]
    if set(request) != allowed:
        raise ValueError('Geçersiz depolama alanları.')
    if action == 'usage':
        valid_path(request['path'])
    elif action == 'apps':
        paths = request['paths']
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_APPLICATIONS:
            raise ValueError('Geçersiz uygulama dizinleri.')
        for value in paths:
            valid_path(value)
    return request


def within(value, parent):
    return parent == '/' or value == parent or value.startswith(parent + '/')


def open_directory(value):
    """Open every component without following symlinks, including request root."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open('/', flags)
    try:
        for part in value.split('/'):
            if part:
                next_fd = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = next_fd
        return current
    except Exception:
        os.close(current)
        raise


class ScanLimit(Exception):
    pass


class UsageScanner:
    def __init__(self, mounts, seconds=MAX_SECONDS, max_nodes=MAX_NODES, clock=time.monotonic):
        self.mounts = mounts
        self.mount_paths = {item['mount'] for item in mounts}
        self.clock = clock
        self.deadline = clock() + seconds
        self.max_nodes = max_nodes
        self.nodes = 0
        self.seen = set()
        self.excluded = 0

    def tick(self):
        self.nodes += 1
        if self.nodes > self.max_nodes or self.clock() >= self.deadline:
            raise ScanLimit()
        if self.nodes % 2048 == 0:
            time.sleep(.001)

    def blocks(self, info):
        # Only files with multiple links need inode deduplication. Tracking every
        # ordinary file consumes hundreds of MB on large application trees.
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            identity = (info.st_dev, info.st_ino)
            if identity in self.seen:
                return 0
            self.seen.add(identity)
        # Linux allocated disk blocks, not logical file length (sparse-safe).
        return max(0, info.st_blocks * 512)

    def walk(self, fd, current_path, device, depth=0):
        total = self.blocks(os.fstat(fd))
        partial = False
        if depth >= 256:
            return total, True
        try:
            with os.scandir(fd) as children:
                for child in children:
                    self.tick()
                    child_path = current_path.rstrip('/') + '/' + child.name
                    if child_path in self.mount_paths:
                        self.excluded += 1
                        continue
                    try:
                        info = child.stat(follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode):
                            continue
                        if info.st_dev != device:
                            self.excluded += 1
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            nested = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                            try:
                                # Race checks also stop a directory replaced with a mount.
                                actual = os.fstat(nested)
                                if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                                    partial = True
                                    continue
                                count, incomplete = self.walk(nested, child_path, device, depth + 1)
                                total += count
                                partial |= incomplete
                            finally:
                                os.close(nested)
                        elif stat.S_ISREG(info.st_mode):
                            total += self.blocks(info)
                    except OSError:
                        partial = True
        except (OSError, ScanLimit):
            partial = True
        return total, partial

    def scan(self, value, entries=True):
        valid_path(value)
        containing = max((item for item in self.mounts if within(value, item['mount'])), key=lambda item: len(item['mount']), default=None)
        if not containing or not persistent_mounts([containing]):
            raise ValueError('Bu yol desteklenen kalıcı bir dosya sisteminde değil.')
        fd = open_directory(value)
        try:
            device = os.fstat(fd).st_dev
            if not entries:
                count, partial = self.walk(fd, value, device)
                return {'bytes': count, 'partial': partial, 'excludedMounts': self.excluded}
            total = self.blocks(os.fstat(fd))
            result, partial = [], False
            # Bound enumeration itself; never materialize a huge directory list.
            with os.scandir(fd) as children:
                for child in children:
                    try:
                        self.tick()
                    except ScanLimit:
                        partial = True
                        break
                    if len(result) >= MAX_ENTRIES:
                        partial = True
                        break
                    child_path = value.rstrip('/') + '/' + child.name
                    row = {'name': child.name, 'path': child_path, 'kind': 'directory', 'bytes': None}
                    if child_path in self.mount_paths:
                        self.excluded += 1
                        mounted = [item for item in self.mounts if item['mount'] == child_path]
                        row.update({'mount': True, 'navigable': bool(persistent_mounts(mounted)),
                                    'reason': 'Ayrı bağlı dosya sistemi; bu dizinin toplamına dahil edilmez.'})
                        result.append(row)
                        continue
                    try:
                        info = child.stat(follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                            continue
                        row['kind'] = 'directory' if stat.S_ISDIR(info.st_mode) else 'file'
                        if info.st_dev != device:
                            self.excluded += 1
                            row.update({'mount': True, 'reason': 'Ayrı dosya sistemi; toplam dışında.'})
                        elif row['kind'] == 'file':
                            row['bytes'] = self.blocks(info)
                        else:
                            nested = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                            try:
                                actual = os.fstat(nested)
                                if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                                    raise OSError('Directory changed')
                                row['bytes'], row['partial'] = self.walk(nested, child_path, device)
                            finally:
                                os.close(nested)
                        if row['bytes'] is not None:
                            total += row['bytes']
                        partial |= row.get('partial', False)
                    except OSError:
                        row.update({'partial': True, 'reason': 'Dizin veya dosya metaverisi okunamadı.'})
                        partial = True
                    result.append(row)
            result.sort(key=lambda row: (row['bytes'] is None, -(row['bytes'] or 0), row['name']))
            return {'status': 'ready', 'path': value, 'scannedAt': time.time() * 1000,
                    'partial': partial, 'totalBytes': total, 'entries': result,
                    'excludedMounts': self.excluded,
                    'reason': ('Süre/öğe sınırı veya okunamayan dizinler nedeniyle ölçüm kısmi; gösterilen boyut alt sınırdır. '
                               if partial else '') + 'Ayrı bağlı dosya sistemleri ve sembolik bağlantılar toplam dışında; boyut ayrılmış disk alanıdır.'}
        finally:
            os.close(fd)


def handle_request(request):
    validate_request(request)
    mounts = parse_mounts(pathlib.Path('/proc/self/mountinfo').read_text())
    if request['action'] == 'overview':
        return filesystem_overview(mounts)
    try:
        os.nice(15)
    except OSError:
        pass
    if request['action'] == 'usage':
        return UsageScanner(mounts).scan(request['path'])
    deadline, rows = time.monotonic() + MAX_SECONDS, []
    for value in request['paths']:
        remaining = deadline - time.monotonic()
        row = {'path': value, 'bytes': None, 'partial': True}
        if remaining <= 0:
            row['reason'] = 'Tarama süresi doldu; bu dizin ölçülmedi.'
        else:
            try:
                row.update(UsageScanner(mounts, seconds=min(8, remaining)).scan(value, entries=False))
                if row['partial']:
                    row['reason'] = 'Kısmi ölçüm; gösterilen boyut alt sınırdır.'
                elif row.get('excludedMounts'):
                    row['reason'] = 'Ayrı bağlı dosya sistemleri toplama dahil edilmez.'
            except (OSError, ValueError):
                row['reason'] = 'Dizin yok, sembolik bağlantı veya ölçüm için kullanılamıyor.'
        rows.append(row)
    return {'status': 'ready', 'scannedAt': time.time() * 1000,
            'partial': any(row['partial'] for row in rows), 'applications': rows}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise ValueError('Fixed root-only storage monitor')
        enter_host_mount_namespace()
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('İstek sınırı aşıldı.')
        print(json.dumps(handle_request(json.loads(raw)), ensure_ascii=True))
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        print(json.dumps({'status': 'error', 'available': False, 'error': 'Depolama ölçümü yapılamadı; yol veya erişim kullanılamıyor.'}))
        raise SystemExit(1)
