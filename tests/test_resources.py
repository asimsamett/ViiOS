import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('resources', pathlib.Path(__file__).parents[1] / 'server/resources.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ResourceTests(unittest.TestCase):
    def test_process_stat_parses_complex_names_and_page_size(self):
        fields = ['0'] * 22
        fields[0], fields[1], fields[11], fields[12], fields[19], fields[21] = 'S', '10', '40', '60', '500', '3'
        proc = r.parse_process('42 (worker (test) )) ' + ' '.join(fields), 65536)
        self.assertEqual(proc['name'], 'worker (test) )')
        self.assertEqual((proc['pid'], proc['parent'], proc['ticks'], proc['started'], proc['rss']), (42, 10, 100, 500, 196608))

    def test_cpu_normalizes_host_capacity_and_rejects_reused_pids(self):
        self.assertEqual(r.cpu_percent({'started': 1, 'ticks': 100}, {'started': 1, 'ticks': 200}, 800), 12.5)
        self.assertIsNone(r.cpu_percent({'started': 1, 'ticks': 100}, {'started': 2, 'ticks': 200}, 800))
        self.assertIsNone(r.cpu_percent({'started': 1, 'ticks': 100}, {'started': 1, 'ticks': 90}, 800))
        self.assertIsNone(r.cpu_percent(None, {'started': 1, 'ticks': 200}, 800))
        self.assertIsNone(r.cpu_percent({'started': 1, 'ticks': 100}, {'started': 1, 'ticks': 200}, 0))
        self.assertEqual(r.cpu_totals('cpu 10 20 30 40 50 60 70 80 500 500'), {'total': 360, 'idle': 90})

    def test_memory_uses_available_and_marks_missing_data(self):
        data = r.memory('MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 10 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB')
        self.assertEqual((data['usedBytes'], data['percent'], data['swapUsedBytes']), (600 * 1024, 60, 50 * 1024))
        self.assertIsNone(r.memory('MemTotal: 1000 kB')['percent'])

    def test_all_socket_workers_and_shared_ports_are_deduplicated(self):
        raw = '\n'.join([
            'tcp LISTEN 0 100 0.0.0.0:8000 0.0.0.0:* users:(("worker",pid=10,fd=1),("worker",pid=11,fd=2))',
            'tcp LISTEN 0 100 [::]:8000 [::]:* users:(("worker",pid=10,fd=3))',
            'udp UNCONN 0 0 0.0.0.0:8001 0.0.0.0:* users:(("worker",pid=11,fd=3))',
            'tcp LISTEN 0 100 0.0.0.0:9000 0.0.0.0:* users:(("other",pid=20,fd=1))'])
        groups = r.group_listeners(r.listeners(raw))
        shared = next(g for g in groups if 8000 in g['ports'])
        self.assertEqual(len(groups), 2)
        self.assertEqual(shared['ports'], {8000, 8001})
        self.assertEqual(shared['pids'], {10, 11})
        self.assertEqual(shared['transports'], {'tcp', 'udp'})

    def test_missing_owner_does_not_merge_unrelated_ports_or_hide_partial_data(self):
        raw = '\n'.join(['tcp LISTEN 0 10 0.0.0.0:8000 *:* users:(("worker",pid=10,fd=1))',
                         'tcp LISTEN 0 10 [::]:8000 *:*', 'tcp LISTEN 0 10 [::]:9000 *:*'])
        groups = r.group_listeners(r.listeners(raw))
        self.assertEqual(len(groups), 2)
        self.assertTrue(all(g['unknownOwner'] for g in groups))

    def test_descendants_use_nearest_listener_without_claiming_all_system_services(self):
        groups = [{'pids': {1}}, {'pids': {10}}, {'pids': {20}}]
        snapshot = {1: {'parent': 0}, 2: {'parent': 1}, 10: {'parent': 1}, 11: {'parent': 10}, 20: {'parent': 10}, 21: {'parent': 20}}
        self.assertEqual(r.owned_processes(groups, snapshot), [{1}, {10, 11}, {20, 21}])

    def test_io_rates_use_each_process_sample_interval_and_pid_identity(self):
        before = {1: {'started': 100}, 2: {'started': 200}}
        after = {1: {'started': 100}, 2: {'started': 200}}
        first = {1: {'read_bytes': 100, 'at': 1.0}, 2: {'read_bytes': 20, 'at': 1.5}}
        last = {1: {'read_bytes': 300, 'at': 3.0}, 2: {'read_bytes': 220, 'at': 2.5}}
        self.assertEqual(r.rate({1, 2}, before, after, first, last, 'read_bytes', 1), 300)
        after[1]['started'] = 300
        self.assertIsNone(r.rate({1, 2}, before, after, first, last, 'read_bytes', 1))


if __name__ == '__main__':
    unittest.main()
