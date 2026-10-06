"""Fixed ACL broker. Never executes Git or changes file ownership/content.

Every filesystem operation uses open, no-follow descriptors. Permission receipts
are root-owned and preserve original ACLs. Only explicit prepare requests mutate.
"""
import base64
import contextlib
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import struct
import sys
import time
import uuid

APP = Path(__file__).resolve().parent
CONFIG = APP / 'versioning.json'
STORE = Path('/var/lib/viios-agent/version-access')
ACCOUNT = 'viios-agent'
MAX_FILES = 100000
spec = importlib.util.spec_from_file_location('versioning_policy', Path(__file__).with_name('versioning_policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
ACCESS = 'system.posix_acl_access'
DEFAULT = 'system.posix_acl_default'
UNDEFINED = 0xffffffff
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class Problem(Exception):
    def __init__(self, message, status=400, code=None):
        super().__init__(message)
        self.status = status
        self.code = code

    def response(self):
        return {'error': str(self), 'status': self.status, **({'code': self.code} if self.code else {})}


def acl_problem(error):
    # Only callers of the POSIX ACL xattr operations use this classification.
    # A generic path, Git or policy permission failure is not an ACL failure.
    if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
        return Problem('Bu dosya sistemi ACL erişim izinlerini desteklemiyor. Bu klasör için erişim hazırlığı tamamlanamadı.', 501, 'ACL_UNSUPPORTED')
    if error.errno in (errno.EACCES, errno.EPERM):
        return Problem('ACL erişim izinleri okunamadı veya güncellenemedi. Bu klasör üzerindeki izinleri kontrol edin.', 403, 'ACL_ACCESS_DENIED')
    return Problem('ACL erişim izinleri işlenemedi. Klasörü yeniden inceleyerek izinlerin durumunu kontrol edin.', 409, 'ACL_UPDATE_FAILED')


def settings():
    value = json.loads(CONFIG.read_text())
    if not value.get('enabled'):
        raise Problem('Sürüm yönetimi kapalı.', 403)
    return value


def get_acl(fd, name):
    try:
        return os.getxattr(fd, name)
    except OSError as error:
        if error.errno == errno.ENODATA:
            return None
        raise acl_problem(error) from error


def set_acl(fd, name, value):
    try:
        os.setxattr(fd, name, value)
    except OSError as error:
        raise acl_problem(error) from error


def remove_acl(fd, name):
    try:
        os.removexattr(fd, name)
    except OSError as error:
        if error.errno != errno.ENODATA:
            raise acl_problem(error) from error


def entries(raw, mode):
    if not raw:
        return [(1, (mode >> 6) & 7, UNDEFINED), (4, (mode >> 3) & 7, UNDEFINED), (32, mode & 7, UNDEFINED)]
    if len(raw) < 4 or struct.unpack('<I', raw[:4])[0] != 2 or (len(raw) - 4) % 8:
        raise Problem('Dosya erişim kaydı çözümlenemedi.', 409)
    return list(struct.iter_unpack('<HHI', raw[4:]))


def effective(raw, info, uid, groups):
    values = entries(raw, info.st_mode)
    mask = next((perm for tag, perm, _ in values if tag == 16), 7)
    if info.st_uid == uid:
        return next(perm for tag, perm, _ in values if tag == 1)
    named = next((perm for tag, perm, ident in values if tag == 2 and ident == uid), None)
    if named is not None:
        return named & mask
    matched = [perm for tag, perm, ident in values if (tag == 4 and info.st_gid in groups) or (tag == 8 and ident in groups)]
    if matched:
        result = 0
        for perm in matched:
            result |= perm
        return result & mask
    return next(perm for tag, perm, _ in values if tag == 32)


def expanded_acl(raw, mode, uid, rights):
    values = entries(raw, mode)
    old_mask = next((perm for tag, perm, _ in values if tag == 16), 7)
    # Preserve the effective permissions of every other named user/group.
    values = [(tag, perm & old_mask if tag in (2, 4, 8) else perm, ident) for tag, perm, ident in values if tag != 16]
    old = next((perm for tag, perm, ident in values if tag == 2 and ident == uid), 0)
    values = [entry for entry in values if not (entry[0] == 2 and entry[2] == uid)]
    values.append((2, old | rights, uid))
    mask = 0
    for tag, perm, _ in values:
        if tag in (2, 4, 8):
            mask |= perm
    values.append((16, mask, UNDEFINED))
    values.sort(key=lambda entry: (entry[0], entry[2]))
    return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in values)


@contextlib.contextmanager
def opened(path):
    fd = os.open('/', FLAGS | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:]):
            extra = os.O_DIRECTORY if index < len(path.parts[1:]) - 1 else 0
            child = os.open(part, FLAGS | extra, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def walk(fd, relative=Path('.'), extra=()):
    yield relative, fd
    with os.scandir(fd) as iterator:
        names = sorted((entry.name, entry.is_dir(follow_symlinks=False)) for entry in iterator)
    for name, directory in names:
        child_relative = relative / name
        if '.git' not in child_relative.parts and policy.excluded(child_relative, directory, extra):
            continue
        child = os.open(name, FLAGS | (os.O_DIRECTORY if directory else 0), dir_fd=fd)
        try:
            info = os.fstat(child)
            if stat.S_ISDIR(info.st_mode):
                if name == '.git' and relative != Path('.'):
                    raise Problem('İç içe Git depoları ayrı projeler olarak eklenmeli.', 409)
                yield from walk(child, child_relative, extra)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                yield child_relative, child
            else:
                raise Problem('Proje kapsamında hardlink veya özel dosya bulunuyor.', 403)
        finally:
            os.close(child)


def encoded(value):
    return base64.b64encode(value).decode() if value is not None else None


def snapshot(fd, path, rights):
    info = os.fstat(fd)
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'mtime': info.st_mtime_ns, 'size': info.st_size, 'directory': stat.S_ISDIR(info.st_mode),
            'access': encoded(get_acl(fd, ACCESS)),
            'default': encoded(get_acl(fd, DEFAULT)) if stat.S_ISDIR(info.st_mode) else None,
            'rights': rights}


def collect(value):
    config = settings()
    try:
        selected = policy.checked_path(value, config)
        root, exists = policy.find_root(selected, config)
    except ValueError as error:
        raise Problem(str(error), 403)
    account = pwd.getpwnam(ACCOUNT)
    groups = os.getgrouplist(ACCOUNT, account.pw_gid)
    records = []
    needed = False
    size = 0
    # Ancestors receive traversal only if this selected project needs it.
    for parent in reversed(root.parents):
        with opened(parent) as fd:
            info = os.fstat(fd)
            raw = get_acl(fd, ACCESS)
            if not effective(raw, info, account.pw_uid, groups) & 1:
                records.append(snapshot(fd, parent, 1))
                needed = True
    with opened(root) as root_fd:
        for relative, fd in walk(root_fd, extra=policy.project_excludes(root, config)):
            info = os.fstat(fd)
            rights = 7 if stat.S_ISDIR(info.st_mode) else 6 | (1 if info.st_mode & 0o111 else 0)
            row = snapshot(fd, root / relative, rights)
            records.append(row)
            raw = base64.b64decode(row['access']) if row['access'] is not None else None
            needed = needed or (effective(raw, info, account.pw_uid, groups) & rights != rights)
            if not row['directory']:
                size += info.st_size
            if len(records) > MAX_FILES or size > 10 * 1024 * 1024 * 1024:
                raise Problem('Proje çok geniş. Alt proje klasörünü seçin veya bağımlılık/veri klasörlerini ayırın.', 413)
    revision = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    return {'path': str(root), 'selectedPath': str(selected), 'name': root.name, 'exists': exists,
            'needsAccess': bool(needed), 'accessRevision': revision, 'owner': str(root.stat().st_uid),
            'entryCount': len(records), 'sourceBytes': size, 'ignore': policy.project_excludes(root, config)}, records, account.pw_uid


def same_inode(fd, record):
    info = os.fstat(fd)
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid) == (record['device'], record['inode'], record['uid'], record['gid'])


def apply_record(fd, record, uid):
    if not same_inode(fd, record):
        raise Problem('Klasör içeriği değişti. Yeniden inceleyin.', 409)
    current = get_acl(fd, ACCESS)
    if record['uid'] == uid:
        os.fchmod(fd, record['mode'] | record['rights'] << 6)
    else:
        set_acl(fd, ACCESS, expanded_acl(current, record['mode'], uid, record['rights']))
    # Only project directories get inheritance; ancestors keep traversal-only access.
    if record['directory'] and record['rights'] == 7:
        set_acl(fd, DEFAULT, expanded_acl(get_acl(fd, DEFAULT), record['mode'], uid, 7))
    record['afterAccess'] = encoded(get_acl(fd, ACCESS))
    record['afterDefault'] = encoded(get_acl(fd, DEFAULT)) if record['directory'] else None
    record['afterMode'] = stat.S_IMODE(os.fstat(fd).st_mode)


def restore_records(records):
    # Never overwrite permission changes made after the grant.
    for record in records:
        required = ('afterAccess', 'afterMode', 'afterDefault') if record['directory'] else ('afterAccess', 'afterMode')
        if record.get('stateVerified') is False or any(key not in record for key in required):
            raise Problem('Bazı izin değişikliklerinin son durumu doğrulanamadı. Ek izinler kısmen değişmiş olabilir; otomatik geri yükleme yapılmadı. Klasörü yeniden inceleyin.', 409, 'ACL_UPDATE_FAILED')
        with opened(Path(record['path'])) as fd:
            if not same_inode(fd, record) or encoded(get_acl(fd, ACCESS)) != record['afterAccess'] or (record['directory'] and encoded(get_acl(fd, DEFAULT)) != record['afterDefault']) or stat.S_IMODE(os.fstat(fd).st_mode) != record['afterMode']:
                raise Problem('İzinler sonradan değişmiş; eski izinler otomatik uygulanmadı.', 409)
    for record in reversed(records):
        with opened(Path(record['path'])) as fd:
            for attr, key in [(ACCESS, 'access')] + ([(DEFAULT, 'default')] if record['directory'] else []):
                if record[key] is not None:
                    set_acl(fd, attr, base64.b64decode(record[key]))
                else:
                    remove_acl(fd, attr)
            os.fchmod(fd, record['mode'])


def dispatch(request):
    if request.get('action') not in ('inspect', 'prepare', 'restore-access'):
        raise Problem('Geçersiz erişim işlemi.')
    if request['action'] == 'restore-access':
        ident = request.get('receipt', '')
        if len(ident) != 32 or any(c not in '0123456789abcdef' for c in ident):
            raise Problem('Geçersiz izin yedeği.')
        record = json.loads((STORE / (ident + '.json')).read_text())
        restore_records(record['records'])
        return {'restored': True, 'path': record['path']}
    summary, records, uid = collect(request.get('path'))
    if request['action'] == 'inspect':
        return summary
    if request.get('revision') != summary['accessRevision']:
        raise Problem('Proje dosyaları veya izinleri değişti. Yeniden inceleyin.', 409)
    receipt = uuid.uuid4().hex
    file = STORE / (receipt + '.json')
    record = {'path': summary['path'], 'createdAt': time.time(), 'records': records, 'complete': False}
    def persist():
        with file.open('w') as output:
            output.write(json.dumps(record))
            output.flush()
            os.fsync(output.fileno())
    persist()
    applied, attempted = [], []
    try:
        for item in records:
            with opened(Path(item['path'])) as fd:
                attempted.append(item)
                try:
                    apply_record(fd, item, uid)
                finally:
                    try:
                        if not same_inode(fd, item):
                            raise Problem('İzin işlemi sırasında dosya kimliği değişti.', 409)
                        after = {'afterAccess': encoded(get_acl(fd, ACCESS)),
                                 'afterDefault': encoded(get_acl(fd, DEFAULT)) if item['directory'] else None,
                                 'afterMode': stat.S_IMODE(os.fstat(fd).st_mode)}
                    except Exception as error:
                        # Preserve original permissions in the receipt, but never
                        # restore blindly when the post-write state is unknown.
                        item['stateVerified'] = False
                        raise Problem('ACL işlemi sonrası izinler doğrulanamadı. Ek izinler kısmen değişmiş olabilir; klasörü yeniden inceleyin.', 409, 'ACL_UPDATE_FAILED') from error
                    item.update(after)
                    item['stateVerified'] = True
                    applied.append(item)
        record['complete'] = True
    except Exception as error:
        record['records'] = attempted
        persist()
        try:
            restore_records(applied)
            record['rollbackComplete'] = len(applied) == len(attempted)
        except Exception as rollback_error:
            record['rollbackComplete'] = False
            code = error.code if isinstance(error, Problem) and error.code in ('ACL_UNSUPPORTED', 'ACL_ACCESS_DENIED', 'ACL_UPDATE_FAILED') else 'ACL_UPDATE_FAILED'
            raise Problem('İzin işlemi tamamlanamadı ve önceki izinlerin tümü geri yüklenemedi. Ek izinler kısmen değişmiş olabilir; klasörü yeniden inceleyin.', error.status if isinstance(error, Problem) else 409, code) from rollback_error
        if len(applied) != len(attempted):
            raise Problem('Bazı ACL değişikliklerinin son durumu doğrulanamadı. Doğrulanabilen önceki izinler geri alındı; ek izinler kısmen değişmiş olabilir. Klasörü yeniden inceleyin.', 409, 'ACL_UPDATE_FAILED') from error
        raise
    finally:
        persist()
    return {**summary, 'needsAccess': False, 'accessReceipt': receipt}


def main():
    os.umask(0o077)
    def timeout(_signal, _frame):
        raise Problem('Erişim işlemi zaman aşımına uğradı. Yeniden inceleyin.', 503)
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(120)
    try:
        if os.geteuid() != 0:
            raise Problem('Erişim yardımcısı yönetim yetkisi gerektiriyor.', 403)
        STORE.mkdir(mode=0o700, parents=True, exist_ok=True)
        if STORE.is_symlink() or STORE.stat().st_uid != 0:
            raise Problem('İzin yedeği alanı güvenli değil.', 403)
        with (STORE / 'operation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = dispatch(json.loads(sys.stdin.buffer.read(16385)))
    except Problem as error:
        result = error.response()
    except Exception:
        result = {'error': 'Proje erişimi hazırlanamadı. Klasörü tekrar inceleyin.', 'status': 409}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
