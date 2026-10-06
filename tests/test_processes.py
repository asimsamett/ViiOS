import importlib.util
import pathlib
import unittest
import types
import datetime
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('process_manager', pathlib.Path(__file__).parents[1] / 'server/processes.py')
pm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pm)


class Processes(unittest.TestCase):
    def test_linux_process_metadata_and_normalized_cpu(self):
        item = {'pid': 55, 'parent': 40, 'name': 'worker', 'state': 'S', 'started': 100, 'rss': 8192}
        cpu = Mock(return_value=12.5)
        ctx = ({'cpu_percent': cpu}, {55: item}, {55: item}, 500, 'boot', 1000, set())
        pwd = types.SimpleNamespace(getpwuid=lambda uid: types.SimpleNamespace(pw_name='demo'))
        with patch.dict('sys.modules', {'pwd': pwd}), patch.object(pm.pathlib.Path, 'stat', return_value=types.SimpleNamespace(st_uid=1000)), patch.object(pm.pathlib.Path, 'read_text', return_value='0::/user.slice/session.scope'), patch.object(pm.os, 'sysconf', create=True, return_value=100), patch.object(pm.os, 'pidfd_open', create=True), patch.object(pm.signal, 'pidfd_send_signal', create=True):
            row = pm.process_row(item, ctx)
            self.assertEqual((row['user'], row['cpuPercent'], row['memoryBytes']), ('demo', 12.5, 8192))
            self.assertEqual(datetime.datetime.fromisoformat(row['startedAt']).timestamp(), 1001)
            self.assertTrue(row['canTerminate'])
            self.assertEqual(row['token'], pm.identity(55, 100, 'boot'))
            self.assertNotIn('commandLine', row)
            item['state'] = 'Z'
            self.assertFalse(pm.process_row(item, ctx)['canTerminate'])

    def test_input_schema(self):
        for value in [None, [], {'action': 'sh'}, {'action': 'list', 'cmd': 'id'}, {'action': 'details', 'pid': True}, {'action': 'details', 'pid': '1;id'}, {'action': 'terminate', 'pid': 2, 'token': 'bad'}]:
            with self.assertRaises(pm.ProcessError):
                pm.validate(value)
        self.assertEqual(pm.validate({'action': 'details', 'pid': 22})['pid'], 22)

    def test_protected_processes_and_boot_identity(self):
        for args in [(1, 'init', '', set()), (42, 'app', '', {42}), (22, 'app', '0::/system.slice/app.service', set()), (55, 'sshd', '', set())]:
            self.assertTrue(pm.protected(*args))
        self.assertFalse(pm.protected(55, 'app', 'user.slice/session.scope', set()))
        self.assertNotEqual(pm.identity(55, 10, 'boot'), pm.identity(55, 11, 'boot'))
        self.assertNotEqual(pm.identity(55, 10, 'boot'), pm.identity(55, 10, 'nextboot'))

    def termination(self, token='a'*64, allowed=True):
        request = {'action': 'terminate', 'pid': 20, 'token': 'a'*64}
        ctx = ({'parse_process': Mock(return_value={'pid': 20})},)
        with patch.object(pm.os, 'pidfd_open', create=True, return_value=999) as opened, patch.object(pm.signal, 'pidfd_send_signal', create=True) as sent, patch.object(pm.os, 'sysconf', create=True, return_value=4096), patch.object(pm.os, 'close') as closed, patch.object(pm.pathlib.Path, 'read_text', return_value='stat'), patch.object(pm, 'process_row', return_value={'token': token, 'canTerminate': allowed, 'reason': 'Protected'}), patch.object(pm.select, 'POLLIN', 1, create=True), patch.object(pm.select, 'poll', create=True) as poll:
            poll.return_value.poll.return_value = [(999, 1)]
            if token != request['token'] or not allowed:
                with self.assertRaises(pm.ProcessError) as result:
                    pm.terminate(request, ctx)
                self.assertEqual(result.exception.status, 409 if token != request['token'] else 403)
                sent.assert_not_called()
            else:
                self.assertTrue(pm.terminate(request, ctx)['exited'])
                sent.assert_called_once_with(999, pm.signal.SIGTERM)
            opened.assert_called_once_with(20)
            closed.assert_called_once_with(999)

    def test_stable_process_handle_termination(self):
        self.termination()

    def test_reused_pid_never_signalled(self):
        self.termination(token='b'*64)

    def test_protected_process_never_signalled(self):
        self.termination(allowed=False)


if __name__ == '__main__':
    unittest.main()
