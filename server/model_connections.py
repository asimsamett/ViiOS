"""Read-only model configuration discovery. Never imports project code or calls a model."""
import ast
import datetime
import json
import os
import pathlib
import re
import stat
import urllib.parse

SECRET = re.compile(r'(password|secret|token|api.?key|credential|authorization)', re.I)


def read_text(path, limit=2 * 1024 * 1024):
    if not isinstance(path, str) or not path.startswith('/') or '..' in pathlib.PurePosixPath(path).parts: raise ValueError('path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = pathlib.PurePosixPath(path).parts[1:]
        if not parts or any(p in ('.', '..') for p in parts): raise ValueError('path')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit: raise ValueError('size/type')
            content = stream.read(limit + 1)
            if len(content) > limit: raise ValueError('size')
            return content.decode('utf-8', errors='replace')
    finally: os.close(fd)


def safe_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value): return None
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or any(c in url.hostname for c in '$ {}'): return None
        host = '[' + url.hostname + ']' if ':' in url.hostname else url.hostname
        path = re.sub(r'(?i)/(token|api[-_]?key|secret)/[^/]+', r'/\1/[gizlendi]', url.path)
        path = re.sub(r'(?i)sk-[a-z0-9_-]{12,}', '[gizlendi]', path)
        return urllib.parse.urlunsplit((url.scheme, host + (':' + str(url.port) if url.port else ''), path, '', ''))
    except ValueError: return None


def safe_model(value):
    if not isinstance(value, str) or not re.fullmatch(r'[\w][\w./:@+-]{0,159}', value): return None
    if value.startswith(('sk-', 'eyJ', 'http:', 'https:', '/')) or value.lower() in ('none', 'true', 'false'): return None
    return value


def fields(source, environment, function=None):
    content = read_text(source)
    result = {}
    if pathlib.Path(source).name.startswith('.env'):
        for line, text in enumerate(content.splitlines(), 1):
            match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', text)
            if match and not SECRET.search(match[1]):
                value = match[2].strip().strip('"\'')
                result[match[1]] = (environment[match[1]], {'kind': 'process', 'key': match[1]}) if match[1] in environment else (value, {'kind': 'config', 'file': source, 'line': line, 'key': match[1]})
        return result
    tree = ast.parse(content)
    def value(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int)): return str(node.value), None
        if isinstance(node, ast.Name) and node.id in result: return result[node.id]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            a, b = value(node.left), value(node.right)
            if a and b: return a[0] + b[0], a[1] if a[1] and a[1].get('kind') == 'process' else b[1]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            function = node.func.attr
            owner = ast.unparse(node.func.value)
            if function in ('getenv', 'get') and owner in ('os', 'os.environ', 'environ') and node.args and isinstance(node.args[0], ast.Constant):
                key = node.args[0].value
                if not isinstance(key, str) or SECRET.search(key): return None
                if key in environment: return environment[key], {'kind': 'process', 'key': key}
                default = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == 'default'), None)
                return value(default)
            if function in ('strip', 'rstrip', 'lstrip'):
                base = value(node.func.value)
                argument = value(node.args[0]) if node.args else (' ', None)
                if base and argument: return getattr(base[0], function)(argument[0]), base[1]
        return None
    if function:
        tree = next((node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function), ast.Module(body=[], type_ignores=[]))
    def scoped_nodes(root):
        pending = [root]
        while pending:
            node = pending.pop(0)
            yield node
            pending.extend(child for child in ast.iter_child_nodes(node) if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)))
    for node in scoped_nodes(tree):
        if function and isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
            for key_node, item in zip(node.value.keys, node.value.values):
                key = key_node.value if isinstance(key_node, ast.Constant) else None
                if not isinstance(key, str) or SECRET.search(key): continue
                resolved = value(item)
                if resolved: result[key] = (resolved[0], resolved[1] or {'kind': 'source', 'file': source, 'line': item.lineno, 'key': key})
        if not isinstance(node, (ast.Assign, ast.AnnAssign)): continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            key = target.id if isinstance(target, ast.Name) else target.attr if isinstance(target, ast.Attribute) else ''
            if not key or SECRET.search(key): continue
            resolved = value(node.value)
            if resolved:
                result[key] = (resolved[0], resolved[1] or {'kind': 'source', 'file': source, 'line': node.lineno, 'key': key})
    return result


def process_environment(app, keys):
    pid = app.get('pid')
    if not isinstance(pid, int) or pid <= 0: return {}
    try:
        if os.readlink('/proc/%d/cwd' % pid) != app.get('directory'): return {}
        with open('/proc/%d/environ' % pid, 'rb') as source: content = source.read(2 * 1024 * 1024)
        pairs = (item.partition('=') for item in content.decode(errors='replace').split('\0'))
        return {key: val for key, sep, val in pairs if sep and key in keys and not SECRET.search(key)}
    except OSError: return {}


def within(path, root): return path == root or path.startswith(root.rstrip('/') + '/')


def connections(profile, environment, cache):
    output, incomplete = [], False
    for binding in profile.get('bindings', []):
        endpoint = model = None
        evidence = []
        # Explicit environment bindings are independently verified runtime settings.
        if binding.get('environment'):
            endpoint = safe_url(environment.get(binding['url']))
            model = safe_model(environment.get(binding.get('model', '')))
            if endpoint: evidence.append({'kind': 'process', 'key': binding['url']})
            if model: evidence.append({'kind': 'process', 'key': binding['model']})
        if (not endpoint or not model) and binding.get('file'):
            file = binding['file']
            try:
                identity = (file, binding.get('function'), tuple(sorted(environment.items())))
                if identity not in cache: cache[identity] = fields(file, environment, binding.get('function'))
                data = cache[identity]
                url_field = data.get(binding['url'])
                model_field = data.get(binding.get('model'))
                if url_field and not endpoint:
                    endpoint = safe_url(url_field[0])
                    if endpoint: evidence.append(url_field[1])
                if model_field and not model:
                    model = safe_model(model_field[0])
                    if model: evidence.append(model_field[1])
            except (OSError, ValueError, SyntaxError, RecursionError): incomplete = True
        if endpoint:
            output.append({'endpoint': endpoint, 'model': model, 'role': binding.get('role', 'chat'), 'evidence': evidence,
                           'scope': 'process' if any(e['kind'] == 'process' for e in evidence) else 'project'})
    unique = {}
    for row in output:
        key = (row['endpoint'], row['model'], row['role'])
        if key not in unique: unique[key] = row
        else:
            for evidence in row['evidence']:
                if evidence not in unique[key]['evidence']: unique[key]['evidence'].append(evidence)
    return list(unique.values()), incomplete


def discover(apps, config_path):
    profiles = json.loads(read_text(config_path))
    checked = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cache, snapshots = {}, []
    for profile in profiles:
        rows, incomplete = connections(profile, {}, cache)
        snapshots.append({'roots': profile['roots'], 'modelConnections': rows,
                          'modelDiscovery': {'checkedAt': checked, 'status': 'partial' if incomplete else 'found' if rows else 'not-found'}})
    for app in apps:
        matches = [(max(len(root) for root in p['roots'] if within(app.get('directory', ''), root)), p) for p in profiles if any(within(app.get('directory', ''), root) for root in p['roots'])]
        if not matches: continue
        profile = max(matches, key=lambda match: match[0])[1]
        keys = {binding.get(key) for binding in profile.get('bindings', []) for key in ('url', 'model') if binding.get(key)}
        keys.update(key for binding in profile.get('bindings', []) for key in binding.get('environmentKeys', []))
        environment = process_environment(app, keys)
        rows, incomplete = connections(profile, environment, cache)
        app['modelConnections'] = rows
        app['modelDiscovery'] = {'checkedAt': checked, 'status': 'partial' if incomplete else 'found' if rows else 'not-found'}
    return snapshots
