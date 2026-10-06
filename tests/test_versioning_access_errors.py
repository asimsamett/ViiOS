"""ACL errno/rollback regression tests without privileged filesystem operations."""
import contextlib
import errno
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


# The broker runs only on Linux. Stub import-time POSIX symbols on Windows so
# error classification can also be checked on a Windows controller workstation.
with contextlib.ExitStack() as loading:
    for name in ('fcntl', 'pwd'):
        if importlib.util.find_spec(name) is None:
            loading.enter_context(patch.dict(sys.modules, {name: types.ModuleType(name)}))
    for name in ('O_NOFOLLOW', 'O_CLOEXEC', 'O_NONBLOCK'):
        if not hasattr(os, name):
            loading.enter_context(patch.object(os, name, 0, create=True))
    spec = importlib.util.spec_from_file_location('versioning_access_errors', Path(__file__).resolve().parents[1] / 'server/versioning_access.py')
    access = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(access)


class AclErrorTests(unittest.TestCase):
    def test_only_acl_syscalls_classify_errno_and_json_keeps_the_code(self):
        cases = [(errno.ENOTSUP, 'ACL_UNSUPPORTED', 501), (errno.EOPNOTSUPP, 'ACL_UNSUPPORTED', 501),
                 (errno.EACCES, 'ACL_ACCESS_DENIED', 403), (errno.EPERM, 'ACL_ACCESS_DENIED', 403),
                 (errno.EIO, 'ACL_UPDATE_FAILED', 409)]
        operations = [('getxattr', lambda: access.get_acl(17, access.ACCESS)),
                      ('setxattr', lambda: access.set_acl(17, access.DEFAULT, b'fixture')),
                      ('removexattr', lambda: access.remove_acl(17, access.ACCESS))]
        for number, code, status in cases:
            for name, operation in operations:
                with self.subTest(errno=number, syscall=name), patch.object(access.os, name, side_effect=OSError(number, 'private fixture detail'), create=True):
                    with self.assertRaises(access.Problem) as raised:
                        operation()
                    payload = json.loads(json.dumps(raised.exception.response()))
                    self.assertEqual(payload['code'], code)
                    self.assertEqual(payload['status'], status)
                    self.assertNotIn('private fixture detail', payload['error'])

    def test_missing_acl_is_normal_for_reads_and_removal_but_not_writes(self):
        with patch.object(access.os, 'getxattr', side_effect=OSError(errno.ENODATA, 'missing'), create=True):
            self.assertIsNone(access.get_acl(17, access.ACCESS))
        with patch.object(access.os, 'removexattr', side_effect=OSError(errno.ENODATA, 'missing'), create=True):
            self.assertIsNone(access.remove_acl(17, access.ACCESS))
        with patch.object(access.os, 'setxattr', side_effect=OSError(errno.ENODATA, 'missing'), create=True):
            with self.assertRaises(access.Problem) as raised:
                access.set_acl(17, access.ACCESS, b'fixture')
            self.assertEqual(raised.exception.code, 'ACL_UPDATE_FAILED')

    def test_non_acl_policy_and_file_permission_errors_are_not_classified(self):
        self.assertEqual(access.Problem('Protected project', 403).response(), {'error': 'Protected project', 'status': 403})
        record = {'uid': 42, 'mode': 0o600, 'rights': 6, 'directory': False}
        with patch.object(access, 'same_inode', return_value=True), patch.object(access, 'get_acl', return_value=None), patch.object(access.os, 'fchmod', side_effect=OSError(errno.EACCES, 'not ACL'), create=True):
            with self.assertRaises(OSError):
                access.apply_record(17, record, 42)

    def test_failed_acl_write_still_rolls_back_every_record_applied_before_it(self):
        records = [dict(path='/fixture/first', directory=False), dict(path='/fixture/second', directory=False)]
        summary = {'path': '/fixture', 'accessRevision': 'fixture-revision'}
        visits = []

        def apply(fd, record, uid):
            visits.append(record['path'])
            if len(visits) == 2:
                with patch.object(access.os, 'setxattr', side_effect=OSError(errno.EPERM, 'denied'), create=True):
                    access.set_acl(fd, access.ACCESS, b'fixture')

        with tempfile.TemporaryDirectory(prefix='viios-acl-error-') as folder, \
             patch.object(access, 'STORE', Path(folder)), \
             patch.object(access, 'collect', return_value=(summary, records, 42)), \
             patch.object(access, 'opened', side_effect=lambda _path: contextlib.nullcontext(17)), \
             patch.object(access, 'same_inode', return_value=True), \
             patch.object(access, 'get_acl', return_value=None), \
             patch.object(access.os, 'fstat', return_value=types.SimpleNamespace(st_mode=0o100600)), \
             patch.object(access, 'apply_record', side_effect=apply), \
             patch.object(access, 'restore_records') as restore:
            with self.assertRaises(access.Problem) as raised:
                access.dispatch({'action': 'prepare', 'path': '/fixture', 'revision': 'fixture-revision'})
            self.assertEqual(raised.exception.code, 'ACL_ACCESS_DENIED')
            restore.assert_called_once()
            self.assertEqual([item['path'] for item in restore.call_args.args[0]], visits)
            receipt = json.loads(next(Path(folder).glob('*.json')).read_text())
            self.assertFalse(receipt['complete'])
            self.assertEqual([item['path'] for item in receipt['records']], visits)

    def test_failed_postwrite_read_keeps_original_receipt_without_blind_rollback(self):
        records = [dict(path='/fixture/first', directory=False, access='b3JpZ2luYWw=', default=None, mode=0o600),
                   dict(path='/fixture/second', directory=False, access=None, default=None, mode=0o640)]
        summary = {'path': '/fixture', 'accessRevision': 'fixture-revision'}
        writes = []

        def apply(_fd, record, _uid):
            writes.append(record['path'])

        def read_after(_fd, _name):
            if len(writes) == 2:
                raise access.Problem('Synthetic post-write ACL read failure', 403, 'ACL_ACCESS_DENIED')
            return b'after-first'

        with tempfile.TemporaryDirectory(prefix='viios-acl-error-') as folder, \
             patch.object(access, 'STORE', Path(folder)), \
             patch.object(access, 'collect', return_value=(summary, records, 42)), \
             patch.object(access, 'opened', side_effect=lambda _path: contextlib.nullcontext(17)), \
             patch.object(access, 'same_inode', return_value=True), \
             patch.object(access, 'get_acl', side_effect=read_after), \
             patch.object(access.os, 'fstat', return_value=types.SimpleNamespace(st_mode=0o100600)), \
             patch.object(access, 'apply_record', side_effect=apply), \
             patch.object(access, 'restore_records') as restore:
            with self.assertRaises(access.Problem) as raised:
                access.dispatch({'action': 'prepare', 'path': '/fixture', 'revision': 'fixture-revision'})
            self.assertEqual(raised.exception.code, 'ACL_UPDATE_FAILED')
            self.assertIn('kısmen değişmiş olabilir', str(raised.exception))
            self.assertEqual(writes, ['/fixture/first', '/fixture/second'])
            self.assertEqual([item['path'] for item in restore.call_args.args[0]], ['/fixture/first'])
            receipt = json.loads(next(Path(folder).glob('*.json')).read_text())
            self.assertFalse(receipt['complete'])
            self.assertFalse(receipt['rollbackComplete'])
            self.assertEqual([item['path'] for item in receipt['records']], writes)
            self.assertEqual(receipt['records'][0]['access'], 'b3JpZ2luYWw=')
            self.assertEqual(receipt['records'][1]['mode'], 0o640)
            self.assertIsNone(receipt['records'][1]['access'])
            self.assertFalse(receipt['records'][1]['stateVerified'])

    def test_receipt_with_unverified_after_state_cannot_restore_permissions(self):
        record = dict(path='/fixture/unknown', directory=False, stateVerified=False, access=None, mode=0o600)
        with patch.object(access, 'opened') as opened, patch.object(access, 'set_acl') as write_acl, \
             patch.object(access, 'remove_acl') as remove_acl, patch.object(access.os, 'fchmod', create=True) as chmod:
            with self.assertRaises(access.Problem) as raised:
                access.restore_records([record])
            self.assertEqual(raised.exception.code, 'ACL_UPDATE_FAILED')
            opened.assert_not_called()
            write_acl.assert_not_called()
            remove_acl.assert_not_called()
            chmod.assert_not_called()

    def test_rollback_failure_retains_acl_code_and_warns_about_partial_permissions(self):
        records = [dict(path='/fixture/changed', directory=False, access=None, mode=0o600)]
        summary = {'path': '/fixture', 'accessRevision': 'fixture-revision'}
        with tempfile.TemporaryDirectory(prefix='viios-acl-error-') as folder, \
             patch.object(access, 'STORE', Path(folder)), \
             patch.object(access, 'collect', return_value=(summary, records, 42)), \
             patch.object(access, 'opened', side_effect=lambda _path: contextlib.nullcontext(17)), \
             patch.object(access, 'same_inode', return_value=True), \
             patch.object(access, 'get_acl', return_value=None), \
             patch.object(access.os, 'fstat', return_value=types.SimpleNamespace(st_mode=0o100600)), \
             patch.object(access, 'apply_record', side_effect=access.Problem('Synthetic ACL write denial', 403, 'ACL_ACCESS_DENIED')), \
             patch.object(access, 'restore_records', side_effect=access.Problem('Concurrent permission change', 409)):
            with self.assertRaises(access.Problem) as raised:
                access.dispatch({'action': 'prepare', 'path': '/fixture', 'revision': 'fixture-revision'})
            self.assertEqual(raised.exception.code, 'ACL_ACCESS_DENIED')
            self.assertEqual(raised.exception.status, 403)
            self.assertIn('kısmen değişmiş olabilir', str(raised.exception))
            receipt = json.loads(next(Path(folder).glob('*.json')).read_text())
            self.assertEqual(len(receipt['records']), 1)
            self.assertFalse(receipt['rollbackComplete'])


if __name__ == '__main__':
    unittest.main()
