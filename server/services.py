"""Root-owned systemd service adapter. Fixed JSON protocol; no shell commands."""
import hashlib
import json
import os
import pathlib
import re
import select
import stat
import subprocess
import sys
import time

POLICY = pathlib.Path('/var/lib/viios-agent/services.json')
PROTECTED = {'ssh.service', 'sshd.service', 'viios.service', 'all-management.service', 'NetworkManager.service', 'networking.service', 'docker.service', 'containerd.service', 'dbus.service', 'cron.service', 'firewalld.service', 'ufw.service', 'auditd.service'}
PROPERTIES = 'Id Description LoadState ActiveState SubState UnitFileState MainPID FragmentPath InvocationID RefuseManualStart RefuseManualStop Transient Requires Wants Requisite BindsTo RequiredBy BoundBy ConsistsOf PropagatesStopTo TriggeredBy'.split()
ACTIONS = {'start', 'stop', 'restart', 'enable', 'disable'}


class ServiceError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def valid_name(name):
    return isinstance(name, str) and len(name) <= 255 and bool(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:\\-]*\.service', name))


def validate(request):
    if not isinstance(request, dict) or request.get('action') not in ACTIONS | {'list', 'details', 'logs'}:
        raise ServiceError('Unsupported service action.')
    action = request['action']
    fields = {'action'} if action == 'list' else {'action', 'name', 'limit'} if action == 'logs' else {'action', 'name'} if action == 'details' else {'action', 'name', 'token'}
    if set(request) != fields or (action != 'list' and not valid_name(request['name'])):
        raise ServiceError('Invalid service fields.')
    if action == 'logs' and (type(request['limit']) is not int or not 1 <= request['limit'] <= 200):
        raise ServiceError('Invalid log limit.')
    if action in ACTIONS and (not isinstance(request['token'], str) or not re.fullmatch('[a-f0-9]{64}', request['token'])):
        raise ServiceError('Invalid service identity.')
    return request


def run(args, timeout=20):
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'SYSTEMD_COLORS': '0'})
    out = bytearray()
    deadline = time.monotonic() + timeout
    try:
        while True:
            if time.monotonic() > deadline:
                raise ServiceError('Service operation timed out; refresh state.', 504)
            if select.select([child.stdout], [], [], .2)[0]:
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                out.extend(chunk)
                if len(out) > 4 * 1024 * 1024:
                    raise ServiceError('Service response limit exceeded.', 503)
        if child.wait(timeout=max(.1, deadline-time.monotonic())) != 0:
            raise ServiceError('Service operation failed; refresh state and check permissions.', 503)
        return out.decode('utf-8', errors='replace')
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()


def policy():
    try:
        parent = POLICY.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
            raise ServiceError('Untrusted service policy directory.', 403)
        fd = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return set()
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 16384:
            raise ServiceError('Untrusted service policy.', 403)
        data = json.load(stream)
    names = data.get('allowedServices', [])
    if not isinstance(names, list) or len(names) > 200 or any(not valid_name(name) for name in names):
        raise ServiceError('Invalid service policy.', 503)
    return set(names)


def parse_show(raw):
    return [dict(line.split('=', 1) for line in block.splitlines() if '=' in line) for block in raw.strip().split('\n\n') if block.strip()]


def inspect(names):
    if not names:
        return []
    return parse_show(run(['/usr/bin/systemctl', 'show', '--no-pager', '--property='+','.join(PROPERTIES), '--', *names]))


def protected_names():
    names = set(PROTECTED)
    # Include the helper's actual management/SSH service, even if renamed.
    cursor, seen = os.getpid(), set()
    while cursor > 0 and cursor not in seen:
        seen.add(cursor)
        base = pathlib.Path('/proc') / str(cursor)
        try:
            names.update(re.findall(r'/([^/\n]+\.service)(?:/|$)', (base/'cgroup').read_text()))
            cursor = int((base/'stat').read_text().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            raise ServiceError('Management service protection could not be determined.', 503)
    return names


def row(info, allowed, protected):
    name = info.get('Id', '')
    reason = ''
    if name in protected or name.startswith(('systemd-', 'viios-', 'ssh', 'dbus')):
        reason = 'System or management service is protected.'
    elif name not in allowed:
        reason = 'Administrator service allowlist required.'
    elif info.get('LoadState') != 'loaded' or not info.get('FragmentPath') or info.get('Transient') == 'yes' or '@.service' in name:
        reason = 'Only installed persistent service instances can be managed.'
    elif info.get('ActiveState') not in ('active', 'inactive', 'failed') or info.get('SubState') in ('auto-restart', 'start', 'stop', 'stop-sigterm', 'stop-sigkill'):
        reason = 'Service is changing state.'
    dependencies = sorted(set(' '.join(info.get(key, '') for key in ('Requires', 'Wants', 'Requisite', 'BindsTo')).split()))
    dependents = sorted(set(' '.join(info.get(key, '') for key in ('RequiredBy', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo')).split()))
    actions = []
    if not reason:
        if info.get('ActiveState') != 'active' and info.get('RefuseManualStart') != 'yes' and info.get('UnitFileState') not in ('masked', 'masked-runtime'):
            actions.append('start')
        if info.get('ActiveState') == 'active' and info.get('RefuseManualStop') != 'yes' and not info.get('TriggeredBy'):
            actions.append('stop')
            if info.get('RefuseManualStart') != 'yes':
                actions.append('restart')
        if info.get('UnitFileState') == 'disabled':
            actions.append('enable')
        if info.get('UnitFileState') in ('enabled', 'enabled-runtime'):
            actions.append('disable')
    token = hashlib.sha256(json.dumps(info, sort_keys=True).encode()).hexdigest()
    try:
        pid = int(info.get('MainPID', '0'))
    except ValueError:
        pid = 0
    return {'name': name, 'displayName': info.get('Description', name), 'description': info.get('Description', ''), 'state': info.get('ActiveState', 'unknown'), 'subState': info.get('SubState', ''), 'startup': info.get('UnitFileState', 'unknown'), 'pid': pid, 'token': token, 'actions': actions, 'reason': reason, 'dependencies': dependencies, 'dependents': dependents, 'canLogs': True}


def get_one(name):
    values = inspect([name])
    if len(values) != 1 or values[0].get('LoadState') == 'not-found':
        raise ServiceError('Service not found.', 404)
    if values[0].get('Id') != name:
        raise ServiceError('Use the canonical service name.', 409)
    return values[0]


def dependency_guard(info, action):
    # No automatic dependency starts or stop cascades. Inspect non-service units too.
    keys = ('Requires', 'Wants', 'Requisite', 'BindsTo') if action == 'start' else ('RequiredBy', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo')
    names = sorted(set(' '.join(info.get(key, '') for key in keys).split()))
    if any(not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:\\-]*\.(service|target|socket|mount|automount|path|timer|swap|slice|scope|device)', name) for name in names) or len(names) > 200:
        raise ServiceError('Dependency graph cannot be safely inspected.', 409)
    for dependency in inspect(names):
        active = dependency.get('ActiveState') == 'active'
        if (action == 'start' and not active) or (action != 'start' and dependency.get('ActiveState') not in ('inactive', 'failed')):
            raise ServiceError('Manage service dependencies separately.', 409)
    if action == 'restart':
        dependency_guard(info, 'start')


def logs(name, limit):
    get_one(name)
    raw = run(['/usr/bin/journalctl', '--unit='+name, '--lines='+str(limit), '--since=-24h', '--no-pager', '--output=json', '--output-fields=__REALTIME_TIMESTAMP,PRIORITY,MESSAGE'])
    entries = []
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
            if not isinstance(entry.get('MESSAGE'), str):
                continue
            entries.append({'at': int(entry['__REALTIME_TIMESTAMP'])//1000, 'priority': int(entry.get('PRIORITY', 6)), 'message': entry['MESSAGE'][:4096]})
        except (ValueError, TypeError, KeyError):
            continue
    return {'ok': True, 'available': True, 'entries': entries[-limit:]}


def dispatch(request):
    validate(request)
    if not pathlib.Path('/run/systemd/system').is_dir():
        raise ServiceError('systemd is unavailable.', 501)
    allowed, protected = policy(), protected_names()
    action = request['action']
    if action == 'list':
        names = set()
        for command in ('list-units', 'list-unit-files'):
            raw = run(['/usr/bin/systemctl', command, '--type=service', '--all', '--no-legend', '--plain', '--no-pager'])
            names.update(line.split()[0] for line in raw.splitlines() if line.split() and valid_name(line.split()[0]))
        ordered = sorted(names)[:2000]
        infos = []
        for offset in range(0, len(ordered), 100):
            infos.extend(inspect(ordered[offset:offset+100]))
        unique = {info['Id']: info for info in infos if valid_name(info.get('Id'))}
        return {'ok': True, 'available': True, 'platform': 'linux', 'sampledAt': int(time.time()*1000), 'partial': len(names)>2000, 'services': [row(info, allowed, protected) for info in unique.values()]}
    if action == 'logs':
        return logs(request['name'], request['limit'])
    if action == 'details':
        return {'ok': True, 'service': row(get_one(request['name']), allowed, protected)}
    # Parent policy directory has already been verified; mutation requires a policy.
    if request['name'] not in allowed:
        raise ServiceError('Service is not allowlisted.', 403)
    import fcntl
    fd = os.open(POLICY.parent/'services.lock', os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != 0 or lock_info.st_nlink != 1 or lock_info.st_mode & 0o022:
            raise ServiceError('Untrusted service lock.', 403)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise ServiceError('Another service operation is running.', 409)
        info = get_one(request['name'])
        current = row(info, policy(), protected_names())
        if current['token'] != request['token']:
            raise ServiceError('Service changed; refresh details.', 409)
        if action not in current['actions']:
            raise ServiceError('Service operation is protected.', 403)
        if action in ('start', 'stop', 'restart'):
            dependency_guard(info, action)
        # fail refuses conflicting jobs; dependency guards run before lifecycle changes.
        # --no-ask-password ensures no interactive privilege prompt on remote targets.
        args = ['/usr/bin/systemctl', '--no-ask-password']
        if action in ('start', 'stop', 'restart'):
            args.append('--job-mode=fail')
        run([*args, action, '--', request['name']], timeout=25)
        updated = get_one(request['name'])
        expected = {'start': ('ActiveState', 'active'), 'stop': ('ActiveState', 'inactive'), 'restart': ('ActiveState', 'active'), 'enable': ('UnitFileState', 'enabled'), 'disable': ('UnitFileState', 'disabled')}[action]
        if updated.get(expected[0]) != expected[1]:
            raise ServiceError('Resulting service state not confirmed; refresh details.', 409)
        return {'ok': True, 'service': row(updated, policy(), protected_names())}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise ServiceError('Root-only fixed helper.', 403)
        raw = sys.stdin.buffer.read(8193)
        if len(raw)>8192:
            raise ServiceError('Request too large.', 413)
        print(json.dumps(dispatch(json.loads(raw))))
    except ServiceError as error:
        print(json.dumps({'ok': False, 'status': error.status, 'error': str(error)}))
    except Exception:
        print(json.dumps({'ok': False, 'status': 503, 'error': 'Service operation unavailable; check permissions and configuration.'}))
