"""Root-only ACL integration tests on isolated, temporary projects."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform != 'linux' or os.geteuid() != 0:
    raise unittest.SkipTest('ACL tests require Linux root and the deployment service account.')
spec = importlib.util.spec_from_file_location('versioning_access', Path(__file__).resolve().parents[1] / 'server/versioning_access.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='management-acl-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir(mode=0o750)
        self.source = self.project / 'source.txt'
        self.source.write_text('example source')
        self.source.chmod(0o640)
        access.CONFIG = self.root / 'config.json'
        access.CONFIG.write_text(json.dumps({'enabled': True, 'roots': [str(self.root)]}))
        access.STORE = self.root / 'receipts'
        access.STORE.mkdir(mode=0o700)
        self.uid = pwd.getpwnam(access.ACCOUNT).pw_uid

    def call(self, action, **kwargs):
        return access.dispatch({'action': action, **kwargs})

    def prepare(self):
        found = self.call('inspect', path=str(self.project))
        return self.call('prepare', path=str(self.project), revision=found['accessRevision'])

    def acl(self, path):
        with access.opened(path) as fd:
            return access.snapshot(fd, path, 7 if path.is_dir() else 6)

    def test_inspect_is_readonly_prepare_grants_access_and_exact_restore(self):
        before = [self.acl(p) for p in (self.root, self.project, self.source)]
        found = self.call('inspect', path=str(self.project))
        self.assertTrue(found['needsAccess'])
        self.assertEqual(before, [self.acl(p) for p in (self.root, self.project, self.source)])
        done = self.prepare()
        self.assertFalse(self.call('inspect', path=str(self.project))['needsAccess'])
        self.assertEqual(self.source.stat().st_uid, 0)
        # Actual service identity must be able to read/write this root-owned file.
        result = subprocess.run(['sudo', '-n', '-u', access.ACCOUNT, '/usr/bin/python3', '-I', '-c',
            'import sys; p=sys.argv[1]; f=open(p,"r+"); assert f.read()=="example source"; f.close()', str(self.source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with access.opened(self.root) as fd:
            info = os.fstat(fd)
            self.assertEqual(access.effective(access.get_acl(fd, access.ACCESS), info, self.uid, []), 1)
        self.call('restore-access', receipt=done['accessReceipt'])
        after = [self.acl(p) for p in (self.root, self.project, self.source)]
        for old, new in zip(before, after):
            for key in ('mode', 'access', 'default', 'uid', 'gid', 'inode'):
                self.assertEqual(old[key], new[key], key)

    def test_stale_permission_view_rejected(self):
        found = self.call('inspect', path=str(self.project))
        self.source.chmod(0o600)
        with self.assertRaisesRegex(access.Problem, 'değişti'):
            self.call('prepare', path=str(self.project), revision=found['accessRevision'])
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o600)

    def test_service_can_initialize_and_extend_root_owned_project(self):
        self.prepare()
        store = self.root / 'git-store'
        store.mkdir(mode=0o700)
        os.chown(store, self.uid, pwd.getpwnam(access.ACCOUNT).pw_gid)
        module = Path(__file__).resolve().parents[1] / 'server/versioning.py'
        code = '''import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('v', sys.argv[1])
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
v.CONFIG = Path(sys.argv[2]); v.STORE = Path(sys.argv[3]); project = sys.argv[4]
found = v.dispatch({'action':'inspect','path':project})
first = v.dispatch({'action':'register','path':project,'revision':found['revision']})
assert len(first['state']['history']) == 1
(Path(project) / 'source.txt').write_text('changed')
state = v.dispatch({'action':'status','id':first['project']['id']})
saved = v.dispatch({'action':'commit','id':first['project']['id'],'revision':state['state']['revision']})
assert len(saved['state']['history']) == 2
restored = v.dispatch({'action':'restore','id':first['project']['id'],'revision':saved['state']['revision'],'commit':first['state']['head']})
assert (Path(project) / 'source.txt').read_text() == 'example source'
'''
        result = subprocess.run(['sudo', '-n', '-u', access.ACCOUNT, '/usr/bin/python3', '-I', '-c', code,
                                 str(module), str(access.CONFIG), str(store), str(self.project)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.project.stat().st_uid, 0)

    def test_links_and_unconfigured_paths_rejected(self):
        for value in ('/etc', '/opt/viios-agent', str(self.root), str(self.project / '..' / 'project')):
            with self.assertRaises(access.Problem):
                self.call('inspect', path=value)
        (self.project / 'link').symlink_to('/etc')
        with self.assertRaises((access.Problem, OSError)):
            self.prepare()
        (self.project / 'link').unlink()
        os.link(self.source, self.project / 'hardlink')
        with self.assertRaises(access.Problem):
            self.prepare()

    def test_excluded_runtime_tree_and_secret_are_untouched(self):
        deps = self.project / 'node_modules'
        deps.mkdir(mode=0o700)
        (deps / 'link').symlink_to('/etc')
        secret = self.project / '.env'
        secret.write_text('EXAMPLE=1')
        secret.chmod(0o600)
        done = self.prepare()
        self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
        self.assertEqual(deps.stat().st_mode & 0o777, 0o700)
        self.call('restore-access', receipt=done['accessReceipt'])

    def test_project_specific_data_links_are_not_followed_or_changed(self):
        config = json.loads(access.CONFIG.read_text())
        config['projectExcludes'] = {str(self.project): ['data']}
        access.CONFIG.write_text(json.dumps(config))
        (self.project / 'data').symlink_to('/etc')
        done = self.prepare()
        self.assertTrue((self.project / 'data').is_symlink())
        self.call('restore-access', receipt=done['accessReceipt'])

    def test_old_acl_mask_does_not_expand_other_users_effective_access(self):
        with access.opened(self.source) as fd:
            raw = access.expanded_acl(None, 0o640, 65534, 7)
            os.setxattr(fd, access.ACCESS, raw)
            os.fchmod(fd, 0o640)  # Restrict the named user's effective rights to read.
            info = os.fstat(fd)
            before = access.effective(access.get_acl(fd, access.ACCESS), info, 65534, [])
        done = self.prepare()
        with access.opened(self.source) as fd:
            after = access.effective(access.get_acl(fd, access.ACCESS), os.fstat(fd), 65534, [])
        self.assertEqual(before, 4)
        self.assertEqual(after, before)
        self.call('restore-access', receipt=done['accessReceipt'])

    def test_partial_acl_failure_restores_already_changed_permissions(self):
        before = [self.acl(p) for p in (self.root, self.project, self.source)]
        real_set = os.setxattr
        failed = False
        def fail_default(fd, attr, value):
            nonlocal failed
            if attr == access.DEFAULT and not failed:
                failed = True
                raise OSError('injected failure')
            return real_set(fd, attr, value)
        with patch.object(access.os, 'setxattr', fail_default):
            with self.assertRaises(access.Problem) as raised:
                self.prepare()
            self.assertEqual(raised.exception.code, 'ACL_UPDATE_FAILED')
        for old, new in zip(before, [self.acl(p) for p in (self.root, self.project, self.source)]):
            for key in ('mode', 'access', 'default'):
                self.assertEqual(old[key], new[key])

    def test_rollback_rejects_later_permission_changes(self):
        done = self.prepare()
        self.source.chmod(0o600)
        with self.assertRaisesRegex(access.Problem, 'sonradan'):
            self.call('restore-access', receipt=done['accessReceipt'])


if __name__ == '__main__':
    unittest.main()
