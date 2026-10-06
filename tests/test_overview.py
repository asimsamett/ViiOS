import importlib.util
import pathlib
import unittest
import tempfile
from unittest import mock

spec = importlib.util.spec_from_file_location('resources', pathlib.Path(__file__).parents[1] / 'server/resources.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class OverviewTests(unittest.TestCase):
    def test_device_discovery_excludes_partitions_stacked_disks_and_loopback(self):
        real_path = pathlib.Path
        with tempfile.TemporaryDirectory() as folder:
            base = real_path(folder)
            for name in ['sda', 'dm-0', 'md0', 'loop0', 'ram0', 'zram0']:
                target = base / 'sys/block' / name
                target.mkdir(parents=True)
                (target / 'stat').write_text('1 0 10 0 2 0 20 0 0 0 0')
            (base / 'proc/net').mkdir(parents=True)
            (base / 'proc/net/dev').write_text('header\nheader\nlo: 99 0 0 0 0 0 0 0 99\neth0: 100 0 0 0 0 0 0 0 200\n')
            with mock.patch.object(r.pathlib, 'Path', side_effect=lambda value: base / str(value).lstrip('/')):
                result = r.device_counters()
            self.assertEqual(result['disks'], {'sda': {'read': 5120, 'write': 10240}})
            self.assertEqual(result['network'], {'eth0': {'read': 100, 'write': 200}})

    def test_linux_identity_temperature_addresses_and_top_processes(self):
        real_path = pathlib.Path
        with tempfile.TemporaryDirectory() as folder:
            base = real_path(folder)
            (base / 'etc').mkdir()
            (base / 'etc/os-release').write_text('PRETTY_NAME="Test Linux"\n')
            sensor = base / 'sys/class/hwmon/hwmon0'
            sensor.mkdir(parents=True)
            (sensor / 'name').write_text('coretemp')
            (sensor / 'temp1_input').write_text('45000')
            (sensor / 'temp2_input').write_text('51000')
            before = {1: {'started': 2, 'ticks': 10}}
            after = {1: {'pid': 1, 'name': 'worker', 'state': 'S', 'rss': 42, 'started': 2, 'ticks': 30},
                     2: {'pid': 2, 'name': 'new', 'state': 'R', 'rss': 100, 'started': 4, 'ticks': 900}}
            first = {'at': 1, 'network': {}, 'disks': {}}
            with mock.patch.object(r.pathlib, 'Path', side_effect=lambda value: base / str(value).lstrip('/')), \
                    mock.patch.object(r.subprocess, 'check_output', return_value='[{"addr_info":[{"scope":"global","local":"192.0.2.10"},{"scope":"host","local":"127.0.0.1"}]}]'):
                result = r.overview(before, after, 200, first, {**first, 'at': 2})
            self.assertEqual(result['os'], 'Test Linux')
            self.assertEqual(result['addresses'], ['192.0.2.10'])
            self.assertEqual(result['cpuTemperatureC'], 51)
            self.assertEqual(result['topProcesses'][0]['cpuPercent'], 10)
            self.assertIsNone(result['topProcesses'][1]['cpuPercent'])

    def test_optional_linux_metadata_failure_does_not_break_metrics(self):
        with mock.patch.object(r.pathlib.Path, 'read_text', side_effect=PermissionError), \
                mock.patch.object(r.pathlib.Path, 'glob', return_value=[]), \
                mock.patch.object(r.subprocess, 'check_output', side_effect=OSError):
            sample = {'at': 1, 'network': {}, 'disks': {}}
            result = r.overview({}, {}, 0, sample, sample)
            self.assertEqual(result['platform'], 'linux')
            self.assertIsNone(result['cpuTemperatureC'])
            self.assertEqual(result['addresses'], [])

    def test_rates_reject_resets_and_new_devices(self):
        first = {'at': 10, 'network': {'eth0': {'read': 100, 'write': 200}, 'eth1': {'read': 5, 'write': 5}}}
        last = {'at': 12, 'network': {'eth0': {'read': 300, 'write': 600}, 'eth1': {'read': 1, 'write': 6}, 'new': {'read': 1, 'write': 1}}}
        rows = r.counter_rates(first, last, 'network')
        self.assertEqual(rows[0]['readBytesPerSecond'], 100)
        self.assertEqual(rows[0]['writeBytesPerSecond'], 200)
        self.assertIsNone(rows[1]['readBytesPerSecond'])
        self.assertIsNone(rows[2]['writeBytesPerSecond'])

    def test_zero_interval_and_zero_traffic_are_different(self):
        first = {'at': 1, 'disks': {'sda': {'read': 10, 'write': 20}}}
        self.assertIsNone(r.counter_rates(first, first, 'disks')[0]['readBytesPerSecond'])
        self.assertEqual(r.counter_rates(first, {**first, 'at': 2}, 'disks')[0]['readBytesPerSecond'], 0)


if __name__ == '__main__':
    unittest.main()
