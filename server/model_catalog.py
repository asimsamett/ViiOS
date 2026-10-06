"""Bounded read-only model inventory; no inference, model loading or application imports.

The privileged entrypoint accepts no arguments or stdin. Its allowlist and helper
are installed alongside this file and must be owned by the deployment account.
Only GET /api/tags, /api/ps and /v1/models are sent to evidenced model endpoints.
"""
import concurrent.futures
import csv
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

SERVER = Path(__file__).resolve().parent
MAX_JSON = 8 * 1024 * 1024
MAX_FILES = 6000
STATUS_ORDER = {'unreachable': 0, 'configured': 1, 'installed': 2, 'available': 3, 'running': 4}
FAMILY = (('gemma', 'Gemma'), ('qwen', 'Qwen'), ('gpt-oss', 'GPT-OSS'), ('gptoss', 'GPT-OSS'), ('deepseek', 'DeepSeek'), ('llama', 'Llama'), ('mistral', 'Mistral'), ('hubert', 'HuBERT'), ('bert', 'BERT'), ('whisper', 'Whisper'))


def load_connections():
    spec = importlib.util.spec_from_file_location('model_connections', SERVER / 'model_connections.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def safe_text(value, limit=200):
    if not isinstance(value, str): return None
    value = value.strip()
    if not value or len(value) > limit or any(ord(char) < 32 for char in value): return None
    if re.search(r'(?i)(?:sk-[a-z0-9_-]{12,}|bearer\s|password\s*=|token\s*=)', value): return None
    return value


def number(value):
    try:
        result = float(value)
        return int(result) if result >= 0 and result < 10 ** 16 else None
    except (TypeError, ValueError, OverflowError): return None


def family(name, details=None):
    details = details or {}
    # Runtime architecture is stronger evidence than a user-chosen model alias.
    for candidate in (str(details.get('family', '')), str(details.get('model_type', '')), name):
        found = next((label for token, label in FAMILY if token in candidate.lower()), None)
        if found: return found
    return 'Diğer'


def kind(name, details=None):
    text = ' '.join([name, str((details or {}).get('model_type', '')), str((details or {}).get('family', ''))]).lower()
    if any(token in text for token in ('whisper', 'voice', 'tts', 'hubert', 'mimi', 'talker')): return 'speech'
    if any(token in text for token in ('gliner', 'extractor')): return 'extraction'
    if any(token in text for token in ('embed', 'bge-', 'e5-', 'minilm')): return 'embedding'
    if 'bert' in text or 'roberta' in text: return 'encoder'
    if any(token in text for token in ('gemma', 'qwen', 'gptoss', 'gpt-oss', 'llama', 'mistral', 'deepseek', 'llm')): return 'language'
    return 'other'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None


def endpoint_base(value, allowed_hosts):
    """Normalize trusted source settings; deny credentials, arbitrary paths and hosts."""
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or url.hostname not in allowed_hosts or url.username or url.password or url.query or url.fragment: return None
        if url.port is not None and not 1 <= url.port <= 65535: return None
        path = url.path.rstrip('/')
        if path not in ('', '/v1', '/v1/chat/completions', '/chat/completions', '/api', '/api/chat', '/api/generate'): return None
        if any(ord(c) < 32 for c in value): return None
        return urllib.parse.urlunsplit((url.scheme, url.netloc, '', '', ''))
    except (TypeError, ValueError): return None


def get_json(base, route):
    if route not in ('/api/tags', '/api/ps', '/v1/models'): raise ValueError('route')
    request = urllib.request.Request(base + route, headers={'Accept': 'application/json'}, method='GET')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=5) as response:
        data = response.read(MAX_JSON + 1)
    if len(data) > MAX_JSON: raise ValueError('limit')
    parsed = json.loads(data)
    if not isinstance(parsed, dict): raise ValueError('shape')
    return parsed


def model_row(name, host, runtime, status, source, checked, details=None, endpoint=None):
    details = details or {}
    name = safe_text(name)
    if not name: return None
    return {'id': hashlib.sha256((host + '|' + runtime + '|' + name + '|' + (endpoint or '')).encode()).hexdigest()[:24],
            'name': name, 'family': family(name, details), 'kind': kind(name, details), 'host': host,
            'runtime': runtime, 'status': status, 'parameterSize': safe_text(details.get('parameter_size'), 80),
            'quantization': safe_text(details.get('quantization_level'), 80), 'contextLength': number(details.get('context_length')),
            'sizeBytes': number(details.get('size')), 'endpoint': endpoint, 'paths': [], 'applications': [],
            'evidence': [{'kind': 'api' if endpoint else 'disk', 'source': source, 'detail': 'Model kaydı doğrulandı.'}],
            'loadedFromAPI': status == 'running', 'checkedAt': checked}


def merge_models(rows):
    """Merge only matching identities; disk files on another host are never conflated."""
    unique, endpoints = {}, {}
    for row in rows:
        if row and row.get('endpoint'): endpoints.setdefault((row['host'], row['runtime'], row['name']), set()).add(row['endpoint'])
    for row in rows:
        if not row: continue
        identity = (row['host'], row['runtime'], row['name'])
        # Attach disk evidence only when its model maps to exactly one service.
        # Two services with the same model remain independent health records.
        if not row.get('endpoint') and len(endpoints.get(identity, set())) == 1:
            row['endpoint'] = next(iter(endpoints[identity]))
            row['id'] = hashlib.sha256(('|'.join(identity) + '|' + row['endpoint']).encode()).hexdigest()[:24]
        key = identity + (row.get('endpoint') or '',)
        if key not in unique: unique[key] = row; continue
        previous = unique[key]
        if STATUS_ORDER[row['status']] > STATUS_ORDER[previous['status']]:
            previous['status'] = row['status']
        for field in ('parameterSize', 'quantization', 'contextLength', 'sizeBytes', 'endpoint'):
            if row.get(field) is not None: previous[field] = row[field]
        previous['loadedFromAPI'] = previous.get('loadedFromAPI', False) or row.get('loadedFromAPI', False)
        for field in ('paths', 'applications', 'evidence'):
            for item in row[field]:
                if item not in previous[field]: previous[field].append(item)
    return sorted(unique.values(), key=lambda row: (-STATUS_ORDER[row['status']], row['family'], row['name'], row['host']))


def endpoint_inventory(item, primary_host, checked, fetch=get_json):
    base = item['base']
    hostname = urllib.parse.urlsplit(base).hostname
    host = primary_host if hostname in ('127.0.0.1', 'localhost', primary_host) else hostname
    runtime = item['runtime']
    result = {'models': [], 'host': host, 'base': base, 'ok': False, 'warnings': [], 'requests': 0}
    try:
        route = '/api/tags' if runtime == 'Ollama' else '/v1/models'
        result['requests'] += 1
        payload = fetch(base, route)
        entries = payload.get('models' if runtime == 'Ollama' else 'data')
        if not isinstance(entries, list) or len(entries) > 1000: raise ValueError('shape')
        for entry in entries:
            if not isinstance(entry, dict): continue
            details = dict(entry.get('details') or {}) if isinstance(entry.get('details'), dict) else {}
            details['size'] = entry.get('size')
            details['context_length'] = entry.get('max_model_len', entry.get('context_length'))
            row = model_row(entry.get('name', entry.get('id')), host, runtime, 'available', base + route, checked, details, base)
            if row:
                row['evidence'][0]['detail'] = 'Servisin model listesinde mevcut; GPU belleğine yüklü olduğu bu yanıtla kanıtlanmaz.'
                result['models'].append(row)
        result['ok'] = True
        if runtime == 'Ollama':
            try:
                result['requests'] += 1
                loaded = fetch(base, '/api/ps').get('models')
                if not isinstance(loaded, list) or len(loaded) > 1000: raise ValueError('shape')
                for entry in loaded:
                    if not isinstance(entry, dict): continue
                    details = dict(entry.get('details') or {}) if isinstance(entry.get('details'), dict) else {}
                    details.update({'size': entry.get('size'), 'context_length': entry.get('context_length')})
                    row = model_row(entry.get('name', entry.get('model')), host, runtime, 'running', base + '/api/ps', checked, details, base)
                    if row:
                        row['evidence'][0]['detail'] = 'Ollama etkin model listesinde yüklü; CPU/GPU dağılımı ayrıca doğrulanmalıdır.'
                        result['models'].append(row)
            except (OSError, ValueError, TypeError): result['warnings'].append(base + ': yüklü model listesi alınamadı.')
    except (OSError, ValueError, TypeError): result['warnings'].append(base + ': model servisi yanıt vermedi veya liste okunamadı.')
    for binding in item.get('bindings', []):
        name = binding.get('model')
        if not name: continue
        row = model_row(name, host, runtime, 'configured' if result['ok'] else 'unreachable', binding['source'], checked, endpoint=base)
        if row:
            row['applications'] = [{'name': binding['application']}]
            row['evidence'] = [{'kind': 'configuration', 'source': binding['source'], 'detail': 'Uygulama bağlantı ayarı; modelin yüklü olduğunu tek başına kanıtlamaz.'}]
            result['models'].append(row)
    return result


def process_apps(profiles):
    apps = []
    try: entries = list(Path('/proc').iterdir())[:65536]
    except OSError: return []
    roots = [root for profile in profiles for root in profile.get('roots', [])]
    for entry in entries:
        if not entry.name.isdigit(): continue
        try:
            cwd = os.readlink(entry / 'cwd')
            if any(cwd == root or cwd.startswith(root + '/') for root in roots): apps.append({'pid': int(entry.name), 'directory': cwd})
        except OSError: pass
    return apps


def configured_endpoints(config, helper):
    endpoints, warnings, profiles = {}, [], []
    allowed = set(config['allowedHosts'])
    for item in config.get('endpoints', []):
        base = endpoint_base(item['url'], allowed)
        if base: endpoints[base] = {'base': base, 'runtime': item.get('runtime', 'OpenAI uyumlu'), 'bindings': []}
    try:
        profiles = json.loads(helper.read_text(str(SERVER / 'model-targets.json'))) + config.get('additionalProfiles', [])
        apps = process_apps(profiles)
        cache = {}
        for profile in profiles:
            keys = {binding.get(key) for binding in profile.get('bindings', []) for key in ('url', 'model') if binding.get(key)}
            keys.update(key for binding in profile.get('bindings', []) for key in binding.get('environmentKeys', []))
            environments = [{}] + [helper.process_environment(app, keys) for app in apps if any(helper.within(app['directory'], root) for root in profile.get('roots', []))]
            for environment in environments:
                connections, incomplete = helper.connections(profile, environment, cache)
                if incomplete: warnings.append(profile['id'] + ': bazı model ayarları okunamadı.')
                for row in connections:
                    base = endpoint_base(row['endpoint'], allowed)
                    if not base:
                        warnings.append(profile['id'] + ': bağlantı adresi izin verilen model sunucuları dışında veya desteklenmeyen bir yol içeriyor.')
                        continue
                    runtime = 'Ollama' if urllib.parse.urlsplit(base).port == 11434 else 'OpenAI uyumlu'
                    target = endpoints.setdefault(base, {'base': base, 'runtime': runtime, 'bindings': []})
                    source = next((e.get('file') for e in row['evidence'] if e.get('file')), 'İzin verilen uygulama model ortam ayarı')
                    target['bindings'].append({'model': row.get('model'), 'application': profile['id'], 'source': source})
    except (OSError, ValueError, TypeError, KeyError): warnings.append('Uygulama model bağlantı kataloğu tam okunamadı.')
    return list(endpoints.values())[:64], list(dict.fromkeys(warnings))


def bounded_files(root, max_depth=5, limit=MAX_FILES):
    root = Path(root)
    if not root.exists(): return [], False
    if root.is_symlink(): return [], True
    pending, files, count, incomplete = [(root, 0)], [], 0, False
    while pending and count < limit:
        folder, depth = pending.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    count += 1
                    if count >= limit: incomplete = True; break
                    if entry.is_symlink():
                        # HF configs/weights normally link into their own blob store.
                        # Include files only, and never follow directory symlinks.
                        try:
                            resolved = Path(entry.path).resolve(strict=True)
                            if resolved.is_file() and str(resolved).startswith(str(root.resolve()) + os.sep): files.append(Path(entry.path))
                        except OSError: incomplete = True
                        continue
                    if entry.is_file(follow_symlinks=False): files.append(Path(entry.path))
                    elif depth < max_depth and entry.is_dir(follow_symlinks=False) and not entry.name.startswith('.') and entry.name not in ('node_modules', 'blobs'): pending.append((Path(entry.path), depth + 1))
        except OSError: incomplete = True
    return files, incomplete or bool(pending)


def ollama_disk(root, host, checked, helper):
    root = Path(root)
    files, partial = bounded_files(root / 'manifests', max_depth=5)
    rows, checked_files = [], 0
    for manifest in files:
        try:
            payload = json.loads(helper.read_text(str(manifest), 256 * 1024))
            if not isinstance(payload.get('layers'), list): continue
            parts = manifest.relative_to(root / 'manifests').parts
            if len(parts) < 3: continue
            repository = '/'.join(parts[1:-1])
            if repository.startswith('library/'): repository = repository[len('library/'):]
            name = repository + ':' + parts[-1]
            layers = [payload.get('config') or {}] + payload['layers']
            valid_layers = [layer for layer in layers if isinstance(layer, dict) and re.fullmatch(r'sha256:[a-f0-9]{64}', str(layer.get('digest', '')))]
            present = bool(valid_layers) and len(valid_layers) == len(layers) and all((root / 'blobs' / layer['digest'].replace(':', '-')).is_file() and (number(layer.get('size')) is None or (root / 'blobs' / layer['digest'].replace(':', '-')).stat().st_size == number(layer['size'])) for layer in valid_layers)
            details = {'size': sum(number(layer.get('size')) or 0 for layer in valid_layers)}
            descriptor = payload.get('config', {}).get('digest', '')
            if re.fullmatch(r'sha256:[a-f0-9]{64}', descriptor):
                try:
                    metadata = json.loads(helper.read_text(str(root / 'blobs' / descriptor.replace(':', '-')), 128 * 1024))
                    details.update({key: metadata.get(key) for key in ('model_type', 'family', 'parameter_size', 'quantization_level')})
                    if metadata.get('model_family'): details['family'] = metadata['model_family']
                    if metadata.get('model_type'): details['parameter_size'] = metadata['model_type']
                    if metadata.get('file_type'): details['quantization_level'] = metadata['file_type']
                except (OSError, ValueError, TypeError): pass
            row = model_row(name, host, 'Ollama', 'installed' if present else 'configured', str(manifest), checked, details)
            if row:
                row['paths'] = [str(manifest)]
                row['evidence'][0]['detail'] = 'Ollama manifesti ve ağırlık dosyaları diskte mevcut.' if present else 'Ollama manifesti var; ağırlık dosyalarının tamamı doğrulanamadı.'
                rows.append(row)
            checked_files += 1
        except (OSError, ValueError, TypeError, AttributeError): partial = True
    return rows, checked_files, partial


def file_models(root, host, checked, helper):
    files, partial = bounded_files(root, max_depth=5)
    rows, count = [], 0
    for file in files:
        if file.name not in ('config.json', 'adapter_config.json') and file.suffix.lower() != '.gguf': continue
        try:
            count += 1
            if file.suffix.lower() == '.gguf':
                shards = re.fullmatch(r'(.*)-(\d+)-of-(\d+)\.gguf', file.name, re.I)
                siblings = [item for item in files if item.parent == file.parent and re.fullmatch(re.escape(shards[1]) + r'-(\d+)-of-' + re.escape(shards[3]) + r'\.gguf', item.name, re.I)] if shards else [file]
                complete = not shards or len(siblings) == int(shards[3])
                row = model_row(shards[1] if shards else file.stem, host, 'GGUF', 'installed' if complete else 'configured', str(file), checked, {'size': sum(item.stat().st_size for item in siblings)})
                if row: row['evidence'][0]['detail'] = 'GGUF dosyaları diskte mevcut.' if complete else 'GGUF dosyalarının tüm parçaları doğrulanamadı.'
            else:
                config = json.loads(helper.read_text(str(file.resolve(strict=True)), 256 * 1024))
                if not isinstance(config, dict) or not any(key in config for key in ('model_type', 'architectures', 'hidden_size', 'base_model_name_or_path', 'vocabulary')): continue
                weights = [item for item in files if item.parent == file.parent and (item.suffix == '.safetensors' or item.name == 'model.bin' or re.fullmatch(r'pytorch_model.*\.bin', item.name))]
                complete = bool(weights)
                for index_file in [item for item in files if item.parent == file.parent and item.name.endswith(('.safetensors.index.json', '.bin.index.json'))]:
                    index = json.loads(helper.read_text(str(index_file.resolve(strict=True)), 2 * 1024 * 1024))
                    expected = set(index.get('weight_map', {}).values()) if isinstance(index.get('weight_map'), dict) else set()
                    if not expected or not expected.issubset({item.name for item in weights}): complete = False
                shard_sets = {}
                for item in weights:
                    match = re.fullmatch(r'(.*)-(\d+)-of-(\d+)(\.[^.]+)', item.name)
                    if match: shard_sets.setdefault((match[1], int(match[3]), match[4]), set()).add(int(match[2]))
                if any(parts != set(range(1, total + 1)) for (_, total, _), parts in shard_sets.items()): complete = False
                cache_name = next((part[len('models--'):].replace('--', '/') for part in file.parts if part.startswith('models--')), None)
                relative = file.parent.relative_to(Path(root))
                # Fine-tuned copies often retain a base model's _name_or_path.
                # Give each artifact directory its own identity, not the base's.
                name = cache_name or (str(relative).replace(os.sep, '/') if str(relative) != '.' else file.parent.name)
                if not cache_name:
                    root_name = '/'.join(Path(root).parts[-3:]) if Path(root).name == 'embedding_model' else '/'.join(Path(root).parts[-2:])
                    name = root_name + '/' + name if str(relative) != '.' else root_name
                if file.name == 'adapter_config.json': name += ' (LoRA)'
                details = {'model_type': config.get('model_type'), 'size': sum(item.stat().st_size for item in weights), 'context_length': config.get('max_position_embeddings')}
                quantization = config.get('quantization_config')
                if isinstance(quantization, dict): details['quantization_level'] = safe_text(str(quantization.get('quant_method', '')).upper(), 80)
                row = model_row(name, host, 'Hugging Face / Transformers', 'installed' if complete else 'configured', str(file), checked, details)
                if row: row['evidence'][0]['detail'] = 'Model yapılandırması ve beklenen ağırlık dosyaları diskte mevcut.' if complete else 'Model yapılandırması var; ağırlık dosyalarının tamamı doğrulanamadı.'
            if row:
                row['paths'] = [str(file.parent if file.name.endswith('config.json') else file)]
                rows.append(row)
        except (OSError, ValueError, TypeError): partial = True
    represented = {str(Path(row['paths'][0])) for row in rows}
    weight_dirs = {file.parent for file in files if file.suffix == '.safetensors' or file.name == 'model.bin' or re.fullmatch(r'pytorch_model.*\.bin', file.name)}
    for folder in weight_dirs:
        if str(folder) in represented: continue
        weights = [file for file in files if file.parent == folder and (file.suffix == '.safetensors' or file.name == 'model.bin' or re.fullmatch(r'pytorch_model.*\.bin', file.name))]
        cache_name = next((part[len('models--'):].replace('--', '/') for part in folder.parts if part.startswith('models--')), None)
        relative = str(folder.relative_to(Path(root))).replace(os.sep, '/')
        root_name = '/'.join(Path(root).parts[-2:])
        name = cache_name or (root_name + '/' + relative if relative != '.' else root_name)
        row = model_row(name, host, 'Hugging Face / Transformers' if cache_name else 'Model dosyaları', 'configured', str(folder), checked, {'size': sum(file.stat().st_size for file in weights)})
        if row:
            row['kind'] = kind(name)
            row['paths'] = [str(folder)]
            row['evidence'][0]['detail'] = 'Ağırlık dosyaları bulundu; model yapılandırması ve tüm parça seti doğrulanamadı.'
            rows.append(row)
    return rows, count, partial


def gpu_telemetry():
    executable = shutil.which('nvidia-smi')
    if not executable: return [], 'GPU bilgisi doğrulanamadı: nvidia-smi bu sunucuda bulunamadı.'
    try:
        response = subprocess.run([executable, '--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=8, check=True)
        gpus = [{'name': safe_text(row[0]) or 'NVIDIA GPU', 'memoryTotalMiB': number(row[1]), 'memoryUsedMiB': number(row[2]), 'utilizationPercent': number(row[3])} for row in csv.reader(io.StringIO(response.stdout)) if len(row) == 4][:32]
        return gpus, 'GPU adı doğrulandı; bellek ve kullanım ölçümleri bu erişim kapsamında okunamıyor.' if gpus and all(gpu['memoryTotalMiB'] is None for gpu in gpus) else None
    except (OSError, ValueError, subprocess.SubprocessError): return [], 'GPU bilgisi doğrulanamadı: nvidia-smi yanıtı alınamadı.'


def main():
    if len(sys.argv) != 1: raise SystemExit(2)
    helper = load_connections()
    config = json.loads(helper.read_text(str(SERVER / 'model-catalog-targets.json')))
    checked = datetime.datetime.now(datetime.timezone.utc).isoformat()
    primary = config['primaryHost']
    endpoints, warnings = configured_endpoints(config, helper)
    rows, hosts, files_checked = [], {}, 0
    gpu, gpu_error = gpu_telemetry()
    hosts[primary] = {'id': primary, 'name': config['primaryName'], 'host': primary, 'status': 'online', 'gpus': gpu, 'error': gpu_error}
    if gpu_error: warnings.append(config['primaryName'] + ': ' + gpu_error)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda item: endpoint_inventory(item, primary, checked), endpoints))
    for result in results:
        rows.extend(result['models']); warnings.extend(result['warnings'])
        host = result['host']
        if host not in hosts:
            hosts[host] = {'id': host, 'name': 'Model sunucusu', 'host': host, 'status': 'unreachable', 'gpus': [], 'error': 'GPU donanımı SSH üzerinden doğrulanmadı.'}
        if result['ok']: hosts[host]['status'] = 'online'
    for root in config.get('ollamaRoots', []):
        discovered, count, partial = ollama_disk(root, primary, checked, helper)
        rows.extend(discovered); files_checked += count
        if partial: warnings.append(root + ': bazı dosyalar okunamadı veya tarama sınırına ulaşıldı.')
    for root in config.get('modelRoots', []):
        discovered, count, partial = file_models(root, primary, checked, helper)
        rows.extend(discovered); files_checked += count
        if partial: warnings.append(root + ': bazı dosyalar okunamadı veya tarama sınırına ulaşıldı.')
    if config.get('remoteTelemetry'):
        warnings.append('Eski uzak telemetri ayarları kullanılmıyor. Ek sunucuları ViiOS Sunucular bölümünden bağlayın.')
    models = merge_models(rows)
    error = None if models or any(result['ok'] for result in results) else 'Model kaynaklarına erişilemedi; boş liste sunucuda model olmadığı anlamına gelmez.'
    notes = ['Yalnızca yapılandırılmış model sunucuları ve sınırlandırılmış model dizinleri taranır; bütün ağ veya disk taraması yapılmaz.',
             'Model listesi okumak model çalıştırmaz. Ollama /api/ps dışındaki kayıtlar GPU belleğine yüklenmiş olmayı kanıtlamaz.',
             'Ulaşılamayan sunucular ve okunamayan dizinler kapsam eksikliği olarak gösterilir.',
             'GPU ve model dosyaları, bu yardımcının çalıştığı seçili sunucuda doğrulanır. Servis modellerinin bu GPU üzerinde çalıştığı ayrıca doğrulanmış değildir.']
    print(json.dumps({'models': models, 'hosts': list(hosts.values()), 'warnings': list(dict.fromkeys(warnings))[:200], 'error': error,
                      'coverage': {'hostsChecked': len(hosts), 'endpointsChecked': len(results), 'filesChecked': files_checked, 'notes': notes,
                                   'endpoints': [{'endpoint': result['base'], 'host': result['host'], 'status': 'online' if result['ok'] else 'unreachable'} for result in results]}}, ensure_ascii=False))


if __name__ == '__main__': main()
