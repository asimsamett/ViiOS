import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

if sys.platform != 'linux':
    raise unittest.SkipTest('Linux deployment rollback tests run on the deployment host.')

spec = importlib.util.spec_from_file_location('rollback', Path(__file__).resolve().parents[1] / 'deploy/rollback-versioning.py')
rollback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollback)


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        rollback.ROOT = base / 'app'
        rollback.BACKUPS = base / 'backups'
        self.backup = rollback.BACKUPS / 'versioning-release-test'
        self.backup.mkdir(parents=True)
        (rollback.ROOT / 'server').mkdir(parents=True)
        (rollback.ROOT / 'data').mkdir()
        (rollback.ROOT / 'data/live.json').write_text('user data')
        files = []
        with tarfile.open(self.backup / 'before.tar.gz', 'w:gz') as archive:
            for name, before, after in [('server/index.mjs', b'old server', b'new server'),
                                        ('server/versioning.json', None, b'{"enabled":true,"pilotRoot":"/opt/viios-agent-git-demo"}')]:
                (rollback.ROOT / name).write_bytes(after)
                files.append({'path': name, 'before': hashlib.sha256(before).hexdigest() if before else None, 'after': hashlib.sha256(after).hexdigest()})
                if before:
                    info = tarfile.TarInfo(name)
                    info.size = len(before)
                    info.mode = 0o644
                    info.uid, info.gid = os.getuid(), os.getgid()
                    archive.addfile(info, io.BytesIO(before))
        (self.backup / 'manifest.json').write_text(json.dumps({'files': files}))

    def run_rollback(self, apply=False):
        with patch.object(sys, 'argv', ['rollback', str(self.backup)] + (['--apply'] if apply else [])), \
             patch.object(rollback, 'active_operations', return_value=[]), \
             patch.object(rollback.os, 'geteuid', return_value=0), \
             patch.object(rollback.subprocess, 'run') as service, contextlib.redirect_stdout(io.StringIO()):
            rollback.main()
            return service.call_count

    def test_dry_run_then_restore_leaves_application_data_untouched(self):
        self.assertEqual(self.run_rollback(), 0)
        self.assertEqual((rollback.ROOT / 'server/index.mjs').read_bytes(), b'new server')
        self.assertEqual(self.run_rollback(True), 2)
        self.assertEqual((rollback.ROOT / 'server/index.mjs').read_bytes(), b'old server')
        self.assertFalse((rollback.ROOT / 'server/versioning.json').exists())
        self.assertEqual((rollback.ROOT / 'data/live.json').read_text(), 'user data')

    def test_disabled_feature_can_roll_back_but_later_code_changes_are_preserved(self):
        config = rollback.ROOT / 'server/versioning.json'
        config.write_text('{"enabled":false,"pilotRoot":"/opt/viios-agent-git-demo"}')
        self.assertEqual(self.run_rollback(), 0)
        (rollback.ROOT / 'server/index.mjs').write_bytes(b'later user edit')
        with self.assertRaises(SystemExit):
            self.run_rollback(True)
        self.assertEqual((rollback.ROOT / 'server/index.mjs').read_bytes(), b'later user edit')

    def test_expansion_rollback_restores_sudo_rule_and_rejects_later_edits(self):
        rollback.SUDO_FILE = self.backup.parent / 'sudoers'
        before = b'allmanagement ALL=(root) NOPASSWD: /usr/bin/example\n'
        after = before + b'allmanagement ALL=(root) NOPASSWD: /usr/bin/fixed-helper\n'
        rollback.SUDO_FILE.write_bytes(after)
        (self.backup / 'sudoers.before').write_bytes(before)
        manifest = json.loads((self.backup / 'manifest.json').read_text())
        manifest['sudo'] = {'before': hashlib.sha256(before).hexdigest(), 'after': hashlib.sha256(after).hexdigest()}
        (self.backup / 'manifest.json').write_text(json.dumps(manifest))
        self.assertEqual(self.run_rollback(), 1)
        rollback.SUDO_FILE.write_bytes(after + b'# later edit\n')
        with self.assertRaises(SystemExit):
            self.run_rollback(True)
        rollback.SUDO_FILE.write_bytes(after)
        self.assertEqual(self.run_rollback(True), 3)
        self.assertEqual(rollback.SUDO_FILE.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
