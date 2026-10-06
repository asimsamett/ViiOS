"""Read-only, bounded concurrency telemetry. Accepts no arguments or stdin.

No inference, load test, model activation or service modification is performed.
Only allowlisted, non-waking metadata routes are queried. The deployed llama.cpp
GET /slots can wake a sleeping model, so it is deliberately excluded.
"""
import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

SERVER = Path(__file__).resolve().parent
MAX_BODY = 2 * 1024 * 1024
MAX_SERIES = 1024
KNOWN_LLAMA = frozenset()
# Verified from the service's own OpenAPI document, not a guessed route.
KNOWN_NIM = frozenset()
GAUGES = {
    'vllm:num_requests_running': ('vLLM', 'running'),
    'vllm:num_requests_waiting': ('vLLM', 'waiting'),
    'llamacpp:requests_processing': ('llama.cpp', 'running'),
    'llamacpp:requests_deferred': ('llama.cpp', 'waiting'),
}


def catalog_module():
    spec = importlib.util.spec_from_file_location('model_catalog', SERVER / 'model_catalog.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TelemetryUnavailable(Exception):
    def __init__(self, status=None): self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None


def fetch(base, route, as_json=False):
    if route not in ('/metrics', '/v1/metrics', '/props'): raise ValueError('route')
    if route == '/v1/metrics' and base not in KNOWN_NIM: raise ValueError('unsupported NIM target')
    if route == '/props' and base not in KNOWN_LLAMA: raise ValueError('unsupported metadata target')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(base + route, headers={'Accept': 'application/json' if as_json else 'text/plain'}, method='GET')
    try:
        with opener.open(request, timeout=3) as response:
            size = response.headers.get('Content-Length')
            if size and (not size.isdigit() or int(size) > MAX_BODY): raise TelemetryUnavailable()
            body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY: raise TelemetryUnavailable()
        text = body.decode('utf-8', errors='strict')
        return json.loads(text) if as_json else text
    except urllib.error.HTTPError as error: raise TelemetryUnavailable(error.code) from None
    except (OSError, ValueError, UnicodeError): raise TelemetryUnavailable() from None


def count(value, positive=False):
    if isinstance(value, bool): return None
    try:
        number = float(value)
        if not math.isfinite(number) or not number.is_integer() or number < (1 if positive else 0) or number > 10 ** 9: return None
        return int(number)
    except (ValueError, TypeError, OverflowError): return None


def labels(value):
    if not value: return {}
    output, pos = {}, 0
    while pos < len(value):
        match = re.match(r'\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\[\\"n])*")\s*(?:,|$)', value[pos:])
        if not match or match[1] in output: raise ValueError('labels')
        decoded = json.loads(match[2])
        if len(decoded) > 1000: raise ValueError('label size')
        output[match[1]] = decoded
        pos += match.end()
    return output


def parse_metrics(text, nim=False):
    """Return only known concurrency gauges, never arbitrary metric labels/text."""
    if not isinstance(text, str) or len(text.encode()) > MAX_BODY: raise ValueError('metrics size')
    gauges = dict(GAUGES)
    if nim:
        # NIM wraps vLLM and publishes its ceiling alongside vLLM engine gauges.
        # They are one verified runtime; llama.cpp remains a different runtime.
        gauges.update({name: ('NVIDIA NIM', field) for name, (runtime, field) in GAUGES.items() if runtime == 'vLLM'})
        gauges.update({'num_requests_running': ('NVIDIA NIM', 'running'),
                       'num_requests_waiting': ('NVIDIA NIM', 'waiting'),
                       'num_request_max': ('NVIDIA NIM', 'configuredParallelism')})
    series, types, bad = {name: [] for name in gauges}, {}, set()
    for line in text.splitlines():
        declared = re.fullmatch(r'#\s*TYPE\s+(\S+)\s+(\S+)\s*', line)
        if declared:
            if declared[1] in gauges: types[declared[1]] = declared[2]
            continue
        name = re.match(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)', line)
        if not name or name[1] not in gauges: continue
        metric = name[1]
        try:
            match = re.fullmatch(r'([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{((?:[^"{}]|"(?:[^"\\]|\\.)*")*)\})?\s+([^\s]+)(?:\s+[0-9.eE+-]+)?\s*', line)
            if not match: raise ValueError('sample')
            value = count(match[3])
            if value is None: raise ValueError('gauge')
            dimensions = labels(match[2])
            identity = tuple(sorted(dimensions.items()))
            if any(previous[0] == identity for previous in series[metric]): raise ValueError('duplicate series')
            if len(series[metric]) >= MAX_SERIES: raise ValueError('series limit')
            series[metric].append((identity, value))
        except (ValueError, TypeError): bad.add(metric)
    result = {'runtime': None, 'running': None, 'waiting': None, 'configuredParallelism': None, 'modelName': None, 'metricNames': []}
    runtimes = set()
    model_names = set()
    for name, samples in series.items():
        if not samples or name in bad or types.get(name, 'gauge') != 'gauge': continue
        runtime, field = gauges[name]
        if field == 'configuredParallelism':
            # Per-engine/model maxima are not additive when hardware is shared.
            # Accept only a single explicitly typed, positive service/model limit.
            if types.get(name) != 'gauge' or len(samples) != 1 or count(samples[0][1], positive=True) is None: continue
            if any(key not in ('model_name', 'model') for key, _ in samples[0][0]): continue
        # An unlabeled total already covers labeled dimensions, so don't add it
        # a second time. Otherwise, each unique engine/model series contributes.
        total = next((value for dimensions, value in samples if not dimensions), None)
        if total is None:
            dimensions = [dict(identity) for identity, _ in samples]
            # A model total and its engine breakdown overlap even when no fully
            # unlabeled total exists. Unknown is safer than double-counting.
            if any(len(left) < len(right) and all(right.get(key) == value for key, value in left.items()) for left in dimensions for right in dimensions): continue
        aggregate = total if total is not None else sum(value for _, value in samples)
        if aggregate > 10 ** 9: continue
        runtimes.add(runtime)
        if result[field] is not None:
            # Two runtime metric families at one endpoint have ambiguous scope.
            result[field] = None
            continue
        result[field] = aggregate
        result['metricNames'].append(name)
        for dimensions, _ in samples:
            model = dict(dimensions).get('model_name') or dict(dimensions).get('model')
            if isinstance(model, str) and len(model) <= 200 and not any(ord(char) < 32 for char in model) and not re.search(r'(?i)(sk-[a-z0-9_-]{12,}|bearer\s|password\s*=|token\s*=)', model): model_names.add(model)
    if len(runtimes) > 1:
        return {'runtime': None, 'running': None, 'waiting': None, 'configuredParallelism': None, 'modelName': None, 'metricNames': []}
    if len(runtimes) == 1: result['runtime'] = next(iter(runtimes))
    if len(model_names) == 1: result['modelName'] = next(iter(model_names))
    if len(model_names) > 1:
        result['configuredParallelism'] = None
        result['metricNames'] = [name for name in result['metricNames'] if name != 'num_request_max']
    return result


def ollama_listener_pid():
    """Find the actual loopback listener; Ollama can run outside systemd."""
    try:
        reply = subprocess.run(['/usr/bin/ss', '-H', '-ltnp', 'sport = :11434'], capture_output=True, text=True, timeout=2, check=True)
        if len(reply.stdout) > 65536: return None
        pids = set()
        for line in reply.stdout.splitlines():
            fields = line.split()
            if len(fields) < 5 or fields[0] != 'LISTEN': continue
            address = fields[3]
            if address not in ('127.0.0.1:11434', '0.0.0.0:11434', '*:11434', '[::]:11434'): continue
            pids.update(int(pid) for pid in re.findall(r'\bpid=(\d+)\b', line) if 0 < int(pid) < 2 ** 31)
        return next(iter(pids)) if len(pids) == 1 else None
    except (OSError, ValueError, subprocess.SubprocessError): return None


def ollama_process_identity(pid):
    """Verify executable, serve role and process start time before reading env."""
    folder = Path('/proc') / str(pid)
    executable = os.readlink(folder / 'exe')
    if executable not in ('/usr/bin/ollama', '/usr/local/bin/ollama', '/bin/ollama'): return None
    with open(folder / 'cmdline', 'rb') as stream: command = stream.read(65537)
    if len(command) > 65536: return None
    arguments = command.split(b'\0')
    if len(arguments) < 2 or arguments[1] != b'serve': return None
    with open(folder / 'stat', 'r') as stream: stats = stream.read(4096).rsplit(')', 1)[-1].split()
    if len(stats) <= 19 or not stats[19].isdigit(): return None
    return executable, stats[19]


def ollama_limits():
    """Return only explicit numeric settings of the verified live 11434 server."""
    try:
        pid = ollama_listener_pid()
        if not pid: return {}
        before = ollama_process_identity(pid)
        if before is None: return {}
        with open('/proc/%d/environ' % pid, 'rb') as source: raw = source.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024 or ollama_process_identity(pid) != before: return {}
        permitted = {b'OLLAMA_NUM_PARALLEL', b'OLLAMA_MAX_QUEUE'}
        settings = {}
        for pair in raw.split(b'\0'):
            key, separator, value = pair.partition(b'=')
            if separator and key in permitted:
                # Match envconfig.Var/ParseUint instead of accepting decimal or
                # exponent syntax which Ollama itself would replace by a default.
                text = value.decode('ascii', errors='strict').strip().strip('"\'')
                if not re.fullmatch(r'\d{1,10}', text): continue
                parsed = count(text, positive=key == b'OLLAMA_NUM_PARALLEL')
                if parsed is not None: settings[key.decode('ascii')] = parsed
        return settings
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError): return {}


def service(item, primary_host, checked, get=fetch, read_ollama=ollama_limits):
    base = item['base']
    hostname = urllib.parse.urlsplit(base).hostname
    host = primary_host if hostname in ('localhost', '127.0.0.1', primary_host) else hostname
    row = {'id': hashlib.sha256(base.encode()).hexdigest()[:24], 'endpoint': base, 'host': host, 'runtime': item.get('runtime', 'OpenAI uyumlu'),
           'status': 'unsupported', 'checkedAt': None, 'running': None, 'waiting': None,
           'configuredParallelism': None, 'configuredQueueLimit': None, 'configuredParallelismScope': 'service',
           'scope': 'service', 'modelName': None, 'sources': [], 'note': None, 'capacity': {'status': 'not_tested'}}
    notes, http_status, metrics_replied = [], None, False
    metrics_route = '/v1/metrics' if base in KNOWN_NIM else '/metrics'
    if base in KNOWN_NIM: row['runtime'] = 'NVIDIA NIM'
    try:
        payload = get(base, metrics_route)
        metrics_replied = True
        metrics = parse_metrics(payload, nim=base in KNOWN_NIM)
        for field in ('running', 'waiting', 'modelName', 'configuredParallelism'):
            row[field] = metrics[field]
        if metrics['runtime']: row['runtime'] = metrics['runtime']
        current_gauges = [name for name in metrics['metricNames'] if name != 'num_request_max']
        if current_gauges:
            row['sources'].append({'kind': 'metrics', 'source': base + metrics_route, 'detail': 'Anlık servis göstergeleri: ' + ', '.join(current_gauges) + '. Benzersiz model/işleyici serileri servis kapsamında toplanır.'})
        if metrics['configuredParallelism'] is not None:
            row['sources'].append({'kind': 'configuration', 'source': base + metrics_route,
                'detail': 'NVIDIA NIM num_request_max göstergesi: servisin bildirdiği eşzamanlı istek üst sınırı. Yük testiyle doğrulanmış kullanıcı kapasitesi değildir.'})
            notes.append('Paralellik değeri NIM servisinin bildirdiği üst sınırdır; bu sayıda isteğin hedeflenen hızda tamamlanacağı test edilmedi.')
    except TelemetryUnavailable as error: http_status = error.status
    except (OSError, ValueError, TypeError): pass
    if base in KNOWN_LLAMA:
        try:
            props = get(base, '/props', True)
            slots = count(props.get('total_slots'), positive=True) if isinstance(props, dict) else None
            if slots is not None:
                row['runtime'] = 'llama.cpp'
                row['configuredParallelism'] = slots
                row['sources'].append({'kind': 'configuration', 'source': base + '/props', 'detail': 'Servisin bildirdiği total_slots; yapılandırılmış paralel slot sayısıdır, ölçülmüş eşzamanlı kullanıcı kapasitesi değildir.'})
                if row['running'] is None:
                    notes.append('Bu sürümde /slots çağrısı uyuyan modeli uyandırabilir; pasif izlemede kullanılmıyor. İşlenen istek sayısı yalnızca /metrics sunulduğunda alınır.')
        except (TelemetryUnavailable, OSError, ValueError, TypeError): notes.append('Paralel slot yapılandırması okunamadı.')
    if row['runtime'] == 'Ollama' and host == primary_host:
        settings = read_ollama()
        for key, field in (('OLLAMA_NUM_PARALLEL', 'configuredParallelism'), ('OLLAMA_MAX_QUEUE', 'configuredQueueLimit')):
            if settings.get(key) is not None:
                row[field] = settings[key]
                row['sources'].append({'kind': 'configuration', 'source': '11434 portundaki doğrulanmış Ollama süreci', 'detail': key + ' açıkça tanımlı; yalnızca izin verilen sayısal ayar okundu.'})
        row['configuredParallelismScope'] = 'per-model'
        notes.append('Ollama paralellik ayarı model başınadır. Süreçte açıkça belirtilmeyen değerler için varsayılan kapasite tahmin edilmez.')
    measured = row['running'] is not None or row['waiting'] is not None
    configured = row['configuredParallelism'] is not None or row['configuredQueueLimit'] is not None
    if measured or configured:
        row['status'] = 'ok' if row['running'] is not None and row['waiting'] is not None else 'partial'
        row['checkedAt'] = checked
    else:
        row['status'] = 'unsupported' if metrics_replied or http_status in (401, 403, 404, 405, 501) else 'unavailable'
    if row['running'] is None: notes.append('Çalışan istek sayısı doğrulanamadı; bilinmeyen değer sıfır olarak gösterilmez.')
    if row['waiting'] is None: notes.append('Bekleyen istek sayısı doğrulanamadı.')
    if http_status in (404, 405, 501): notes.append('Bu serviste ' + metrics_route + ' göstergeleri sunulmuyor veya etkin değil.')
    elif http_status in (401, 403): notes.append('Metrik erişimi mevcut yetkiyle sağlanamadı.')
    if not measured and not configured and row['status'] == 'unavailable': notes.append('Servis izleme uç noktasına erişilemedi veya yanıt doğrulanamadı.')
    row['note'] = ' '.join(notes) or None
    return row


def main():
    if len(sys.argv) != 1: raise SystemExit(2)
    catalog = catalog_module()
    helper = catalog.load_connections()
    config = json.loads(helper.read_text(str(SERVER / 'model-catalog-targets.json')))
    targets = {}
    for item in config.get('endpoints', []):
        base = catalog.endpoint_base(item['url'], set(config['allowedHosts']))
        if base: targets[base] = {'base': base, 'runtime': item.get('runtime', 'OpenAI uyumlu')}
    checked = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(lambda item: service(item, config['primaryHost'], checked), list(targets.values())[:32]))
    error = 'Servislerin eşzamanlılık bilgileri şu anda doğrulanamadı.' if rows and all(row['status'] == 'unavailable' for row in rows) else None
    print(json.dumps({'checkedAt': checked, 'error': error, 'services': rows}, ensure_ascii=False))


if __name__ == '__main__': main()
