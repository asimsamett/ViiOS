import importlib.util
import base64
import io
import os
import pathlib
import stat
import sys
import tempfile
import subprocess
import json
import unittest
import zipfile
from unittest.mock import patch

if sys.platform != 'linux':
    raise unittest.SkipTest('Linux file broker tests run on the deployment host.')
spec = importlib.util.spec_from_file_location('file_broker', pathlib.Path(__file__).parents[1] / 'server/files.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='management-files-tests-')
        self.root = pathlib.Path(self.temp.name) / 'projects'
        self.root.mkdir()
        self.roots = patch.object(f, 'ROOTS', [str(self.root)])
        self.protected = patch.object(f, 'PROTECTED', [str(self.root / 'Management')])
        self.roots.start()
        self.protected.start()

    def tearDown(self):
        self.roots.stop()
        self.protected.stop()
        self.temp.cleanup()

    def path(self, name):
        return str(self.root / name)

    def call(self, action, **values):
        return f.execute({'action': action, **values})

    def create(self, name='sample.txt', content='Merhaba dünya'):
        self.call('create', path=self.path(name), content=content)
        return self.call('read', path=self.path(name))

    def token(self, name):
        return f.revision(os.lstat(self.path(name)))

    def test_export_preserves_nested_empty_folders_names_content_and_source(self):
        self.call('mkdir', path=self.path('Türkçe'))
        self.call('mkdir', path=self.path('Türkçe/boş'))
        self.create('Türkçe/rapor.txt', 'Dışa aktarım')
        token = self.token('Türkçe')
        result = self.call('export', path=self.path('Türkçe'), revision=token)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
            self.assertEqual(set(archive.namelist()), {'Türkçe/', 'Türkçe/boş/', 'Türkçe/rapor.txt'})
            self.assertEqual(archive.read('Türkçe/rapor.txt').decode(), 'Dışa aktarım')
        self.assertEqual(result['name'], 'Türkçe.zip')
        self.assertEqual(self.token('Türkçe'), token)
        self.assertEqual(set(p.name for p in self.root.iterdir()), {'Türkçe'})

    def test_export_requires_current_revision_and_detects_mid_operation_change(self):
        original = self.create()
        for values in ({}, {'revision':'a'*64}):
            with self.assertRaises(f.Problem): self.call('export', path=original['path'], **values)
        original_archive = f.archive_tree
        def changed(*args):
            pathlib.Path(original['path']).write_text('changed content')
            return original_archive(*args)
        with patch.object(f, 'archive_tree', changed), self.assertRaises(f.Problem) as problem:
            self.call('export', path=original['path'], revision=original['revision'])
        self.assertEqual(problem.exception.status, 409)

    def test_export_rejects_links_special_files_protected_and_unsafe_archive_names(self):
        self.create('normal.txt')
        os.symlink(self.path('normal.txt'), self.path('link'))
        os.link(self.path('normal.txt'), self.path('hard'))
        os.mkfifo(self.path('pipe'))
        (self.root / '.ssh').mkdir()
        for filename in ('..\\escape', 'C:stream'):
            (self.root / filename).write_text('data')
        for filename in ('link','normal.txt','hard','pipe','.ssh','..\\escape','C:stream'):
            with self.assertRaises(f.Problem): self.call('export', path=self.path(filename), revision=self.token(filename))
        self.call('mkdir', path=self.path('folder'))
        os.symlink('/etc/passwd', self.path('folder/secret'))
        result = self.call('export', path=self.path('folder'), revision=self.token('folder'))
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
            self.assertEqual(archive.read('folder/secret'), b'/etc/passwd')
            self.assertTrue(stat.S_ISLNK(archive.getinfo('folder/secret').external_attr >> 16))
            self.assertEqual(set(archive.namelist()), {'folder/', 'folder/secret'})

    def test_export_is_independent_of_upload_copy_and_download_budgets(self):
        self.create('random.bin', 'initial')
        pathlib.Path(self.path('random.bin')).write_bytes(os.urandom(2048))
        with patch.object(f, 'FILE_LIMIT', 64), patch.object(f, 'COPY_LIMIT', 16), patch.object(f, 'ENTRY_LIMIT', 0):
            result = self.call('export', path=self.path('random.bin'), revision=self.token('random.bin'))
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
            self.assertEqual(archive.read('random.bin'), pathlib.Path(self.path('random.bin')).read_bytes())

    def test_export_includes_hardlinked_copies_only_when_all_links_are_in_archive(self):
        folder = self.root / 'project-copies'
        folder.mkdir()
        original = folder / 'first.txt'
        original.write_text('shared project data')
        os.link(original, folder / 'second.txt')
        result = self.call('export', path=str(folder), revision=self.token('project-copies'))
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
            for name in ('first.txt', 'second.txt'):
                self.assertEqual(archive.read('project-copies/' + name), b'shared project data')
        os.link(original, self.root / 'outside.txt')
        with self.assertRaises(f.Problem) as rejected:
            self.call('export', path=str(folder), revision=self.token('project-copies'))
        self.assertEqual(rejected.exception.status, 403)
        with self.assertRaises(f.Problem):
            self.call('copy', path=str(folder), destination=self.path('copy'), revision=self.token('project-copies'))

    def test_export_rechecks_hardlink_count_after_metadata_scan(self):
        folder = self.root / 'link-race'
        folder.mkdir()
        original = folder / 'first.txt'
        original.write_text('safe bytes')
        os.link(original, folder / 'second.txt')
        tree = f.archive_tree
        def changed(*args):
            if not (self.root / 'outside-after-scan.txt').exists():
                os.link(original, self.root / 'outside-after-scan.txt')
            return tree(*args)
        with patch.object(f, 'archive_tree', changed), self.assertRaises(f.Problem):
            self.call('export', path=str(folder), revision=self.token('link-race'))

    def test_export_hardlink_alias_cannot_count_one_directory_entry_twice(self):
        self.create('inside.txt', 'shared data')
        os.link(self.root / 'inside.txt', self.root / 'outside.txt')
        budget = {'entries': 0, 'bytes': 0}
        with f.parent(self.path('inside.txt')) as (fd, leaf):
            f.preflight(fd, leaf, self.path('inside.txt'), budget, depth=1, exporting=True)
            # A second view of the same physical parent/name is still one link.
            with self.assertRaises(f.Problem) as rejected:
                f.preflight(fd, leaf, self.path('inside.txt'), budget, exporting=True)
        self.assertEqual(rejected.exception.status, 403)

    def test_export_exceeds_all_former_limits_and_keeps_zip_integrity(self):
        folder = self.root / 'large-export'
        folder.mkdir()
        with (folder / 'large.bin').open('wb') as output:
            output.truncate(201 * 1024 * 1024)
        random = os.urandom(17 * 1024 * 1024)
        (folder / 'random.bin').write_bytes(random)
        for index in range(5001): (folder / f'empty-{index}').touch()
        result = self.call('export', path=str(folder), revision=self.token('large-export'))
        data = base64.b64decode(result['data'])
        self.assertGreater(len(data), 16 * 1024 * 1024)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(len(archive.infolist()), 5004)
            self.assertEqual(archive.getinfo('large-export/large.bin').file_size, 201 * 1024 * 1024)
            self.assertEqual(archive.read('large-export/random.bin'), random)
            self.assertIsNone(archive.testzip())

    def test_export_compresses_large_source_without_download_size_restriction(self):
        content = b'A' * 4096
        pathlib.Path(self.path('large.txt')).write_bytes(content)
        with patch.object(f, 'FILE_LIMIT', 512):
            result = self.call('export', path=self.path('large.txt'), revision=self.token('large.txt'))
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
            self.assertEqual(archive.read('large.txt'), content)

    def stream_child(self, filename):
        source = str(pathlib.Path(__file__).parents[1] / 'server/files.py')
        code = f"import importlib.util; s=importlib.util.spec_from_file_location('broker', {source!r}); f=importlib.util.module_from_spec(s); s.loader.exec_module(f); f.ROOTS=[{str(self.root)!r}]; f.main()"
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.stdin.write((json.dumps({'action':'export-stream','path':self.path(filename),'revision':self.token(filename)})+'\n').encode())
        child.stdin.flush()
        return child

    def test_stream_supports_zip64_single_file_and_exits_cleanly(self):
        expected = 2 * 1024 * 1024 * 1024 + 1
        with (self.root / 'zip64.bin').open('wb') as output: output.truncate(expected)
        child = self.stream_child('zip64.bin')
        try:
            metadata = json.loads(child.stdout.readline())
            self.assertEqual(metadata['bytes'], expected)
            with tempfile.TemporaryFile() as archive_file:
                while True:
                    chunk = child.stdout.read(1024 * 1024)
                    if not chunk: break
                    archive_file.write(chunk)
                self.assertEqual(child.wait(timeout=10), 0, child.stderr.read().decode())
                archive_file.seek(0)
                with zipfile.ZipFile(archive_file) as archive:
                    item = archive.getinfo('zip64.bin')
                    self.assertEqual(item.file_size, expected)
                    self.assertGreaterEqual(item.extract_version, 45)
                    with archive.open(item) as content: self.assertEqual(content.read(32), bytes(32))
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdin.close(); child.stdout.close(); child.stderr.close()

    def test_stream_stops_when_the_request_pipe_disconnects(self):
        with (self.root / 'cancel.bin').open('wb') as output: output.truncate(2 * 1024 * 1024 * 1024)
        child = self.stream_child('cancel.bin')
        try:
            self.assertTrue(json.loads(child.stdout.readline())['ok'])
            child.stdin.close()
            self.assertEqual(child.wait(timeout=5), 143)
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdout.close(); child.stderr.close()

    def test_create_list_read_edit_and_stale_revision(self):
        original = self.create('Türkçe $() `ad`.txt')
        self.assertEqual(original['content'], 'Merhaba dünya')
        self.call('write', path=original['path'], content='Yeni içerik', revision=original['revision'])
        with self.assertRaises(f.Problem) as conflict:
            self.call('write', path=original['path'], content='Eski içerik', revision=original['revision'])
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(pathlib.Path(original['path']).read_text(), 'Yeni içerik')
        listing = self.call('list', path=str(self.root))
        self.assertEqual(listing['total'], 1)
        self.assertTrue(listing['entries'][0]['mutable'])

    def test_properties_count_hidden_nested_files_without_reading_contents(self):
        folder = self.root / 'properties'
        (folder / '.venv').mkdir(parents=True)
        (folder / 'a.txt').write_bytes(b'12345')
        (folder / '.venv' / 'b.txt').write_bytes(b'1234567')
        os.symlink('/etc/shadow', folder / 'external-link')
        os.mkfifo(folder / 'pipe')
        with patch.object(f.os, 'read', side_effect=AssertionError('File contents must not be read')):
            result = self.call('properties', path=str(folder))
        self.assertEqual(result['sizeBytes'], 12)
        self.assertEqual((result['files'],result['directories'],result['links'],result['special']), (2,1,1,1))
        self.assertFalse(result['partial'])
        self.assertEqual(result['permissions'], format(stat.S_IMODE(folder.stat().st_mode),'04o'))
        self.assertEqual(self.call('properties',path=str(folder/'a.txt'))['sizeBytes'],5)

    def test_properties_sparse_files_and_hardlinks_use_unique_allocated_blocks(self):
        folder = self.root / 'sparse-properties'
        folder.mkdir()
        with (folder/'sparse.bin').open('wb') as output: output.truncate(4*1024*1024)
        os.link(folder/'sparse.bin',folder/'shared.bin')
        result = self.call('properties',path=str(folder))
        self.assertEqual(result['sizeBytes'],8*1024*1024)
        expected=(folder.stat().st_blocks+(folder/'sparse.bin').stat().st_blocks)*512
        self.assertEqual(result['allocatedBytes'],expected)
        self.assertEqual(result['sharedReferences'],1)
        self.assertLess(result['allocatedBytes'],result['sizeBytes'])

    def test_properties_only_expose_metadata_visible_from_allowed_parent(self):
        protected=self.root/'Management'
        protected.mkdir()
        (protected/'.env').write_text('must not inspect')
        result=self.call('properties',path=str(protected))
        self.assertTrue(result['restricted'])
        self.assertIsNone(result['sizeBytes'])
        with self.assertRaises(f.Problem): self.call('properties',path=str(protected/'.env'))
        with self.assertRaises(f.Problem): self.call('properties',path='/etc/shadow')
        root_metadata=self.call('properties',path='/etc')
        self.assertTrue(root_metadata['restricted'])
        self.assertIsNone(root_metadata['sizeBytes'])
        result=self.call('properties',path=str(self.root))
        self.assertTrue(result['partial'])
        self.assertEqual(result['skipped'],1)
        self.assertEqual(result['sizeBytes'],0)

    def test_properties_unreadable_or_time_bounded_results_are_marked_partial(self):
        folder=self.root/'properties-partial'
        (folder/'denied').mkdir(parents=True)
        (folder/'denied'/'not-counted').write_bytes(b'1234')
        real_open=f.os.open
        def open_entry(path,*args,**kwargs):
            if path=='denied': raise PermissionError('denied')
            return real_open(path,*args,**kwargs)
        with patch.object(f.os,'open',open_entry): result=self.call('properties',path=str(folder))
        self.assertTrue(result['partial'])
        self.assertEqual(result['skipped'],1)
        self.assertEqual(result['sizeBytes'],0)
        with patch.object(f,'PROPERTIES_SECONDS',0): result=self.call('properties',path=str(folder))
        self.assertTrue(result['partial'])
        self.assertTrue(result['timedOut'])

    def test_search_nested_files_turkish_names_and_root_scope(self):
        (self.root / 'proje').mkdir()
        self.create('proje/İŞLEM-çığ.txt')
        self.create('proje/I\u0307s\u0327lem.txt')
        result = self.call('search', path='/', query='işlem')
        self.assertEqual(len(result['entries']), 2)
        self.assertTrue(all(e['path'].startswith(str(self.root)) and e['accessible'] and e['revision'] for e in result['entries']))
        self.assertEqual(len(self.call('search', path=str(self.root), query='ISLEM cig')['entries']), 1)
        self.assertFalse(result['truncated'])
        for path in ['/etc', str(self.root) + '/..']:
            with self.assertRaises(f.Problem):
                self.call('search', path=path, query='passwd')

    def test_search_excludes_protected_links_and_dependency_contents(self):
        for folder in ['Management', '.ssh', '.gnupg', '.management-trash', 'node_modules', 'Management2', '.hidden']:
            (self.root / folder).mkdir()
            (self.root / folder / 'needle.txt').write_text('test')
        os.symlink(self.root / 'Management2', self.root / 'needle-link')
        (self.root / 'needle-hard').write_text('test')
        os.link(self.root / 'needle-hard', self.root / 'needle-hard2')
        os.mkfifo(self.root / 'needle-fifo')
        result = self.call('search', path='/', query='needle', hidden=True)
        self.assertEqual({e['path'] for e in result['entries']}, {self.path('Management2/needle.txt'), self.path('.hidden/needle.txt')})
        result = self.call('search', path='/', query='needle', hidden=False)
        self.assertEqual([e['path'] for e in result['entries']], [self.path('Management2/needle.txt')])

    def test_search_budgets_count_nonmatching_entries_and_mark_partial_results(self):
        for i in range(15):
            (self.root / ('other-' + str(i))).touch()
        with patch.object(f, 'SEARCH_VISITS', 5):
            result = self.call('search', path='/', query='missing')
        self.assertEqual(result['visited'], 5)
        self.assertTrue(result['truncated'])
        self.assertIn('entry-limit', result['reasons'])
        with patch.object(f, 'SEARCH_RESULTS', 2):
            result = self.call('search', path='/', query='other')
        self.assertEqual(len(result['entries']), 2)
        self.assertIn('result-limit', result['reasons'])
        with patch.object(f, 'SEARCH_SECONDS', 0):
            self.assertIn('time-limit', self.call('search', path='/', query='other')['reasons'])
        (self.root / 'nested').mkdir()
        with patch.object(f, 'SEARCH_DEPTH', 0):
            self.assertIn('depth-limit', self.call('search', path='/', query='missing')['reasons'])

    def test_atomic_save_preserves_file_owner_and_permissions(self):
        self.create()
        os.chmod(self.path('sample.txt'), 0o640)
        info = os.stat(self.path('sample.txt'))
        self.call('write', path=self.path('sample.txt'), content='saved', revision=self.token('sample.txt'))
        saved = os.stat(self.path('sample.txt'))
        self.assertEqual((saved.st_uid, saved.st_gid, stat.S_IMODE(saved.st_mode)), (info.st_uid, info.st_gid, 0o640))

    def test_names_and_paths_cannot_escape_or_create_reserved_locations(self):
        for value in ['../outside', 'new\nfile', '.ssh/key', '.management-secret']:
            with self.subTest(value=value), self.assertRaises(f.Problem):
                self.call('create', path=self.path(value), content='no')
        for path in ['/etc/passwd', str(self.root) + '/..', self.path('Management/config'), 'relative']:
            with self.assertRaises(f.Problem):
                self.call('read', path=path)
        with self.assertRaises(f.Problem):
            self.call('trash', path=str(self.root), revision=self.token('.'))

    def test_symlink_components_hardlinks_and_special_files_are_rejected(self):
        os.symlink('/etc', self.path('link'))
        with self.assertRaises(OSError):
            self.call('read', path=self.path('link/passwd'))
        os.symlink('/etc/passwd', self.path('secret'))
        with self.assertRaises(f.Problem):
            self.call('read', path=self.path('secret'))
        self.create()
        os.link(self.path('sample.txt'), self.path('hardlink'))
        with self.assertRaises(f.Problem):
            self.call('read', path=self.path('hardlink'))
        os.mkfifo(self.path('fifo'))
        with self.assertRaises(f.Problem):
            self.call('read', path=self.path('fifo'))

    def test_create_and_copy_never_overwrite(self):
        source = self.create()
        self.create('target.txt', 'keep me')
        for action in ['create', 'copy']:
            with self.assertRaises(f.Problem):
                self.call(action, path=self.path('target.txt') if action == 'create' else source['path'], destination=self.path('target.txt'), content='overwrite', revision=source['revision'])
        self.assertEqual(pathlib.Path(self.path('target.txt')).read_text(), 'keep me')

    def test_nested_directory_copy_and_move(self):
        self.call('mkdir', path=self.path('source'))
        self.call('mkdir', path=self.path('source/child'))
        self.create('source/child/hello.txt')
        self.call('copy', path=self.path('source'), destination=self.path('copy'), revision=self.token('source'))
        self.assertEqual(pathlib.Path(self.path('copy/child/hello.txt')).read_text(), 'Merhaba dünya')
        self.call('move', path=self.path('copy'), destination=self.path('renamed'), revision=self.token('copy'))
        self.assertFalse(pathlib.Path(self.path('copy')).exists())
        self.assertTrue(pathlib.Path(self.path('renamed/child/hello.txt')).exists())
        with self.assertRaises(f.Problem):
            self.call('copy', path=self.path('source'), destination=self.path('source/nested'), revision=self.token('source'))

    def test_copy_rejects_links_and_protected_descendants_before_creation(self):
        self.call('mkdir', path=self.path('source'))
        os.symlink('/etc/passwd', self.path('source/link'))
        with self.assertRaises(f.Problem):
            self.call('copy', path=self.path('source'), destination=self.path('target'), revision=self.token('source'))
        self.assertFalse(pathlib.Path(self.path('target')).exists())
        os.unlink(self.path('source/link'))
        pathlib.Path(self.path('source/.ssh')).mkdir()
        with self.assertRaises(f.Problem):
            self.call('trash', path=self.path('source'), revision=self.token('source'))
        self.assertTrue(pathlib.Path(self.path('source/.ssh')).exists())

    def test_copy_conflict_at_publish_preserves_destination_and_cleans_only_stage(self):
        source = self.create()
        original = f.no_replace
        def conflict(src, src_name, dst, target):
            handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dst)
            os.write(handle, b'concurrent writer')
            os.close(handle)
            return original(src, src_name, dst, target)
        with patch.object(f, 'no_replace', conflict), self.assertRaises(f.Problem):
            self.call('copy', path=source['path'], destination=self.path('target'), revision=source['revision'])
        self.assertEqual(pathlib.Path(self.path('target')).read_text(), 'concurrent writer')
        self.assertFalse(list(self.root.glob('.management-copy-*')))

    @unittest.skipUnless(os.geteuid() == 0, 'Root private-trash invariants require root.')
    def test_trash_restore_conflict_and_original_contents(self):
        source = self.create()
        removed = self.call('trash', path=source['path'], revision=source['revision'])
        self.assertFalse(pathlib.Path(source['path']).exists())
        self.assertEqual(len(self.call('trash-list')['entries']), 1)
        self.create(content='new occupant')
        with self.assertRaises(f.Problem):
            self.call('restore', root=removed['root'], id=removed['id'])
        os.unlink(source['path'])
        self.call('restore', root=removed['root'], id=removed['id'])
        self.assertEqual(pathlib.Path(source['path']).read_text(), 'Merhaba dünya')
        self.assertEqual(self.call('trash-list')['entries'], [])

    def test_forged_trash_permissions_and_fifo_metadata_rejected(self):
        store = self.root / '.management-trash'
        store.mkdir(mode=0o755)
        os.chmod(store, 0o755)
        with self.assertRaises(f.Problem):
            self.call('trash-list')
        if os.geteuid() != 0:
            return
        os.chmod(store, 0o700)
        ident = 'a' * 32
        item = store / ident
        item.mkdir(mode=0o700)
        (item / 'item').write_text('fake')
        os.mkfifo(item / 'meta.json')
        with self.assertRaises(f.Problem):
            self.call('trash-list')
        with self.assertRaises(f.Problem):
            self.call('restore', root=str(self.root), id=ident)

    def test_preview_never_executes_html_svg_and_recognizes_raster(self):
        html = self.create('page.html', '<script>steal()</script>')
        self.assertEqual(html['kind'], 'text')
        svg = self.create('image.svg', '<svg onload="steal()"/>')
        self.assertEqual(svg['kind'], 'text')
        self.assertIsNone(f.image_mime(b'<svg/>'))
        self.assertEqual(f.image_mime(b'\x89PNG\r\n\x1a\n'), 'image/png')

    def test_unknown_actions_size_limits_and_missing_revisions(self):
        original = self.create()
        with self.assertRaises(f.Problem):
            self.call('exec', command='whoami')
        with self.assertRaises(f.Problem):
            self.call('write', path=original['path'], content='no revision')
        with self.assertRaises(f.Problem):
            self.call('create', path=self.path('large'), content='x' * (f.TEXT_LIMIT + 1))
        with self.assertRaises(f.Problem):
            self.call('restore', root=str(self.root), id='../outside')


if __name__ == '__main__':
    unittest.main()
