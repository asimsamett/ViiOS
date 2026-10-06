import importlib.util
import os
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', pathlib.Path(__file__).parents[1] / 'server/storage.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

MOUNTS = '''1 0 8:2 / / rw - ext4 /dev/sda2 rw
2 1 8:3 / /boot rw - ext4 /dev/sda3 rw
3 1 8:4 / /home rw - ext4 /dev/sda4 rw
4 1 8:17 / /srv rw - ext4 /dev/sdb1 rw
5 1 8:2 /usr/share/hunspell /var/snap/firefox/common/host-hunspell rw - ext4 /dev/sda2 rw
6 1 7:0 / /snap/core/123 ro - squashfs /dev/loop0 ro
7 1 0:51 / /var/lib/docker/overlay2/merged rw - overlay overlay rw
8 1 0:10 / /proc rw - proc proc rw
9 1 0:11 / /run rw - tmpfs tmpfs rw
'''


class CapacityTests(unittest.TestCase):
    def test_namespace_already_host_does_not_enter_or_open_anything(self):
        with patch.object(s.os, 'stat', return_value=SimpleNamespace(st_ino=1)), patch.object(s.os, 'open') as open_fd:
            s.enter_host_mount_namespace()
        open_fd.assert_not_called()

    def test_namespace_failure_is_closed_and_host_namespace_fd_is_released(self):
        with patch.object(s.os, 'stat', side_effect=[SimpleNamespace(st_ino=1), SimpleNamespace(st_ino=2)]), \
                patch.object(s.os, 'open', return_value=7) as open_fd, patch.object(s.os, 'close') as close_fd, \
                patch.object(s.os, 'O_CLOEXEC', 0, create=True), \
                patch.object(s.ctypes, 'CDLL') as library:
            library.return_value.setns.return_value = -1
            with self.assertRaises(OSError):
                s.enter_host_mount_namespace()
            self.assertEqual(open_fd.call_args.args[0], '/proc/1/ns/mnt')
            library.return_value.setns.assert_called_once_with(7, 0x00020000)
            close_fd.assert_called_once_with(7)
    def test_whole_server_deduplicates_bind_and_excludes_virtual_and_loop(self):
        mounts = s.parse_mounts(MOUNTS)
        # Deliberately rounded synthetic volumes, unrelated to any host inventory.
        gib = 1024 ** 3
        values = {'/': 128 * gib, '/boot': gib, '/home': 256 * gib, '/srv': 512 * gib}
        def statvfs(value):
            return SimpleNamespace(f_frsize=4096, f_bsize=4096, f_blocks=values[value] // 4096,
                                   f_bfree=100, f_bavail=70)
        result = s.filesystem_overview(mounts, statvfs)
        self.assertTrue(result['available'])
        self.assertEqual(result['summary']['volumeCount'], 4)
        self.assertEqual(result['summary']['totalBytes'], 897 * gib)
        self.assertEqual(result['summary']['reservedBytes'], 4 * 30 * 4096)
        self.assertEqual(result['summary']['usedBytes'] + result['summary']['freeBytes'], result['summary']['totalBytes'])
        self.assertEqual(result['summary']['availableBytes'] + result['summary']['reservedBytes'], result['summary']['freeBytes'])

    def test_readonly_physical_volume_and_escaped_mounts_are_supported(self):
        mounts = s.parse_mounts('1 0 8:9 / /media/my\\040disk ro - ext4 /dev/sdc1 ro')
        self.assertEqual(s.persistent_mounts(mounts)[0]['mount'], '/media/my disk')

    def test_btrfs_subvolumes_do_not_multiply_capacity_even_when_device_ids_differ(self):
        mounts = s.parse_mounts('1 0 0:31 /@ / rw - btrfs /dev/sda1 rw\n2 1 0:32 /@home /home rw - btrfs /dev/sda1 rw')
        self.assertEqual(len(s.persistent_mounts(mounts)), 1)

    def test_missing_capacity_keeps_known_volumes_but_never_invents_complete_total(self):
        def statvfs(value):
            if value == '/home':
                raise OSError('unavailable')
            return SimpleNamespace(f_frsize=1, f_bsize=1, f_blocks=100, f_bfree=20, f_bavail=10)
        result = s.filesystem_overview(s.parse_mounts(MOUNTS), statvfs)
        self.assertFalse(result['available'])
        self.assertIsNone(result['summary']['totalBytes'])
        self.assertEqual(result['volumes'][0]['totalBytes'], 100)
        self.assertIsNone(next(row for row in result['volumes'] if row['mount'] == '/home')['totalBytes'])

    def test_reserved_and_empty_volumes_are_not_used_bytes(self):
        result = s.capacity(SimpleNamespace(f_frsize=4, f_bsize=4, f_blocks=100, f_bfree=30, f_bavail=20))
        self.assertEqual(result, {'totalBytes': 400, 'usedBytes': 280, 'freeBytes': 120,
                                  'availableBytes': 80, 'reservedBytes': 40, 'percent': 70})
        self.assertIsNone(s.capacity(SimpleNamespace(f_frsize=1, f_bsize=1, f_blocks=0, f_bfree=0, f_bavail=0))['percent'])

    def test_input_rejects_relative_traversal_controls_extra_fields_and_unbounded_lists(self):
        for value in ['../etc', '/home/../etc', '/a/./b', '/a//b', '/a/', '/a\x00b', '/x\ny', ['/', '/home']]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                s.valid_path(value)
        for request in [{'action': 'shell'}, {'action': 'overview', 'command': 'id'},
                        {'action': 'usage', 'path': '/' + 'x' * 4096}, {'action': 'apps', 'paths': ['/home/a'] * 81}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                s.validate_request(request)
        self.assertEqual(s.valid_path('/home/Uygulama adı'), '/home/Uygulama adı')


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW'), 'Linux fd traversal')
class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.mounts = s.parse_mounts('1 0 8:2 / / rw - ext4 /dev/sda2 rw')

    def tearDown(self):
        self.temp.cleanup()

    def test_hardlinks_once_sparse_allocated_bytes_and_symlinks_excluded(self):
        original = self.root / 'file'
        original.write_bytes(b'x' * 8192)
        os.link(original, self.root / 'hardlink')
        os.symlink(original, self.root / 'symlink')
        sparse = self.root / 'sparse'
        with sparse.open('wb') as stream:
            stream.seek(16 * 1024 * 1024)
            stream.write(b'x')
        result = s.UsageScanner(self.mounts).scan(str(self.root))
        expected = sum(item.stat().st_blocks * 512 for item in [self.root, original, sparse])
        self.assertEqual(result['totalBytes'], expected)
        self.assertNotIn('symlink', [row['name'] for row in result['entries']])
        self.assertFalse(result['partial'])
        self.assertLess(result['totalBytes'], 16 * 1024 * 1024)

    def test_same_device_bind_and_virtual_mounts_excluded_and_navigability_explicit(self):
        mounted, virtual = self.root / 'bound', self.root / 'virtual'
        mounted.mkdir()
        virtual.mkdir()
        (mounted / 'large').write_bytes(b'x' * 8192)
        self.mounts += s.parse_mounts(f'2 1 8:2 /other {mounted} rw - ext4 /dev/sda2 rw\n3 1 0:1 / {virtual} rw - proc proc rw')
        result = s.UsageScanner(self.mounts).scan(str(self.root))
        by_name = {row['name']: row for row in result['entries']}
        self.assertIsNone(by_name['bound']['bytes'])
        self.assertTrue(by_name['bound']['navigable'])
        self.assertFalse(by_name['virtual']['navigable'])
        self.assertEqual(result['totalBytes'], self.root.stat().st_blocks * 512)

    def test_nested_mount_is_excluded_below_immediate_directory(self):
        parent = self.root / 'parent'
        child = parent / 'bound'
        child.mkdir(parents=True)
        (child / 'data').write_bytes(b'x' * 8192)
        self.mounts += s.parse_mounts(f'2 1 8:2 /other {child} rw - ext4 /dev/sda2 rw')
        result = s.UsageScanner(self.mounts).scan(str(self.root))
        self.assertEqual(result['totalBytes'], (self.root.stat().st_blocks + parent.stat().st_blocks) * 512)
        self.assertEqual(result['excludedMounts'], 1)

    def test_symlink_in_requested_path_is_never_followed(self):
        (self.root / 'directory').mkdir()
        os.symlink(self.root / 'directory', self.root / 'alias')
        with self.assertRaises(OSError):
            s.UsageScanner(self.mounts).scan(str(self.root / 'alias'))

    def test_bounded_scan_is_partial_lower_bound_not_complete_zero(self):
        for index in range(8):
            (self.root / str(index)).write_bytes(b'x' * 4096)
        result = s.UsageScanner(self.mounts, max_nodes=2).scan(str(self.root))
        self.assertTrue(result['partial'])
        self.assertGreater(result['totalBytes'], 0)
        self.assertLess(len(result['entries']), 8)

    def test_unreadable_child_is_null_and_partial(self):
        (self.root / 'blocked').mkdir()
        original = os.open
        def open_fd(value, flags, **kwargs):
            if value == 'blocked':
                raise PermissionError('denied')
            return original(value, flags, **kwargs)
        with patch.object(s.os, 'open', side_effect=open_fd):
            result = s.UsageScanner(self.mounts).scan(str(self.root))
        self.assertTrue(result['partial'])
        self.assertIsNone(result['entries'][0]['bytes'])


if __name__ == '__main__':
    unittest.main()
