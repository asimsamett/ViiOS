"""Read-only Linux TCP inventory. Run locally or send over SSH on stdin."""
import concurrent.futures
import html.parser
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import pathlib
import runpy

HEADERS = {}


class Metadata(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title = ''
    def handle_starttag(self, tag, attrs):
        if tag == 'title': self.in_title = True
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
    def handle_data(self, data):
        if self.in_title: self.title += data


def parse_listeners(raw, start, end):
    ports = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 4: continue
        transport = parts[0] if parts[0] in ('tcp', 'udp') else 'tcp'
        address = parts[4] if parts[0] in ('tcp', 'udp') else parts[3]
        try: port = int(address.rsplit(':', 1)[1])
        except ValueError: continue
        if not start <= port <= end: continue
        pid = re.search(r'pid=(\d+)', line)
        process = re.search(r'users:\(\("([^"]+)"', line)
        app = ports.setdefault(port, {'port': port, 'addresses': [], 'transports': [], 'listeners': [], 'pid': int(pid[1]) if pid else None,
                                     'process': process[1] if process else '', 'directory': '', 'entry': ''})
        host = address.rsplit(':', 1)[0].strip('[]')
        if host not in app['addresses']: app['addresses'].append(host)
        if transport not in app['transports']: app['transports'].append(transport)
        app['listeners'].append({'transport': transport, 'address': host, 'pid': int(pid[1]) if pid else None, 'process': process[1] if process else ''})
        if transport == 'tcp':
            app['pid'] = int(pid[1]) if pid else app['pid']
            app['process'] = process[1] if process else app['process']
    return list(ports.values())


def probe(host, port, protocol, unverified=False, host_header=None):
    context = ssl._create_unverified_context() if unverified else ssl.create_default_context()
    path = '/'
    for _ in range(5):
        conn = http.client.HTTPSConnection(host, port, timeout=5, context=context) if protocol == 'https' else http.client.HTTPConnection(host, port, timeout=5)
        try:
            headers = {'User-Agent': 'AllManagement/1.0 (read-only inventory)', 'Accept': 'text/html,application/json;q=0.8'}
            if host_header: headers['Host'] = host_header
            conn.request('GET', path, headers=headers)
            response = conn.getresponse()
            body = response.read(196608)
            if response.status in (301, 302, 303, 307, 308) and response.getheader('Location'):
                target = urllib.parse.urlsplit(urllib.parse.urljoin('%s://%s:%d%s' % (protocol, '[::1]' if host == '::1' else host, port, path), response.getheader('Location')))
                # Never follow redirects to an unrelated host or port.
                if target.hostname not in ('localhost', '127.0.0.1', '::1', host) or target.port not in (None, port):
                    return {'status': response.status, 'protocol': protocol, 'path': path, 'title': '', 'kind': 'web', 'tlsUnverified': unverified}
                if target.scheme not in ('http', 'https'): break
                protocol = target.scheme
                path = target.path or '/'
                if target.query: path += '?' + target.query
                continue
            mime = response.getheader('Content-Type', '')
            metadata = Metadata()
            if 'html' in mime:
                metadata.feed(body.decode('utf-8', errors='replace'))
            title = re.sub(r'\s+', ' ', metadata.title).strip()[:180]
            return {'status': response.status, 'protocol': protocol, 'path': path, 'title': title,
                    'kind': 'web' if 'html' in mime and response.status < 400 else 'api' if 'json' in mime else 'service',
                    'contentType': mime, 'tlsUnverified': unverified}
        finally:
            conn.close()
    raise RuntimeError('Too many redirects')


def inspect(app):
    try:
        app['directory'] = os.readlink('/proc/%s/cwd' % app['pid'])
        with open('/proc/%s/cmdline' % app['pid'], 'rb') as f:
            args = f.read(16384).decode('utf-8', errors='replace').split('\x00')
        # Only filenames; command arguments may contain credentials.
        app['entry'] = next((os.path.basename(arg) for arg in args if arg.endswith('.py')), '')
    except (OSError, TypeError): pass
    def loopback(a):
        try: return ipaddress.ip_address(a.split('%')[0]).is_loopback
        except ValueError: return False
    app['internal'] = all(loopback(a) for a in app['addresses'])
    host = '127.0.0.1'
    if app['addresses'] == ['::1']: host = '::1'
    elif not any(a in ('0.0.0.0', '*', '::', '127.0.0.1') for a in app['addresses']): host = app['addresses'][0].split('%')[0]
    app['probeHost'] = host
    non_http = app['process'] in ('sshd', 'systemd-resolve', 'postgres', 'mysqld', 'redis-server', 'memcached', 'avahi-daemon') or app['port'] in (22, 53, 5432, 5433, 3306, 6379)
    if 'tcp' not in app['transports'] or non_http:
        app.update({'status': None, 'protocol': '+'.join(sorted(app['transports'])), 'path': '/', 'title': '', 'kind': 'service', 'httpApplicable': False, 'latency': 0})
        return app
    host_header = HEADERS.get(str(app['port']))
    started = time.monotonic()
    for protocol in ('http', 'https'):
        try:
            try: result = probe(host, app['port'], protocol, host_header=host_header)
            except ssl.SSLCertVerificationError: result = probe(host, app['port'], protocol, True, host_header)
            app.update(result)
            app['httpApplicable'] = True
            break
        except Exception:
            app.update({'status': None, 'protocol': 'tcp', 'path': '/', 'title': '', 'kind': 'service', 'httpApplicable': False, 'httpProbeError': 'HTTP/HTTPS protokolü tanınmadı.'})
    if app.get('status'): app.pop('error', None)
    app['latency'] = round((time.monotonic() - started) * 1000)
    return app


def main():
    global HEADERS
    start, end = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= start <= end <= 65535: raise ValueError('Invalid port range')
    if len(sys.argv) > 3:
        HEADERS = json.loads(sys.argv[3])
    elif '__file__' in globals():
        # The privileged deployment runs this root-owned script from disk.
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'apps.json')
        if os.path.isfile(config_path):
            with open(config_path, encoding='utf-8') as config_file:
                config = json.load(config_file)
            HEADERS = {port: value['hostHeader'] for port, value in config.items() if value.get('hostHeader')}
    raw = subprocess.check_output(['ss', '-lntupH'], text=True, timeout=10)
    apps = parse_listeners(raw, start, end)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        apps = list(pool.map(inspect, sorted(apps, key=lambda a: a['port'])))
    model_profiles = []
    module_root = pathlib.Path(__file__).resolve().parent if '__file__' in globals() and __file__ != '<stdin>' else pathlib.Path('/opt/viios-agent')
    try:
        module = runpy.run_path(str(module_root / 'model_connections.py'))
        model_profiles = module['discover'](apps, str(module_root / 'model-targets.json'))
    except Exception:
        for app in apps:
            app['modelConnections'] = []
            app['modelDiscovery'] = {'status': 'unavailable'}
    print(json.dumps({'hostname': socket.gethostname(), 'apps': apps, 'modelProfiles': model_profiles}, ensure_ascii=False))


if __name__ == '__main__': main()
