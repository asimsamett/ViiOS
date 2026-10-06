import importlib.util
import json
import pathlib
import stat
import types
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('service_manager', pathlib.Path(__file__).parents[1]/'server/services.py')
sm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sm)


def info(**changes):
    return {'Id': 'demo.service', 'Description': 'Demo service', 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'UnitFileState': 'enabled', 'MainPID': '200', 'FragmentPath': '/etc/systemd/system/demo.service', 'InvocationID': 'run-1', **changes}


class Services(unittest.TestCase):
    def test_strict_schema(self):
        for request in [None, [], {'action': 'shell'}, {'action': 'details', 'name': '-foo.service'}, {'action': 'details', 'name': 'a.service;id'}, {'action': 'start', 'name': 'demo.service', 'token': 'x'}, {'action': 'list', 'command': 'id'}, {'action': 'logs', 'name': 'demo.service', 'limit': True}]:
            with self.assertRaises(sm.ServiceError): sm.validate(request)
        sm.validate({'action': 'logs', 'name': 'demo@one.service', 'limit': 100})

    def test_protection_allowlist_and_state(self):
        self.assertEqual(sm.row(info(), set(), set())['actions'], [])
        self.assertEqual(sm.row(info(), {'demo.service'}, {'demo.service'})['actions'], [])
        self.assertEqual(sm.row(info(Id='ssh.service'), {'ssh.service'}, set())['actions'], [])
        self.assertIn('stop', sm.row(info(), {'demo.service'}, set())['actions'])
        self.assertEqual(sm.row(info(ActiveState='activating'), {'demo.service'}, set())['actions'], [])
        self.assertNotIn('stop', sm.row(info(TriggeredBy='demo.socket'), {'demo.service'}, set())['actions'])
        self.assertNotIn('start', sm.row(info(ActiveState='inactive', UnitFileState='masked'), {'demo.service'}, set())['actions'])

    def test_identity_changes_with_configuration_and_service_invocation(self):
        before = sm.row(info(), {'demo.service'}, set())
        for update in [{'UnitFileState': 'disabled'}, {'InvocationID': 'run-2'}, {'FragmentPath': '/different/file'}]:
            self.assertNotEqual(before['token'], sm.row(info(**update), {'demo.service'}, set())['token'])
        self.assertNotIn('FragmentPath', before)

    def test_show_parser_and_dependency_guards(self):
        self.assertEqual(sm.parse_show('Id=a.service\nDescription=A=B\n\nId=b.service\n')[0]['Description'], 'A=B')
        with patch.object(sm, 'inspect', return_value=[{'ActiveState': 'active'}]):
            with self.assertRaises(sm.ServiceError): sm.dependency_guard(info(RequiredBy='dependent.service'), 'stop')
        with patch.object(sm, 'inspect', return_value=[{'ActiveState': 'inactive'}]):
            with self.assertRaises(sm.ServiceError): sm.dependency_guard(info(Requires='dependency.service'), 'start')

    def test_list_includes_installed_stopped_and_deduplicates_aliases(self):
        with patch.object(sm.pathlib.Path, 'is_dir', return_value=True), patch.object(sm, 'policy', return_value=set()), patch.object(sm, 'protected_names', return_value=set()), patch.object(sm, 'run', side_effect=['demo.service loaded active running Demo\n', 'demo.service enabled enabled\nother.service disabled disabled\nalias.service alias -\n']), patch.object(sm, 'inspect', return_value=[info(), info(), info(Id='other.service', ActiveState='inactive')]):
            result = sm.dispatch({'action': 'list'})
            self.assertEqual(len(result['services']), 2)
            self.assertIn('inactive', [row['state'] for row in result['services']])

    def test_logs_only_export_allowed_fields_and_requested_limit(self):
        raw = '\n'.join(json.dumps({'MESSAGE': f'event {i}', '__REALTIME_TIMESTAMP': '1000000', 'PRIORITY': '6', '_CMDLINE': 'SECRET'}) for i in range(3))
        with patch.object(sm, 'get_one', return_value=info()), patch.object(sm, 'run', return_value=raw) as run:
            value = sm.logs('demo.service', 2)
            self.assertEqual(len(value['entries']), 2)
            self.assertNotIn('SECRET', json.dumps(value))
            self.assertIn('--unit=demo.service', run.call_args.args[0])

    def test_mutation_uses_fixed_systemctl_and_verifies_result(self):
        before = info(); after = info(ActiveState='inactive', SubState='dead', MainPID='0')
        token = sm.row(before, {'demo.service'}, set())['token']
        fcntl = types.SimpleNamespace(flock=Mock(), LOCK_EX=1, LOCK_NB=2)
        lock = types.SimpleNamespace(st_mode=stat.S_IFREG|0o600, st_uid=0, st_nlink=1)
        with patch.dict('sys.modules', {'fcntl': fcntl}), patch.object(sm.pathlib.Path, 'is_dir', return_value=True), patch.object(sm, 'policy', return_value={'demo.service'}), patch.object(sm, 'protected_names', return_value=set()), patch.object(sm.os, 'O_NOFOLLOW', 0, create=True), patch.object(sm.os, 'open', return_value=99), patch.object(sm.os, 'fstat', return_value=lock), patch.object(sm.os, 'close'), patch.object(sm, 'get_one', side_effect=[before, after]), patch.object(sm, 'dependency_guard') as guard, patch.object(sm, 'run', return_value='') as run:
            value = sm.dispatch({'action': 'stop', 'name': 'demo.service', 'token': token})
            self.assertEqual(value['service']['state'], 'inactive')
            self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', '--no-ask-password', '--job-mode=fail', 'stop', '--', 'demo.service'])
            guard.assert_called_once_with(before, 'stop')

    def test_systemd_absence_and_non_allowlisted_mutation(self):
        with patch.object(sm.pathlib.Path, 'is_dir', return_value=False):
            with self.assertRaises(sm.ServiceError) as caught: sm.dispatch({'action': 'list'})
            self.assertEqual(caught.exception.status, 501)
        with patch.object(sm.pathlib.Path, 'is_dir', return_value=True), patch.object(sm, 'policy', return_value=set()), patch.object(sm, 'protected_names', return_value=set()), patch.object(sm, 'run') as run:
            with self.assertRaises(sm.ServiceError) as caught: sm.dispatch({'action': 'stop', 'name': 'demo.service', 'token': 'a'*64})
            self.assertEqual(caught.exception.status, 403)
            run.assert_not_called()


if __name__ == '__main__': unittest.main()
