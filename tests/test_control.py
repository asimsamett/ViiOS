import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform != 'linux':
    raise unittest.SkipTest('Linux lifecycle broker tests run on the deployment host.')

spec = importlib.util.spec_from_file_location('control', pathlib.Path(__file__).parents[1] / 'server' / 'control.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def proc(pid=10, unit='demo.service', ppid=1):
    return {'pid': pid, 'ppid': ppid, 'start': '2345', 'boot': 'boot-a', 'exe': '/usr/bin/python3',
            'cmd': ['/usr/bin/python3', '-m', 'http.server', '8097'], 'unit': unit, 'namespaces': {}}


class ControlTests(unittest.TestCase):
    def test_input_rejects_injection_out_of_range_and_extra_fields(self):
        for port in [0, 65536, -1, 1.5, True, '8097', '8097;id', [], {}]:
            with self.subTest(port=port), self.assertRaises(c.ControlError):
                c.validate_request({'action': 'stop', 'port': port, 'token': 'a' * 64})
        for extra in ['unit', 'pid', 'argv', 'env']:
            with self.subTest(extra=extra), self.assertRaises(c.ControlError):
                c.validate_request({'action': 'status', extra: 'anything'})
        for action in ['kill', '--launch', 'exec', 'shell']:
            with self.assertRaises(c.ControlError):
                c.validate_request({'action': action})
        c.validate_request({'action': 'start', 'port': 65535, 'token': 'a' * 64})
        c.validate_request({'action': 'restart', 'port': 8097, 'token': 'a' * 64})

    def test_every_tcp_udp_ipv6_owner_is_collected(self):
        raw = '''tcp LISTEN 0 128 0.0.0.0:8097 0.0.0.0:* users:(("python",pid=10,fd=3),("python",pid=11,fd=3))
tcp LISTEN 0 128 [::]:8097 [::]:* users:(("python",pid=10,fd=4))
udp UNCONN 0 0 0.0.0.0:8097 0.0.0.0:* users:(("other",pid=12,fd=5))
tcp LISTEN 0 128 127.0.0.1:1000 0.0.0.0:*'''
        self.assertEqual(c.listener_map(raw), {8097: {10, 11, 12}, 1000: {0}})

    def test_systemd_identity_order_is_stable_and_all_ports_are_included(self):
        procs = {11: proc(11), 10: proc(10)}
        units = {'demo.service': {'LoadState': 'loaded', 'FragmentPath': '/etc/systemd/system/demo.service', 'TriggeredBy': ''}}
        recipe, identities = c.classify(8097, {8097: {10}, 8098: {11}}, procs, {}, units, [])
        self.assertEqual(recipe['ports'], [8097, 8098])
        self.assertEqual([p['pid'] for p in identities], [10, 11])

    def test_ssh_and_management_units_are_protected_on_nonstandard_ports(self):
        for unit in ['ssh.service', 'all-management.service', 'docker.service']:
            with self.subTest(unit=unit), self.assertRaises(c.ControlError):
                c.classify(8097, {8097: {10}}, {10: proc(unit=unit)}, {}, {}, [])

    def test_unmanaged_children_and_their_ports_are_included_in_token(self):
        root, child = proc(unit=None), proc(11, None, 10)
        with patch.object(c, 'snapshot', return_value={'kind': 'process'}), patch.object(c, 'descendants', return_value=[root, child]), patch.object(c, 'process', return_value=root):
            recipe, identities = c.classify(8097, {8097: {10}, 8098: {11}}, {10: root, 11: child}, {}, {}, [])
        self.assertEqual(recipe['ports'], [8097, 8098])
        self.assertEqual(set(recipe['tree']), {'10', '11'})
        self.assertEqual(len(identities), 2)

    def test_recycled_root_pid_is_rejected_before_any_signal(self):
        original = proc(unit=None)
        recycled = {**original, 'start': '9999'}
        recipe = {'rootPid': 10, 'identity': c.digest(original), 'tree': {'10': c.digest(original)}}
        with patch.object(c, 'process', return_value=original), patch.object(c, 'descendants', return_value=[recycled]), patch.object(c.os, 'pidfd_open') as fd, patch.object(c.signal, 'pidfd_send_signal') as send:
            with self.assertRaises(c.ControlError):
                c.stop_process(recipe)
            fd.assert_not_called()
            send.assert_not_called()

    def test_new_descendant_invalidates_stop_before_signals(self):
        original = proc(unit=None)
        recipe = {'rootPid': 10, 'identity': c.digest(original), 'tree': {'10': c.digest(original)}}
        with patch.object(c, 'process', return_value=original), patch.object(c, 'descendants', return_value=[original, proc(11, None, 10)]), patch.object(c.signal, 'pidfd_send_signal') as send:
            with self.assertRaises(c.ControlError):
                c.stop_process(recipe)
            send.assert_not_called()

    def test_live_process_without_listener_cannot_be_started_again(self):
        original = proc(unit=None)
        saved = {'8097': {'kind': 'process', 'rootPid': 10, 'identity': c.digest(original), 'ports': [8097]}}
        with patch.object(c, 'listener_map', return_value={}), patch.object(c, 'process', return_value=original):
            controls, _ = c.inspect_all(saved)
        self.assertFalse(controls['8097']['canStart'])
        self.assertIn('Süreç çalışıyor', controls['8097']['reason'])

    def test_shared_protected_port_prevents_control(self):
        saved = {'8097': {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097, 55734]}}
        with patch.object(c, 'listener_map', return_value={}):
            controls, _ = c.inspect_all(saved)
        self.assertFalse(controls['8097']['canStart'])

    def test_snapshot_namespace_mismatch_rejected(self):
        original = proc(unit=None)
        original['namespaces'] = {'net': 'net:[container]'}
        status = 'Uid:\t0 0 0 0\nGid:\t0 0 0 0\n'
        with patch.object(pathlib.Path, 'read_text', return_value=status), patch.object(c.os, 'readlink', side_effect=['/tmp', 'net:[host]']), patch.object(c.os.path, 'isfile', return_value=True), patch.object(c.os.path, 'isdir', return_value=True):
            with self.assertRaisesRegex(c.ControlError, 'özel ortamda'):
                c.snapshot(original)

    def test_deleted_cwd_prevents_snapshot(self):
        with patch.object(pathlib.Path, 'read_text', return_value='Uid: 0 0 0 0\nGid: 0 0 0 0\n'), patch.object(c.os, 'readlink', return_value='/missing'), patch.object(c.os.path, 'isfile', return_value=True), patch.object(c.os.path, 'isdir', return_value=False):
            with self.assertRaises(c.ControlError):
                c.snapshot(proc(unit=None))

    def test_start_does_not_accept_a_different_service_on_port(self):
        recipe = {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097]}
        with patch.object(c, 'run'), patch.object(c, 'listener_map', return_value={8097: {11}}), patch.object(c, 'process', return_value=proc(11, 'unrelated.service')):
            with self.assertRaisesRegex(c.ControlError, 'dışında'):
                c.execute('start', 8097, recipe)

    def test_unmanaged_restart_uses_its_own_systemd_group(self):
        recipe = {'kind': 'process', 'ports': [8097]}
        with patch.object(c, 'unit_info', return_value={'ActiveState': 'inactive'}), patch.object(c.subprocess, 'run'), patch.object(c, 'run') as command, patch.object(c, 'listener_map', return_value={8097: {12}}), patch.object(c, 'process', return_value=proc(12, 'allmanagement-port-8097.service')):
            c.execute('start', 8097, recipe)
        args = command.call_args.args[0]
        self.assertEqual(args[0], '/usr/bin/systemd-run')
        self.assertIn('--unit=allmanagement-port-8097.service', args)
        self.assertIn('--property=KillMode=control-group', args)
        self.assertEqual(args[-2:], ['--launch', '8097'])

    def test_saved_process_launch_restores_identity_directory_and_environment(self):
        recipe = {'kind': 'process', 'umask': 0o027, 'groups': [123, 124], 'gid': 123, 'uid': 123,
                  'cwd': '/opt/demo', 'exe': '/usr/bin/python3', 'argv': ['/usr/bin/python3', 'app.py'], 'env': {'SECRET': 'private'}}
        with patch.object(c, 'load', return_value={'8097': recipe}), patch.object(c.os, 'umask') as mask, patch.object(c.os, 'setgroups') as groups, patch.object(c.os, 'setgid') as gid, patch.object(c.os, 'setuid') as uid, patch.object(c.os, 'chdir') as cwd, patch.object(c.os, 'execve') as execute:
            c.launch(8097)
        mask.assert_called_once_with(0o027)
        groups.assert_called_once_with([123, 124])
        gid.assert_called_once_with(123)
        uid.assert_called_once_with(123)
        cwd.assert_called_once_with('/opt/demo')
        execute.assert_called_once_with('/usr/bin/python3', recipe['argv'], recipe['env'])

    def test_restart_waits_for_unit_shutdown_then_starts_the_same_service(self):
        recipe = {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097]}
        with patch.object(c, 'run') as run, patch.object(c, 'listener_map', side_effect=[{}, {}, {}, {8097: {12}}]), patch.object(c, 'unit_info', side_effect=[{'ActiveState': 'deactivating'}, {'ActiveState': 'inactive'}]) as info, patch.object(c, 'process', return_value=proc(12)), patch.object(c.time, 'sleep'):
            c.execute('restart', 8097, recipe)
        self.assertEqual(info.call_count, 2)
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ['/usr/bin/systemctl', '--no-block', 'stop', 'demo.service'],
            ['/usr/bin/systemctl', '--no-block', 'start', 'demo.service']])

    def test_restart_does_not_start_when_another_process_claims_an_affected_port(self):
        recipe = {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097, 8098]}
        with patch.object(c, 'run') as run, patch.object(c, 'listener_map', side_effect=[{}, {8098: {99}}]), patch.object(c, 'unit_info', return_value={'ActiveState': 'inactive'}):
            with self.assertRaisesRegex(c.ControlError, 'başka bir süreç'):
                c.execute('restart', 8097, recipe)
        self.assertEqual(run.call_count, 1)

    def test_restart_reports_partial_failure_and_never_claims_success(self):
        recipe = {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097]}
        with patch.object(c, 'run', side_effect=['', c.ControlError('start failed')]), patch.object(c, 'listener_map', return_value={}), patch.object(c, 'unit_info', return_value={'ActiveState': 'inactive'}):
            with self.assertRaisesRegex(c.ControlError, 'durduruldu ancak yeniden açılamadı'):
                c.execute('restart', 8097, recipe)

    def test_restart_stop_failure_never_attempts_start(self):
        recipe = {'kind': 'systemd', 'unit': 'demo.service', 'ports': [8097]}
        with patch.object(c, 'run', side_effect=c.ControlError('stop failed')) as run:
            with self.assertRaisesRegex(c.ControlError, 'durdurma aşaması'):
                c.execute('restart', 8097, recipe)
        self.assertEqual(run.call_count, 1)

    def test_closed_application_requires_start_instead_of_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            store = pathlib.Path(temp)
            store.chmod(0o700)
            control = {'8097': {'canStart': True, 'canStop': False, 'canRestart': False, 'token': 'a' * 64}}
            with patch.object(c, 'STORE', store), patch.object(c.sys, 'argv', ['control.py']), patch.object(c.sys, 'stdin', io.StringIO(json.dumps({'action': 'restart', 'port': 8097, 'token': 'a' * 64}))), patch.object(c, 'inspect_all', return_value=(control, {})), patch.object(c, 'execute') as execute:
                with self.assertRaises(c.ControlError):
                    c.main()
                execute.assert_not_called()

    def test_snapshot_write_failure_prevents_action(self):
        with tempfile.TemporaryDirectory() as temp:
            store = pathlib.Path(temp)
            store.chmod(0o700)
            with patch.object(c, 'STORE', store), patch.object(c.sys, 'argv', ['control.py']), patch.object(c.sys, 'stdin', io.StringIO(json.dumps({'action': 'stop', 'port': 8097, 'token': 'a' * 64}))), patch.object(c, 'inspect_all', return_value=({}, {})), patch.object(c, 'save', side_effect=OSError('disk full')), patch.object(c, 'execute') as execute:
                with self.assertRaises(OSError):
                    c.main()
                execute.assert_not_called()

    def test_stale_token_never_executes_action(self):
        with tempfile.TemporaryDirectory() as temp:
            store = pathlib.Path(temp)
            store.chmod(0o700)
            control = {'8097': {'canStop': True, 'token': 'b' * 64}}
            with patch.object(c, 'STORE', store), patch.object(c.sys, 'argv', ['control.py']), patch.object(c.sys, 'stdin', io.StringIO(json.dumps({'action': 'stop', 'port': 8097, 'token': 'a' * 64}))), patch.object(c, 'inspect_all', return_value=(control, {})), patch.object(c, 'execute') as execute:
                with self.assertRaisesRegex(c.ControlError, 'durumu değişti'):
                    c.main()
                execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
