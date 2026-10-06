"""Fixed JSON-only Linux process helper. No command lines or environments leave it."""
import datetime
import hashlib
import json
import os
import pathlib
import re
import runpy
import select
import signal
import sys
import time


class ProcessError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate(request):
    if not isinstance(request, dict) or request.get('action') not in ('list', 'details', 'terminate'):
        raise ProcessError('Invalid process action.')
    fields = {'list': {'action'}, 'details': {'action', 'pid'}, 'terminate': {'action', 'pid', 'token'}}[request['action']]
    if set(request) != fields:
        raise ProcessError('Invalid process fields.')
    if request['action'] != 'list' and (type(request['pid']) is not int or not 1 <= request['pid'] <= 2147483647):
        raise ProcessError('Invalid PID.')
    if request['action'] == 'terminate' and not re.fullmatch('[a-f0-9]{64}', str(request['token'])):
        raise ProcessError('Invalid process identity.')
    return request


def identity(pid, started, boot):
    return hashlib.sha256(f'{boot}:{pid}:{started}'.encode()).hexdigest()


def protected(pid, name, cgroup, ancestors):
    return pid <= 1 or pid in ancestors or name in {'sshd', 'systemd', 'init', 'sudo'} or '.service' in cgroup


def snapshot(helpers):
    rows = {}
    for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
        try:
            row = helpers['parse_process'](path.read_text(), os.sysconf('SC_PAGE_SIZE'))
            rows[row['pid']] = row
        except (OSError, ValueError, IndexError):
            continue
    return rows


def context():
    helpers = runpy.run_path(str(pathlib.Path(__file__).with_name('resources.py')))
    before = snapshot(helpers)
    first_cpu = helpers['host_cpu']()
    time.sleep(.65)
    after = snapshot(helpers)
    delta = helpers['host_cpu']()['total'] - first_cpu['total']
    boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    boot_seconds = time.time() - float(pathlib.Path('/proc/uptime').read_text().split()[0])
    ancestors, cursor = set(), os.getpid()
    while cursor in after and cursor not in ancestors:
        ancestors.add(cursor)
        cursor = after[cursor]['parent']
    return helpers, before, after, delta, boot, boot_seconds, ancestors


def process_row(item, ctx):
    import pwd
    helpers, before, _, delta, boot, boot_seconds, ancestors = ctx
    pid = item['pid']
    directory = pathlib.Path('/proc') / str(pid)
    uid = directory.stat().st_uid
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = str(uid)
    cgroup = directory.joinpath('cgroup').read_text()
    blocked = protected(pid, item['name'], cgroup, ancestors) or item['parent'] == 2 or item['state'] in ('Z', 'X')
    safe_signal = hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
    return {'pid': pid, 'name': item['name'], 'user': user, 'state': item['state'],
            'parentPid': item['parent'], 'cpuPercent': helpers['cpu_percent'](before.get(pid), item, delta),
            'memoryBytes': item['rss'], 'startedAt': datetime.datetime.fromtimestamp(boot_seconds + item['started'] / os.sysconf('SC_CLK_TCK'), datetime.timezone.utc).isoformat(),
            'token': identity(pid, item['started'], boot), 'canTerminate': not blocked and safe_signal,
            'reason': 'System, service or management process is protected.' if blocked else 'Safe process handles are unavailable.' if not safe_signal else ''}


def terminate(request, ctx):
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ProcessError('Safe process termination is unavailable on this kernel/Python.', 501)
    pid = request['pid']
    # Pin the kernel process object before re-reading identity. Never fall back
    # to os.kill(pid): a PID may be reused after checking the start time.
    handle = os.pidfd_open(pid)
    try:
        item = ctx[0]['parse_process'](pathlib.Path(f'/proc/{pid}/stat').read_text(), os.sysconf('SC_PAGE_SIZE'))
        row = process_row(item, ctx)
        if row['token'] != request['token']:
            raise ProcessError('Process identity changed; refresh the list.', 409)
        if not row['canTerminate']:
            raise ProcessError(row['reason'], 403)
        signal.pidfd_send_signal(handle, signal.SIGTERM)
        watcher = select.poll()
        watcher.register(handle, select.POLLIN)
        exited = bool(watcher.poll(1500))
        return {'ok': True, 'exited': exited, 'message': 'Process exited.' if exited else 'Termination requested; refresh to verify exit.'}
    finally:
        os.close(handle)


def dispatch(request):
    validate(request)
    ctx = context()
    if request['action'] == 'terminate':
        return terminate(request, ctx)
    rows = []
    items = list(ctx[2].values())[:10000] if request['action'] == 'list' else [ctx[2][request['pid']]] if request['pid'] in ctx[2] else []
    for item in items:
        if request['action'] == 'details' and item['pid'] != request['pid']:
            continue
        try:
            rows.append(process_row(item, ctx))
        except (OSError, ValueError):
            continue
    if request['action'] == 'details':
        if not rows:
            raise ProcessError('Process exited or cannot be inspected.', 404)
        return {'ok': True, 'process': rows[0]}
    return {'ok': True, 'available': True, 'platform': 'linux', 'sampledAt': int(time.time() * 1000), 'processes': rows, 'partial': len(ctx[2]) > 10000}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise ProcessError('Fixed root-only helper.', 403)
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ProcessError('Request too large.', 413)
        print(json.dumps(dispatch(json.loads(raw.decode('utf-8')))))
    except ProcessError as error:
        print(json.dumps({'ok': False, 'status': error.status, 'error': str(error)}))
    except (FileNotFoundError, ProcessLookupError):
        print(json.dumps({'ok': False, 'status': 404, 'error': 'Process no longer exists.'}))
    except Exception:
        print(json.dumps({'ok': False, 'status': 503, 'error': 'Process operation unavailable; check target permissions.'}))
