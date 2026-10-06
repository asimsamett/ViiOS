"""Real Git integration tests; all files are isolated in a temporary directory."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

if sys.platform != 'linux':
    raise unittest.SkipTest('Linux Git broker tests run on the deployment host.')

spec = importlib.util.spec_from_file_location('versioning', Path(__file__).resolve().parents[1] / 'server/versioning.py')
versions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versions)


class VersioningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='management-git-test-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.root = root / 'trial'
        self.root.mkdir()
        versions.STORE = root / 'store'
        versions.STORE.mkdir()
        versions.CONFIG = root / 'config.json'
        versions.CONFIG.write_text(json.dumps({'enabled': True, 'pilotRoot': str(self.root)}))
        self.project = self.root / 'sample'
        self.project.mkdir()
        (self.project / 'hello.txt').write_text('one\n')

    def call(self, action, **kwargs):
        return versions.dispatch({'action': action, **kwargs})

    def register(self):
        found = self.call('inspect', path=str(self.project))
        return self.call('register', path=str(self.project), revision=found['revision'])

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-C', str(self.project), *args]).decode().strip()

    def test_new_repository_backs_up_sources_and_leaves_excluded_files_in_place(self):
        (self.project / '.env').write_text('TEST_SECRET=example-only')
        (self.project / '.env.example').write_text('TEST_SECRET=')
        (self.project / 'node_modules').mkdir()
        (self.project / 'node_modules/dependency.js').write_text('dependency')
        value = self.register()
        self.assertEqual(value['state']['changes'], [])
        self.assertEqual(len(value['state']['history']), 1)
        self.assertNotIn('.env\n', self.git('ls-files') + '\n')
        self.assertIn('.env.example', self.git('ls-files'))
        self.assertNotIn('node_modules', self.git('ls-files'))
        with tarfile.open(versions.STORE / 'backups' / value['backup'] / 'project.tar.gz') as backup:
            self.assertNotIn('sample/.env', backup.getnames())
            self.assertEqual(backup.extractfile('sample/hello.txt').read(), b'one\n')
            self.assertNotIn('sample/.git', backup.getnames())
        self.assertEqual((self.project / '.env').read_text(), 'TEST_SECRET=example-only')

    def test_ignored_large_runtime_files_and_dependency_links_do_not_block_versioning(self):
        folder = self.project / 'node_modules'
        folder.mkdir()
        (folder / 'dependency').symlink_to('/etc')
        with (self.project / 'large.db').open('wb') as file:
            file.truncate(3 * 1024 ** 3)
        value = self.register()
        before = value['state']['revision']
        (self.project / 'runtime.log').write_text('live runtime output')
        self.assertEqual(self.call('status', id=value['project']['id'])['state']['revision'], before)

    def test_configured_project_roots_are_available_and_independent(self):
        versions.CONFIG.write_text(json.dumps({'enabled': True, 'pilotRoot': str(self.root), 'roots': [str(self.root.parent)]}))
        second = self.root.parent / 'another-app'
        second.mkdir()
        (second / 'app.py').write_text('print(1)')
        first = self.register()
        found = self.call('inspect', path=str(second))
        other = self.call('register', path=str(second), revision=found['revision'])
        self.assertNotEqual(first['project']['id'], other['project']['id'])
        self.assertEqual(len(self.call('list')['projects']), 2)

    def test_project_specific_data_exclusions_leave_sources_versioned(self):
        settings = json.loads(versions.CONFIG.read_text())
        settings['projectExcludes'] = {str(self.project): ['data', '*.csv', 'sarf/*.csv', '.stage-*']}
        versions.CONFIG.write_text(json.dumps(settings))
        (self.project / 'data').symlink_to('/etc')
        (self.project / 'export.csv').write_text('sample data')
        (self.project / 'sarf').mkdir()
        (self.project / 'sarf/app.py').write_text('print(1)')
        (self.project / 'sarf/report.csv').write_text('sample data')
        self.register()
        tracked = self.git('ls-files')
        self.assertIn('hello.txt', tracked)
        self.assertIn('sarf/app.py', tracked)
        self.assertNotIn('data', tracked)
        self.assertNotIn('.csv', tracked)

    def test_existing_history_and_tag_preserved_then_extended(self):
        self.git('init', '-b', 'develop')
        self.git('add', '.')
        self.git('-c', 'user.name=Existing User', '-c', 'user.email=existing@localhost', 'commit', '-m', 'Existing commit')
        original = self.git('rev-parse', 'HEAD')
        self.git('tag', 'v1.2.0')
        before = versions.inventory(self.project)
        value = self.register()
        self.assertEqual(before, versions.inventory(self.project))
        self.assertTrue(value['project']['existing'])
        self.assertEqual(value['state']['head'], original)
        self.assertEqual(value['state']['branch'], 'develop')
        (self.project / 'hello.txt').write_text('two\n')
        status = self.call('status', id=value['project']['id'])
        saved = self.call('commit', id=value['project']['id'], revision=status['state']['revision'], message='Second commit')
        self.assertEqual(self.git('rev-parse', 'HEAD^'), original)
        self.assertEqual(self.git('rev-parse', 'v1.2.0'), original)
        self.assertEqual(len(saved['state']['history']), 2)

    def test_numbered_timeline_pages_and_single_file_diff(self):
        value = self.register()
        ident = value['project']['id']
        self.assertEqual(value['state']['trackedCount'], 1)
        for number in range(1, 3):
            (self.project / 'hello.txt').write_text(str(number))
            (self.project / 'other.txt').write_text(str(number))
            current = self.call('status', id=ident)
            self.call('commit', id=ident, revision=current['state']['revision'], message='Change ' + str(number))
        history = self.call('timeline', id=ident, offset=0)
        self.assertEqual([row['number'] for row in history['history']], [3, 2, 1])
        self.assertEqual(history['total'], 3)
        self.assertEqual(history['history'][0]['author'], 'All Management')
        self.assertFalse(history['hasMore'])
        self.assertEqual(self.call('timeline', id=ident, offset=2)['history'][0]['number'], 1)
        oldest = history['history'][-1]['id']
        self.assertEqual([item['path'] for item in self.call('commitFiles', id=ident, commit=oldest)['files']], ['hello.txt'])
        self.assertIn('+one', self.call('fileDiff', id=ident, commit=oldest, file='hello.txt')['text'])
        newest = history['history'][0]['id']
        files = self.call('commitFiles', id=ident, commit=newest)['files']
        self.assertEqual({item['path'] for item in files}, {'hello.txt', 'other.txt'})
        diff = self.call('fileDiff', id=ident, commit=newest, file='hello.txt')
        self.assertIn('+2', diff['text'])
        self.assertNotIn('other.txt', diff['text'])
        with self.assertRaises(versions.Problem):
            self.call('fileDiff', id=ident, commit=newest, file='../outside')
        with self.assertRaises(versions.Problem):
            self.call('fileDiff', id=ident, commit=newest, file='missing.txt')

    def test_working_file_diff_limits_output_to_selected_changed_file(self):
        value = self.register()
        ident = value['project']['id']
        (self.project / 'hello.txt').write_text('updated\n')
        (self.project / 'new.txt').write_text('new content\n')
        self.assertEqual(self.call('status', id=ident)['state']['trackedCount'], 1)
        selected = self.call('workingFileDiff', id=ident, file='hello.txt')
        self.assertIn('+updated', selected['text'])
        self.assertNotIn('new.txt', selected['text'])
        untracked = self.call('workingFileDiff', id=ident, file='new.txt')
        self.assertEqual(untracked['text'], '')
        self.assertIn('henüz Git', untracked['note'])
        for name in ('../outside', '.env', 'missing.txt'):
            with self.assertRaises(versions.Problem):
                self.call('workingFileDiff', id=ident, file=name)

    def test_timeline_pages_beyond_fifty_commits(self):
        self.git('init', '-b', 'main')
        self.git('add', '.')
        for number in range(53):
            (self.project / 'hello.txt').write_text(str(number))
            self.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-am', 'Revision ' + str(number))
        value = self.register()
        first = self.call('timeline', id=value['project']['id'], offset=0)
        second = self.call('timeline', id=value['project']['id'], offset=50)
        self.assertEqual((first['total'], len(first['history']), first['history'][0]['number'], first['hasMore']), (53, 50, 53, True))
        self.assertEqual([item['number'] for item in second['history']], [3, 2, 1])
        self.assertFalse(second['hasMore'])

    def test_restore_creates_checkpoint_and_new_commit_with_exact_target_tree(self):
        first = self.register()
        ident = first['project']['id']
        original = first['state']['head']
        (self.project / 'hello.txt').write_text('two\n')
        (self.project / 'new.txt').write_text('keep me in checkpoint')
        self.git('add', 'hello.txt')
        # The staged version differs from the working version; archive preserves both.
        (self.project / 'hello.txt').write_text('three\n')
        before_index = (self.project / '.git/index').read_bytes()
        before = self.call('status', id=ident)
        restored = self.call('restore', id=ident, revision=before['state']['revision'], commit=original)
        self.assertEqual((self.project / 'hello.txt').read_text(), 'one\n')
        self.assertFalse((self.project / 'new.txt').exists())
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), self.git('rev-parse', original + '^{tree}'))
        self.assertEqual(self.git('show', restored['checkpoint'] + ':new.txt'), 'keep me in checkpoint')
        self.assertEqual(self.git('show', restored['checkpoint'] + ':hello.txt'), 'three')
        self.assertEqual(len(restored['state']['history']), 3)
        with tarfile.open(versions.STORE / 'backups' / restored['backup'] / 'project.tar.gz') as backup:
            self.assertEqual(backup.extractfile('sample/.git/index').read(), before_index)
        # Restore the checkpoint again, proving the operation is reversible.
        undone = self.call('restore', id=ident, revision=restored['state']['revision'], commit=restored['checkpoint'])
        self.assertEqual((self.project / 'hello.txt').read_text(), 'three\n')
        self.assertTrue((self.project / 'new.txt').exists())
        self.assertEqual(undone['state']['changes'], [])

    def test_stale_view_rejects_changes_even_when_status_filename_is_unchanged(self):
        value = self.register()
        ident = value['project']['id']
        (self.project / 'hello.txt').write_text('two')
        before = self.call('status', id=ident)
        (self.project / 'hello.txt').write_text('three')
        with self.assertRaisesRegex(versions.Problem, 'değişti'):
            self.call('commit', id=ident, revision=before['state']['revision'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), value['state']['head'])

    def test_trial_scope_symlink_and_hardlink_rejected(self):
        for path in (self.root, self.root.parent, self.root / '..' / 'trial/sample'):
            with self.assertRaises(versions.Problem):
                self.call('inspect', path=str(path))
        (self.project / 'escape').symlink_to('/etc')
        with self.assertRaises(versions.Problem):
            self.register()
        (self.project / 'escape').unlink()
        os.link(self.project / 'hello.txt', self.project / 'hardlink')
        with self.assertRaises(versions.Problem):
            self.register()

    def test_parent_repository_is_detected_without_initializing_nested_repo(self):
        value = self.register()
        child = self.project / 'src'
        child.mkdir()
        found = self.call('inspect', path=str(child))
        self.assertEqual(found['registered'], value['project']['id'])
        self.assertEqual(found['path'], str(self.project))
        self.assertFalse((child / '.git').exists())

    def test_hooks_do_not_execute_and_special_config_is_rejected(self):
        value = self.register()
        hooks = self.project / '.git/hooks'
        hooks.mkdir(exist_ok=True)
        hook = hooks / 'pre-commit'
        hook.write_text('#!/bin/sh\ntouch "' + str(self.root / 'hook-ran') + '"\nexit 1\n')
        hook.chmod(0o755)
        (self.project / 'hello.txt').write_text('two')
        status = self.call('status', id=value['project']['id'])
        self.call('commit', id=value['project']['id'], revision=status['state']['revision'])
        self.assertFalse((self.root / 'hook-ran').exists())
        with (self.project / '.git/config').open('a') as file:
            file.write('\n[include]\npath=/etc/passwd\n')
        with self.assertRaises(versions.Problem):
            self.call('status', id=value['project']['id'])

    def test_disabled_feature_and_unknown_project_are_rejected(self):
        with self.assertRaises(versions.Problem):
            self.call('status', id='a' * 32)
        versions.CONFIG.write_text(json.dumps({'enabled': False, 'pilotRoot': str(self.root)}))
        with self.assertRaisesRegex(versions.Problem, 'kapalı'):
            self.call('list')

    def test_external_git_operation_and_tracked_secret_block_mutation(self):
        value = self.register()
        ident = value['project']['id']
        (self.project / '.git/MERGE_HEAD').write_text(value['state']['head'])
        state = self.call('status', id=ident)['state']
        self.assertTrue(state['blocked'])
        with self.assertRaises(versions.Problem):
            self.call('commit', id=ident, revision=state['revision'])
        (self.project / '.git/MERGE_HEAD').unlink()
        (self.project / '.env').write_text('TEST=1')
        self.git('add', '-f', '.env')
        self.assertIn('Hassas', self.call('status', id=ident)['state']['blocked'])

    def test_invalid_restore_target_changes_nothing(self):
        value = self.register()
        before = versions.inventory(self.project)
        with self.assertRaises(versions.Problem):
            self.call('restore', id=value['project']['id'], revision=value['state']['revision'], commit='f' * 40)
        self.assertEqual(versions.inventory(self.project), before)

    def test_restore_does_not_cross_an_excluded_runtime_symlink(self):
        folder = self.project / 'data'
        folder.mkdir()
        (folder / 'example.txt').write_text('old')
        first = self.register()
        ident = first['project']['id']
        self.git('rm', 'data/example.txt')
        current = self.call('status', id=ident)
        self.call('commit', id=ident, revision=current['state']['revision'])
        settings = json.loads(versions.CONFIG.read_text())
        settings['projectExcludes'] = {str(self.project): ['data']}
        versions.CONFIG.write_text(json.dumps(settings))
        outside = self.root / 'runtime'
        outside.mkdir()
        folder.symlink_to(outside, target_is_directory=True)
        before = self.call('status', id=ident)
        with self.assertRaisesRegex(versions.Problem, 'sembolik'):
            self.call('restore', id=ident, revision=before['state']['revision'], commit=first['state']['head'])
        self.assertTrue(folder.is_symlink())
        self.assertFalse((outside / 'example.txt').exists())
        self.assertEqual(self.git('rev-parse', 'HEAD'), before['state']['head'])

    def test_no_changes_does_not_create_empty_commit(self):
        value = self.register()
        result = self.call('commit', id=value['project']['id'], revision=value['state']['revision'])
        self.assertTrue(result['unchanged'])
        self.assertEqual(result['state']['head'], value['state']['head'])

    def test_history_diff_does_not_expose_deleted_secret(self):
        value = self.register()
        (self.project / '.env').write_text('EXAMPLE_ONLY=not-for-diff')
        self.git('add', '-f', '.env')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Old secret')
        self.git('rm', '.env')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Remove secret')
        with self.assertRaisesRegex(versions.Problem, 'içerik gösterilmedi'):
            self.call('diff', id=value['project']['id'], commit=self.git('rev-parse', 'HEAD'))

    def test_rename_delete_unicode_and_diff(self):
        value = self.register()
        (self.project / 'hello.txt').rename(self.project / 'Türkçe dosya.txt')
        (self.project / 'Türkçe dosya.txt').write_text('new content')
        status = self.call('status', id=value['project']['id'])
        self.assertEqual(len(status['state']['changes']), 2)
        saved = self.call('commit', id=value['project']['id'], revision=status['state']['revision'])
        diff = self.call('diff', id=value['project']['id'], commit=saved['state']['head'])
        self.assertIn('Türkçe dosya.txt', diff['text'])
        self.assertIn('new content', diff['text'])


if __name__ == '__main__':
    unittest.main()
