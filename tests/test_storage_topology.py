import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', pathlib.Path(__file__).parents[1] / 'server/storage.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class TopologyTests(unittest.TestCase):
    def test_kernel_graph_partition_and_layer_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            for name, identity in [('sda', '8:0'), ('sda1', '8:1'), ('dm-0', '253:0'), ('loop0', '7:0')]:
                device = base / name
                (device / 'slaves').mkdir(parents=True)
                (device / 'dev').write_text(identity)
                (device / 'size').write_text('2048')
                (device / 'stat').write_text('1 0 10 0 1 0 20 0')
            (base / 'sda1' / 'partition').write_text('1')
            (base / 'dm-0' / 'slaves' / 'sda1').mkdir()
            (base / 'dm-0' / 'slaves' / 'sda1' / 'dev').write_text('8:1')
            with patch.object(pathlib.Path, 'resolve', return_value=base / 'sda' / 'sda1'):
                rows = {r['id']: r for r in s.block_snapshot(base)}
            self.assertEqual(set(rows), {'8:0', '8:1', '253:0'})
            self.assertEqual(rows['8:1']['parentIds'], ['8:0'])
            self.assertEqual(rows['253:0']['parentIds'], ['8:1'])
            self.assertEqual(rows['253:0']['kind'], 'logical')
            self.assertEqual(rows['8:0']['sizeBytes'], 1048576)

    def test_rates_and_volume_identity_without_duplicate_capacity(self):
        first = [dict(id='8:1', name='/dev/sda1', kind='partition', sizeBytes=1000, parentIds=['8:0'], volumeIds=[], readCounter=100, writeCounter=300)]
        second = [dict(first[0], readCounter=300, writeCounter=400)]
        snapshots = iter([first, second]); clock = iter([10, 10.5])
        value = s.storage_topology([{'id':'8:1:/', 'source':'/dev/disk/by-uuid/example'}], snapshot=lambda: next(snapshots), sleep=lambda _:None, clock=lambda:next(clock))
        row = value['devices'][0]
        self.assertEqual(row['readBytesPerSecond'], 400)
        self.assertEqual(row['writeBytesPerSecond'], 200)
        self.assertEqual(row['volumeIds'], ['8:1:/'])
        self.assertNotIn('readCounter', row)
        self.assertNotIn('totalBytes', value)

    def test_reset_counter_and_new_device_are_unknown_not_zero(self):
        def row(counter): return dict(id='8:0', name='/dev/sda', kind='disk', volumeIds=[], readCounter=counter, writeCounter=counter)
        snapshots=iter([[row(100)], [row(1), dict(row(5),id='8:16')]])
        result=s.storage_topology([],snapshot=lambda:next(snapshots),sleep=lambda _:None,clock=iter([0,1]).__next__)
        self.assertTrue(all(r['readBytesPerSecond'] is None for r in result['devices']))

    def test_unavailable_topology_preserves_explicit_unknown(self):
        def unavailable(): raise OSError('not mounted')
        result=s.storage_topology([],snapshot=unavailable)
        self.assertFalse(result['available'])
        self.assertEqual(result['devices'],[])

    def test_disappearing_device_is_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=pathlib.Path(tmp); (base/'sda').mkdir()
            result=s.storage_topology([],snapshot=lambda:s.block_snapshot(base),sleep=lambda _:None,clock=iter([0,1]).__next__)
            self.assertTrue(result['partial'])
            self.assertIsNone(result['devices'][0]['sizeBytes'])

if __name__ == '__main__': unittest.main()
