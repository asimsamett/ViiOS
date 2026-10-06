"""Fixed, read-only Linux resource sampler. No arguments, commands or PIDs from clients."""
import json
import os
import pathlib
import re
import runpy
import socket
import subprocess
import sys
import time


def parse_process(raw, page_size):
    end = raw.rfind(')')
    start = raw.index('(')
    fields = raw[end + 2:].split()
    return {'pid': int(raw[:start].strip()), 'name': raw[start + 1:end][:100], 'state': fields[0],
            'parent': int(fields[1]), 'ticks': int(fields[11]) + int(fields[12]),
            'started': int(fields[19]), 'rss': max(0, int(fields[21])) * page_size}


def processes():
    result = {}
    page_size = os.sysconf('SC_PAGE_SIZE')
    for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
        try:
            item = parse_process(path.read_text(), page_size)
            if item['state'] not in ('Z', 'X'):
                result[item['pid']] = item
        except (OSError, ValueError, IndexError):
            continue
    return result


def cpu_totals(raw):
    values = list(map(int, raw.split()[1:9]))  # guest counters are already included in user/nice.
    return {'total': sum(values), 'idle': values[3] + (values[4] if len(values) > 4 else 0)}


def host_cpu():
    return cpu_totals(pathlib.Path('/proc/stat').read_text().splitlines()[0])


def cpu_percent(before, after, total_delta):
    if not before or not after or before['started'] != after['started'] or total_delta <= 0:
        return None
    delta = after['ticks'] - before['ticks']
    return round(max(0, min(100, delta / total_delta * 100)), 2) if delta >= 0 else None


def memory(raw):
    values = {}
    for line in raw.splitlines():
        key, value = line.split(':', 1)
        values[key] = int(value.split()[0]) * 1024
    total, available = values.get('MemTotal'), values.get('MemAvailable')
    used = max(0, total - available) if total and available is not None else None
    swap_total = values.get('SwapTotal', 0)
    return {'totalBytes': total, 'usedBytes': used, 'availableBytes': available,
            'percent': round(used / total * 100, 2) if used is not None and total else None,
            'swapTotalBytes': swap_total, 'swapUsedBytes': max(0, swap_total - values.get('SwapFree', 0))}


def server_disk():
    try:
        # -I excludes sibling imports; the deployment keeps this source and its
        # ancestors root-owned, like the privileged sampler itself.
        overview = runpy.run_path(str(pathlib.Path(__file__).resolve().with_name('storage.py')))['filesystem_overview']()
        return {**overview['summary'], 'scope': 'server', 'mount': None,
                'available': overview['available'], 'volumes': overview['volumes'],
                **({'reason': overview['reason']} if 'reason' in overview else {})}
    except (OSError, ValueError, KeyError):
        return {'scope': 'server', 'mount': None, 'available': False, 'volumeCount': None,
                'totalBytes': None, 'usedBytes': None, 'freeBytes': None, 'availableBytes': None,
                'reservedBytes': None, 'percent': None, 'volumes': [], 'reason': 'Sunucu disk kapasitesi ölçülemedi.'}


def listeners(raw):
    result = {}
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[0] not in ('tcp', 'udp'):
            continue
        try:
            port = int(fields[4].rsplit(':', 1)[1])
        except ValueError:
            continue
        if not 1 <= port <= 65535:
            continue
        item = result.setdefault(port, {'port': port, 'pids': set(), 'transports': set(), 'unknownOwner': False})
        pids = {int(value) for value in re.findall(r'pid=(\d+)', line)}
        item['pids'].update(pids)
        item['unknownOwner'] = item['unknownOwner'] or not pids
        item['transports'].add(fields[0])
    return result


def group_listeners(ports):
    groups = []
    for item in ports.values():
        overlapping = [g for g in groups if g['pids'] & item['pids']]
        current = {'ports': {item['port']}, 'pids': set(item['pids']), 'transports': set(item['transports']), 'unknownOwner': item['unknownOwner']}
        for group in overlapping:
            current['ports'].update(group['ports'])
            current['pids'].update(group['pids'])
            current['transports'].update(group['transports'])
            current['unknownOwner'] = current['unknownOwner'] or group['unknownOwner']
            groups.remove(group)
        groups.append(current)
    return groups


def owned_processes(groups, snapshot):
    owners = {pid: index for index, group in enumerate(groups) for pid in group['pids']}
    result = [set(group['pids']) for group in groups]
    for pid in snapshot:
        cursor, seen = pid, set()
        while cursor in snapshot and cursor not in seen:
            seen.add(cursor)
            if cursor in owners:
                # PID 1 must not attribute unrelated system services to a socket.
                if cursor != 1 or pid == 1:
                    result[owners[cursor]].add(pid)
                break
            cursor = snapshot[cursor]['parent']
    return result


def io_counters(pids):
    result = {}
    for pid in pids:
        try:
            values = dict(line.split(':', 1) for line in pathlib.Path('/proc/%d/io' % pid).read_text().splitlines())
            result[pid] = {**{key: int(values[key]) for key in ('read_bytes', 'write_bytes')}, 'at': time.monotonic()}
        except (OSError, ValueError, KeyError):
            continue
    return result


def rate(pids, before, after, first_io, last_io, key, elapsed):
    if not pids or elapsed <= 0:
        return None
    total = 0
    for pid in pids:
        if pid not in first_io or pid not in last_io or pid not in before or pid not in after or before[pid]['started'] != after[pid]['started']:
            return None
        delta = last_io[pid][key] - first_io[pid][key]
        if delta < 0:
            return None
        interval = last_io[pid]['at'] - first_io[pid]['at']
        if interval <= 0:
            return None
        total += delta / interval
    return round(total)


def device_counters():
    """Cumulative counters; exclude partitions and stacked block devices."""
    disks, network = {}, {}
    for device in pathlib.Path('/sys/block').glob('*'):
        try:
            if device.name.startswith(('loop', 'ram', 'dm-', 'md', 'zram')):
                continue
            fields = device.joinpath('stat').read_text().split()
            disks[device.name] = {'read': int(fields[2]) * 512, 'write': int(fields[6]) * 512}
        except (OSError, ValueError, IndexError):
            continue
    try:
        for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]:
            name, values = line.split(':', 1)
            fields = values.split()
            if name.strip() != 'lo':
                network[name.strip()] = {'read': int(fields[0]), 'write': int(fields[8])}
    except (OSError, ValueError, IndexError):
        pass
    return {'disks': disks, 'network': network, 'at': time.monotonic()}


def counter_rates(before, after, group):
    seconds = after['at'] - before['at']
    rows = []
    for name, current in after[group].items():
        previous = before[group].get(name)
        valid = previous is not None and seconds > 0 and all(current[k] >= previous[k] for k in ('read', 'write'))
        rows.append({'name': name, 'readBytesPerSecond': round((current['read'] - previous['read']) / seconds) if valid else None,
                     'writeBytesPerSecond': round((current['write'] - previous['write']) / seconds) if valid else None})
    return rows


def overview(before, after, total_delta, first_devices, last_devices):
    import platform
    os_name = platform.system()
    try:
        for line in pathlib.Path('/etc/os-release').read_text().splitlines():
            if line.startswith('PRETTY_NAME='):
                os_name = line.split('=', 1)[1].strip('"')[:200]
    except OSError:
        pass
    addresses = []
    try:
        interfaces = json.loads(subprocess.check_output(['ip', '-j', 'address', 'show'], text=True, timeout=3))
        addresses = [a['local'] for interface in interfaces for a in interface.get('addr_info', [])
                     if a.get('scope') == 'global' and isinstance(a.get('local'), str)][:64]
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    temperatures = []
    for sensor in pathlib.Path('/sys/class/hwmon').glob('hwmon*'):
        try:
            if sensor.joinpath('name').read_text().strip() not in ('coretemp', 'k10temp', 'zenpower', 'cpu_thermal'):
                continue
            for reading in sensor.glob('temp*_input'):
                value = int(reading.read_text()) / 1000
                if -20 <= value <= 150:
                    temperatures.append(value)
        except (OSError, ValueError):
            continue
    top = [{'pid': p['pid'], 'name': p['name'], 'state': p['state'], 'memoryBytes': p['rss'],
            'cpuPercent': cpu_percent(before.get(p['pid']), p, total_delta)} for p in after.values()]
    top.sort(key=lambda p: (p['cpuPercent'] if p['cpuPercent'] is not None else -1, p['memoryBytes']), reverse=True)
    return {'version': 1, 'platform': 'linux', 'os': os_name, 'kernel': platform.release(), 'addresses': addresses,
            'cpuTemperatureC': max(temperatures) if temperatures else None,
            'disks': counter_rates(first_devices, last_devices, 'disks'),
            'network': counter_rates(first_devices, last_devices, 'network'), 'topProcesses': top[:10],
            'notes': ['Network counters are per interface; virtual interfaces can count the same traffic more than once.',
                      'Disk I/O excludes partitions and stacked dm/md devices to avoid duplicate totals.']}


def sample():
    started = time.monotonic()
    initial_groups = group_listeners(listeners(subprocess.check_output(['ss', '-lntupH'], text=True, timeout=5)))
    first_cpu = host_cpu()
    before = processes()
    initial_owned = owned_processes(initial_groups, before)
    first_io = io_counters(set().union(*initial_owned) if initial_owned else set())
    first_devices = device_counters()
    time.sleep(0.65)
    after = processes()
    last_cpu = host_cpu()
    last_devices = device_counters()
    raw = subprocess.check_output(['ss', '-lntupH'], text=True, timeout=5)
    groups = group_listeners(listeners(raw))
    owned = owned_processes(groups, after)
    last_io = io_counters(set().union(*owned) if owned else set())
    elapsed = time.monotonic() - started
    total_delta, idle_delta = last_cpu['total'] - first_cpu['total'], last_cpu['idle'] - first_cpu['idle']
    host_percent = round(max(0, min(100, (1 - idle_delta / total_delta) * 100)), 2) if total_delta > 0 and 0 <= idle_delta <= total_delta else None
    mem = memory(pathlib.Path('/proc/meminfo').read_text())
    rows = []
    for group, pids in zip(groups, owned):
        names = sorted({after[pid]['name'] for pid in group['pids'] if pid in after})
        proxy = 'docker-proxy' in names
        complete = bool(pids) and not group['unknownOwner'] and all(pid in after for pid in pids)
        values = [cpu_percent(before.get(pid), after.get(pid), total_delta) for pid in pids]
        cpu = round(min(100, sum(values)), 2) if complete and values and all(value is not None for value in values) else None
        rss = sum(after[pid]['rss'] for pid in pids) if complete else None
        rows.append({'id': 'ports-' + '-'.join(map(str, sorted(group['ports']))), 'ports': sorted(group['ports']),
                     'listenerPids': sorted(group['pids']), 'pids': sorted(pids), 'processNames': names,
                     'transports': sorted(group['transports']), 'cpuPercent': None if proxy else cpu,
                     'memoryBytes': None if proxy else rss,
                     'memoryPercent': round(rss / mem['totalBytes'] * 100, 2) if rss is not None and mem['totalBytes'] and not proxy else None,
                     'readBytesPerSecond': None if proxy or not complete else rate(pids, before, after, first_io, last_io, 'read_bytes', elapsed),
                     'writeBytesPerSecond': None if proxy or not complete else rate(pids, before, after, first_io, last_io, 'write_bytes', elapsed),
                     'scope': 'proxy' if proxy else 'process-tree' if complete else 'unavailable'})
    return {'available': True, 'sampledAt': time.time() * 1000, 'sampleSeconds': round(elapsed, 2), 'hostname': socket.gethostname(),
            'system': {'cpuPercent': host_percent, 'cpuCount': os.cpu_count(), 'memory': mem,
                       'disk': server_disk(),
                       'uptimeSeconds': float(pathlib.Path('/proc/uptime').read_text().split()[0]),
                       'loadAverage': list(os.getloadavg()), 'processCount': len(after)},
            'applications': rows, 'portCount': sum(len(group['ports']) for group in groups),
            'overview': overview(before, after, total_delta, first_devices, last_devices)}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise ValueError('Fixed root-only resource sampler')
        print(json.dumps(sample(), ensure_ascii=False))
    except Exception:
        print(json.dumps({'available': False, 'error': 'Sunucu kaynakları şu anda ölçülemiyor.'}))
        raise SystemExit(1)
