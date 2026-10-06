import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('scanner',pathlib.Path(__file__).parents[1]/'server'/'scan.py')
scanner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)

class ScannerTests(unittest.TestCase):
    def test_all_ports_tcp_udp_and_ipv6_are_deduplicated(self):
        raw='''udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=7,fd=3))
tcp LISTEN 0 128 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=7,fd=4))
tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9,fd=3))
tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=9,fd=4))
udp UNCONN 0 0 [::1]:65535 [::]:* users:(("service",pid=10,fd=3))
tcp LISTEN 0 128 127.0.0.1:1 0.0.0.0:*'''
        apps=scanner.parse_listeners(raw,1,65535)
        self.assertEqual(sorted(a['port'] for a in apps),[1,22,53,65535])
        dns=next(a for a in apps if a['port']==53)
        self.assertEqual(set(dns['transports']),{'tcp','udp'})
        self.assertEqual(len(dns['listeners']),2)
        ssh=next(a for a in apps if a['port']==22)
        self.assertEqual(ssh['addresses'],['0.0.0.0','::'])
        self.assertEqual(scanner.parse_listeners(raw,8000,8999),[])
    def test_non_http_services_do_not_get_http_probes(self):
        raw='tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9,fd=3))'
        app=scanner.inspect(scanner.parse_listeners(raw,1,65535)[0])
        self.assertFalse(app['httpApplicable'])
        self.assertEqual(app['protocol'],'tcp')
    def test_html_metadata_only_extracts_title(self):
        p=scanner.Metadata();p.feed('<title>App &amp; Dashboard</title><body>Do not retain content</body>')
        self.assertEqual(p.title,'App & Dashboard')

if __name__=='__main__': unittest.main()
