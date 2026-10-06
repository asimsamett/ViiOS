"""Root-owned, fixed-target lifecycle broker. No client commands, PIDs or units.

sudo permits only the argument-less JSON protocol. --launch is used exclusively
by a separate systemd unit to restore a root-owned process snapshot.
"""
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import select
import signal
import subprocess
import sys
import time

STORE = pathlib.Path('/var/lib/viios-agent/control')
SCRIPT = pathlib.Path(__file__).resolve()
PROTECTED_PORTS = {22, 53, 55734}
PROTECTED_UNITS = {'viios.service', 'all-management.service', 'ssh.service', 'sshd.service',
                   'systemd-resolved.service', 'systemd-networkd.service',
                   'NetworkManager.service', 'docker.service', 'containerd.service',
                   'cron.service', 'dbus.service', 'systemd-logind.service'}


class ControlError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def run(args, timeout=20):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
    if result.returncode:
        # Command output can include service configuration and credentials.
        raise ControlError('Servis komutu tamamlanamadı. Sunucunun servis günlüğünü kontrol edin.')
    return result.stdout


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def listener_map(raw=None):
    ports = {}
    for line in (raw if raw is not None else run(['/usr/bin/ss', '-lntupH'])).splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] not in ('tcp', 'udp'):
            continue
        try:
            port = int(parts[4].rsplit(':', 1)[1])
        except ValueError:
            continue
        pids = {int(pid) for pid in re.findall(r'pid=(\d+)', line)}
        ports.setdefault(port, set()).update(pids or {0})
    return ports


def process(pid):
    base = pathlib.Path('/proc') / str(pid)
    stat = (base / 'stat').read_text().rsplit(')', 1)[1].split()
    cmd = (base / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    exe = os.readlink(base / 'exe')
    cg = (base / 'cgroup').read_text()
    match = re.search(r'/system\.slice/([^/\n]+\.service)(?:/|$)', cg)
    return {'pid': pid, 'ppid': int(stat[1]), 'start': stat[19], 'exe': exe,
            'cmd': [os.fsdecode(a) for a in cmd], 'unit': match[1] if match else None,
            'namespaces': {name: os.readlink(base / 'ns' / name) for name in ('mnt', 'net', 'pid', 'user')},
            'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def unit_info(unit):
    keys = ['Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'TriggeredBy',
            'RefuseManualStop', 'RefuseManualStart', 'Transient']
    raw = run(['/usr/bin/systemctl', 'show', unit, *['--property=' + k for k in keys]])
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def safe_unit(unit):
    return bool(re.fullmatch(r'[A-Za-z0-9_.@:\\-]+\.(service|socket)', unit)) and not unit.startswith('-')


def snapshot(proc):
    base = pathlib.Path('/proc') / str(proc['pid'])
    status = dict(line.split(':', 1) for line in (base / 'status').read_text().splitlines() if ':' in line)
    uids = [int(v) for v in status['Uid'].split()]
    gids = [int(v) for v in status['Gid'].split()]
    if len(set(uids)) != 1 or len(set(gids)) != 1:
        raise ControlError('Bu sürecin kullanıcı yetkileri farklı; önce bir servis tanımı gerekiyor.')
    cwd = os.readlink(base / 'cwd')
    if not os.path.isfile(proc['exe']) or not os.path.isdir(cwd) or not proc['cmd'] or not proc['cmd'][0]:
        raise ControlError('Çalıştırılabilir dosya veya başlatma bilgisi artık mevcut değil.')
    if any(value != os.readlink(pathlib.Path('/proc/1/ns') / key) for key, value in proc['namespaces'].items()):
        raise ControlError('Bu süreç bir konteyner veya özel ortamda çalışıyor; servis tanımı gerekiyor.')
    # Process titles rewritten by runtimes are not reliable executable arguments.
    argv_name, exe_name = os.path.basename(proc['cmd'][0]), os.path.basename(proc['exe'])
    if os.path.realpath(proc['cmd'][0]) != proc['exe'] and not (argv_name.startswith('python') and exe_name.startswith('python')) and argv_name != exe_name:
        raise ControlError('Başlatma komutu doğrulanamadı; bu uygulama için bir servis tanımı gerekiyor.')
    env = {}
    for entry in (base / 'environ').read_bytes().split(b'\0'):
        if b'=' in entry:
            k, v = entry.split(b'=', 1)
            env[os.fsdecode(k)] = os.fsdecode(v)
    return {'kind': 'process', 'exe': proc['exe'], 'argv': proc['cmd'],
            'cwd': cwd, 'uid': uids[0], 'gid': gids[0],
            'groups': [int(v) for v in status.get('Groups', '').split()],
            'umask': int(status.get('Umask', '0022').strip(), 8), 'env': env}


def containers():
    ids = run(['/usr/bin/docker', 'ps', '-q']).split()
    if not ids:
        return []
    result = []
    for item in json.loads(run(['/usr/bin/docker', 'inspect', *ids])):
        ports = sorted({int(b['HostPort']) for binds in item.get('NetworkSettings', {}).get('Ports', {}).values() for b in binds or []})
        result.append({'kind': 'container', 'container': item['Id'], 'name': item['Name'].lstrip('/'), 'ports': ports})
    return result


def disabled(reason, active, affected=None):
    return {'canStop': False, 'canStart': False, 'canRestart': False, 'active': active, 'reason': reason,
            'affectedPorts': affected or [], 'kind': 'protected', 'token': None}


def classify(port, ports, procs, saved, units, docker):
    pids = ports.get(port, set())
    if not pids:
        recipe = saved.get(str(port))
        return recipe, []
    if 0 in pids or any(pid not in procs for pid in pids):
        raise ControlError('Dinleyen süreç bilgisi doğrulanamadı. Yeniden tarayın.')
    records = [procs[pid] for pid in sorted(pids)]
    unit_names = {p['unit'] for p in records}
    if all(os.path.basename(p['exe']) == 'docker-proxy' for p in records):
        matches = [c for c in docker if port in c['ports']]
        if len(matches) != 1:
            raise ControlError('Bu portun Docker konteyneri tekil olarak belirlenemedi.')
        return matches[0], records
    if len(unit_names) == 1 and None not in unit_names:
        unit = records[0]['unit']
        if unit in PROTECTED_UNITS or not safe_unit(unit):
            raise ControlError('Yönetim erişimini veya ortak sistem altyapısını sağlayan servis korunuyor.')
        existing = saved.get(str(port), {})
        if unit.startswith('viios-port-') and existing.get('kind') == 'process':
            recipe = dict(existing)
            recipe['unit'] = unit
        else:
            info = units[unit]
            if info.get('LoadState') != 'loaded' or not info.get('FragmentPath') or info.get('Transient') == 'yes':
                raise ControlError('Bu geçici servisin kalıcı başlatma tanımı bulunmuyor.')
            if info.get('RefuseManualStop') == 'yes' or info.get('RefuseManualStart') == 'yes':
                raise ControlError('Servis tanımı elle başlatma veya durdurmayı engelliyor.')
            sockets = info.get('TriggeredBy', '').split()
            if any(not s.endswith('.socket') or not safe_unit(s) for s in sockets):
                raise ControlError('Servisin otomatik tetikleyicileri nedeniyle doğrudan kontrol desteklenmiyor.')
            recipe = {'kind': 'systemd', 'unit': unit, 'sockets': sockets}
        recipe['ports'] = sorted(p for p, ids in ports.items() if any(procs.get(pid, {}).get('unit') == unit for pid in ids))
        identities = sorted([p for p in procs.values() if p['unit'] == unit], key=lambda p: p['pid'])
        return recipe, identities
    if unit_names != {None}:
        raise ControlError('Bu portu birden fazla servis kullanıyor; tek işlemle kontrol edilemiyor.')
    # Only choose a listener as a root: never stop an SSH session or arbitrary parent.
    roots = [p for p in records if p['ppid'] not in pids]
    if len(roots) != 1:
        raise ControlError('Birbirinden bağımsız süreçler aynı portu kullanıyor; servis tanımı gerekiyor.')
    root = roots[0]
    if root['pid'] <= 1 or os.path.basename(root['exe']) in ('ssh', 'sshd', 'systemd', 'docker', 'containerd'):
        raise ControlError('Uzak erişim veya ortak sistem süreci korunuyor.')
    records = descendants(root['pid'])
    tree_pids = {p['pid'] for p in records}
    if any(p['unit'] in PROTECTED_UNITS or os.path.basename(p['exe']) in ('ssh', 'sshd', 'systemd') for p in records):
        raise ControlError('Süreç ağacında yönetim erişimini sağlayan bir süreç var; kontrol korunuyor.')
    recipe = snapshot(root)
    recipe['ports'] = sorted(p for p, ids in ports.items() if ids & tree_pids)
    recipe['rootPid'] = root['pid']
    recipe['identity'] = digest(root)
    recipe['tree'] = {str(p['pid']): digest(p) for p in records}
    # Recheck after reading the snapshot so a recycled PID cannot become a recipe.
    if digest(process(root['pid'])) != recipe['identity']:
        raise ControlError('Süreç değişti. Yeniden tarayın.')
    return recipe, records


def inspect_all(saved):
    ports = listener_map()
    procs, units = {}, {}
    for pid in {p for ids in ports.values() for p in ids if p}:
        try:
            procs[pid] = process(pid)
        except OSError:
            pass
    for unit in {p['unit'] for p in procs.values() if p['unit']}:
        units[unit] = unit_info(unit)
    docker = containers() if any(os.path.basename(p['exe']) == 'docker-proxy' for p in procs.values()) else []
    controls, targets = {}, {}
    for port in sorted(set(ports) | {int(p) for p in saved}):
        try:
            recipe, identities = classify(port, ports, procs, saved, units, docker)
            if not recipe:
                controls[str(port)] = disabled('Bu port için kayıtlı bir başlatma bilgisi yok.', False)
                continue
            affected = recipe.get('ports', [port])
            if PROTECTED_PORTS.intersection(affected) or recipe.get('unit') in PROTECTED_UNITS:
                raise ControlError('SSH, DNS ve yönetim panelinin erişim portları korunuyor.')
            if not ports.get(port):
                occupied = sorted(p for p in affected if p in ports)
                if occupied:
                    controls[str(port)] = disabled('İlişkili portlar kullanımda: ' + ', '.join(map(str, occupied)), False, affected)
                    continue
                if recipe['kind'] == 'systemd':
                    info = unit_info(recipe['unit'])
                    if info.get('LoadState') != 'loaded':
                        raise ControlError('Kayıtlı servis tanımı artık mevcut değil.')
                    if info.get('ActiveState') in ('active', 'activating', 'deactivating'):
                        raise ControlError('Servis çalışıyor veya geçiş yapıyor; henüz bu portu dinlemiyor.')
                if recipe['kind'] == 'process':
                    try:
                        live = digest(process(recipe['rootPid'])) == recipe['identity']
                    except (OSError, ValueError):
                        live = False
                    if live or (recipe.get('unit') and unit_info(recipe['unit']).get('ActiveState') in ('active', 'activating', 'deactivating')):
                        raise ControlError('Süreç çalışıyor veya geçiş yapıyor; henüz bu portu dinlemiyor.')
                    if not os.path.isfile(recipe['exe']) or not os.path.isdir(recipe['cwd']):
                        raise ControlError('Kayıtlı çalıştırılabilir dosya veya uygulama dizini artık yok.')
            saved[str(port)] = recipe
            token = digest({'recipe': recipe, 'identities': identities, 'active': bool(ports.get(port))})
            controls[str(port)] = {'canStop': bool(ports.get(port)), 'canRestart': bool(ports.get(port)), 'canStart': not bool(ports.get(port)),
                                   'active': bool(ports.get(port)), 'kind': recipe['kind'],
                                   'unit': recipe.get('unit'), 'label': recipe.get('name') or recipe.get('unit') or 'Kayıtlı süreç',
                                   'affectedPorts': affected, 'reason': None, 'token': token}
            targets[str(port)] = (recipe, identities)
        except (ControlError, OSError) as error:
            controls[str(port)] = disabled(str(error) if isinstance(error, ControlError) else 'Süreç bilgisi artık okunamıyor. Yeniden tarayın.', bool(ports.get(port)))
    return controls, targets


def save(records):
    temp = STORE / 'records.tmp'
    with open(temp, 'w', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(records, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, STORE / 'records.json')


def load():
    try:
        return json.loads((STORE / 'records.json').read_text())
    except FileNotFoundError:
        return {}


def descendants(pid):
    parents = {}
    for path in pathlib.Path('/proc').iterdir():
        if path.name.isdigit():
            try:
                stat = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                parents[int(path.name)] = int(stat[1])
            except (OSError, ValueError):
                pass
    selected = {pid}
    while True:
        children = {p for p, parent in parents.items() if parent in selected}
        if children <= selected:
            break
        selected |= children
    return [process(p) for p in sorted(selected) if p in parents]


def stop_process(recipe):
    pid = recipe['rootPid']
    if digest(process(pid)) != recipe['identity']:
        raise ControlError('Süreç kimliği değişti. Hiçbir süreç durdurulmadı; yeniden tarayın.')
    handles = []
    try:
        tree = descendants(pid)
        if {str(p['pid']): digest(p) for p in tree} != recipe['tree'] or not any(p['pid'] == pid and digest(p) == recipe['identity'] for p in tree):
            raise ControlError('Süreç ağacı değişti. Hiçbir süreç durdurulmadı; yeniden tarayın.')
        for p in tree:
            fd = os.pidfd_open(p['pid'])
            handles.append(fd)
            if digest(process(p['pid'])) != digest(p):
                raise ControlError('Süreç ağacı değişti. Yeniden tarayın.')
        for fd in handles:
            try:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            except ProcessLookupError:
                pass
        until = time.monotonic() + 8
        pending = list(handles)
        # Closing a listener can precede database flushes and exit handlers.
        # Wait for process exit before escalating, not just an empty port.
        while pending and time.monotonic() < until:
            exited, _, _ = select.select(pending, [], [], min(.25, max(0, until - time.monotonic())))
            pending = [fd for fd in pending if fd not in exited]
        for fd in handles:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        for fd in handles:
            os.close(fd)


def execute(action, port, recipe):
    if action == 'restart':
        # main holds the same global lock and persists this exact restart recipe
        # before both stages. Never rediscover a replacement target between them.
        try:
            execute('stop', port, recipe)
        except ControlError as error:
            raise ControlError('Yeniden başlatmanın durdurma aşaması tamamlanamadı: ' + str(error), error.status)
        occupied = listener_map()
        if any(p in occupied for p in recipe['ports']):
            raise ControlError('Durdurma sonrası ilgili portlardan biri başka bir süreç tarafından kullanılıyor. Başlatma yapılmadı.')
        try:
            execute('start', port, recipe)
        except ControlError as error:
            raise ControlError('Uygulama durduruldu ancak yeniden açılamadı: ' + str(error), error.status)
        return
    if recipe['kind'] == 'systemd' or (action == 'stop' and recipe.get('unit')):
        units = [*recipe.get('sockets', []), recipe['unit']]
        run(['/usr/bin/systemctl', '--no-block', action, *units])
    elif recipe['kind'] == 'container':
        run(['/usr/bin/docker', action, recipe['container']], timeout=35)
    elif action == 'stop':
        stop_process(recipe)
    else:
        # A separate cgroup survives management-panel restarts. The private recipe
        # also survives host reboots and expiration of this transient unit.
        unit = f'viios-port-{min(recipe["ports"])}.service'
        info = unit_info(unit)
        if info.get('ActiveState') in ('active', 'activating', 'deactivating'):
            raise ControlError('Kayıtlı süreç zaten çalışıyor veya durum değiştiriyor.')
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', unit], capture_output=True)
        run(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit,
             '--property=Restart=no', '--property=TimeoutStopSec=10', '--property=KillMode=control-group',
             '--', '/usr/bin/python3', '-I', str(SCRIPT), '--launch', str(port)])
    until = time.monotonic() + 25
    while time.monotonic() < until:
        current = listener_map()
        if action == 'stop' and not any(p in current for p in recipe['ports']):
            # A closed socket can precede ExecStop/cleanup. Starting the transient
            # unit while its old instance is deactivating would otherwise fail.
            if recipe.get('unit'):
                units = [*recipe.get('sockets', []), recipe['unit']]
                if all(unit_info(unit).get('ActiveState') in ('inactive', 'failed') for unit in units):
                    return
            else:
                return
        if action == 'start' and port in current:
            # Ownership is checked again, not just the presence of any listener.
            pids = current[port]
            live = [process(pid) for pid in pids if pid]
            expected_unit = recipe.get('unit') if recipe['kind'] == 'systemd' else f'viios-port-{min(recipe["ports"])}.service'
            if recipe['kind'] == 'container':
                if any(c['container'] == recipe['container'] and port in c['ports'] for c in containers()):
                    return
            elif live and len(live) == len(pids) and all(p['unit'] == expected_unit for p in live):
                return
            raise ControlError('Portu beklenen uygulama dışında bir süreç kullanıyor.')
        time.sleep(.3)
    raise ControlError('İşlem gönderildi fakat portun beklenen duruma geçtiği doğrulanamadı. Güncel durumu kontrol edin.', 504)


def launch(port):
    recipe = load().get(str(port), {})
    if recipe.get('kind') != 'process':
        raise ControlError('Başlatma kaydı bulunamadı.')
    os.umask(recipe['umask'])
    os.setgroups(recipe['groups'])
    os.setgid(recipe['gid'])
    os.setuid(recipe['uid'])
    os.chdir(recipe['cwd'])
    os.execve(recipe['exe'], recipe['argv'], recipe['env'])


def validate_request(request):
    if not isinstance(request, dict) or set(request) - {'action', 'port', 'token'}:
        raise ControlError('Geçersiz kontrol isteği.', 400)
    if request.get('action') not in ('status', 'stop', 'start', 'restart'):
        raise ControlError('Geçersiz işlem.', 400)
    port = request.get('port')
    if port is not None and (type(port) is not int or not 1 <= port <= 65535):
        raise ControlError('Port 1–65535 arasında olmalı.', 400)
    if request['action'] != 'status' and (port is None or not isinstance(request.get('token'), str) or not re.fullmatch('[a-f0-9]{64}', request['token'])):
        raise ControlError('Güncel uygulama kimliği gerekiyor.', 400)


def main():
    if os.geteuid() != 0:
        raise ControlError('Kontrol yardımcısı root yetkisiyle çalışmalı.', 503)
    os.umask(0o077)
    STORE.mkdir(mode=0o700, exist_ok=True)
    stat = STORE.lstat()
    if STORE.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o077:
        raise ControlError('Kontrol kayıt dizininin izinleri güvenli değil.', 503)
    if len(sys.argv) == 3 and sys.argv[1] == '--launch' and re.fullmatch(r'\d{1,5}', sys.argv[2]):
        launch(int(sys.argv[2]))
        return
    if len(sys.argv) != 1:
        raise ControlError('Geçersiz yardımcı argümanları.', 400)
    request = json.loads(sys.stdin.read(4097))
    validate_request(request)
    with open(STORE / 'lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ControlError('Başka bir servis işlemi sürüyor. Birkaç saniye sonra tekrar deneyin.')
        saved = load()
        controls, targets = inspect_all(saved)
        save(saved)
        port = request.get('port')
        if request['action'] == 'status':
            return {'ok': True, 'controls': controls} if port is None else {'ok': True, 'control': controls.get(str(port), disabled('Başlatma kaydı bulunamadı.', False))}
        control = controls.get(str(port), {})
        capability = {'stop': 'canStop', 'start': 'canStart', 'restart': 'canRestart'}[request['action']]
        if not control.get(capability):
            raise ControlError(control.get('reason') or 'Uygulama durumu bu işleme uygun değil.')
        if not hmac.compare_digest(request['token'], control.get('token', '')):
            raise ControlError('Uygulamanın durumu değişti. Ayrıntıları yenileyip tekrar deneyin.')
        recipe, _identities = targets[str(port)]
        execute(request['action'], port, recipe)
        controls, _targets = inspect_all(saved)
        save(saved)
        result_text = {'stop': 'durduruldu; port kapalı.', 'start': 'başlatıldı; port dinliyor.', 'restart': 'yeniden başlatıldı; port dinliyor.'}
        return {'ok': True, 'control': controls[str(port)], 'affectedPorts': recipe['ports'],
                'message': f':{port} uygulaması ' + result_text[request['action']]}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except ControlError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'status': error.status}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'Servis kontrolü tamamlanamadı. Sunucu bağlantısını ve yardımcı kurulumunu kontrol edin.', 'status': 503}, ensure_ascii=False))
