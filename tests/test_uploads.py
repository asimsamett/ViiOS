import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import errno
from unittest.mock import patch

if sys.platform != 'linux':
    raise unittest.SkipTest('Linux upload tests run on the deployment host.')
source = pathlib.Path(__file__).parents[1] / 'server/files.py'
spec = importlib.util.spec_from_file_location('upload_broker', source)
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
COMMIT = b'\nMANAGEMENT-UPLOAD-COMMIT\n'


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='management-upload-tests-')
        self.root = pathlib.Path(self.temp.name) / 'projects'
        self.root.mkdir()
        self.store = pathlib.Path(self.temp.name) / 'store'
        self.patches = [patch.object(f, 'ROOTS', [str(self.root)]), patch.object(f, 'PROTECTED', [str(self.root / 'Management')]), patch.object(f, 'STORE', str(self.store))]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()
        self.temp.cleanup()

    def put(self, name, content, trailer=COMMIT, expected=None):
        return f.upload_stream({'path': str(self.root / name), 'size': len(content) if expected is None else expected}, io.BytesIO(content + trailer))

    def test_binary_empty_and_above_old_16mb_limit(self):
        for name, content in [('empty', b''), ('binary', b'\0\n\xff' * 100), ('large', b'a' * (17 * 1024 * 1024))]:
            result = self.put(name, content)
            self.assertEqual(result['bytes'], len(content))
            self.assertEqual((self.root / name).read_bytes(), content)
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o644)
        self.assertEqual(len((self.store / 'events.jsonl').read_text().splitlines()), 3)

    def test_short_extra_fake_commit_and_cancel_never_publish(self):
        cases = [(b'abc', b'', 3), (b'', b'', 0), (b'a', b'', 5), (b'abcX', COMMIT, 3), (b'abc'+COMMIT, COMMIT, 3)]
        for content, trailer, expected in cases:
            with self.assertRaises(f.Problem): self.put('target', content, trailer, expected)
            self.assertEqual(list(self.root.iterdir()), [])

    def test_no_overwrite_and_symlink_protected_traversal(self):
        self.put('existing', b'original')
        with self.assertRaises(f.Problem): self.put('existing', b'replacement')
        self.assertEqual((self.root / 'existing').read_bytes(), b'original')
        (self.root / 'folder').mkdir()
        (self.root / 'alias').symlink_to(self.root / 'folder')
        (self.root / 'Management').mkdir()
        for target in ['alias/file', 'Management/file', '../escape']:
            with self.assertRaises((f.Problem, OSError)): self.put(target, b'data')

    def test_folder_merge_nested_empty_and_conflict(self):
        for name in ['folder', 'folder/nested', 'folder/empty', 'folder']:
            f.execute({'action':'upload-directory', 'path':str(self.root / name)})
        self.put('folder/a.txt', b'outer')
        self.put('folder/nested/a.txt', b'inner')
        self.assertTrue((self.root / 'folder/empty').is_dir())
        with self.assertRaises(f.Problem): f.execute({'action':'upload-directory', 'path':str(self.root / 'folder/a.txt')})

    def test_disk_full_cleans_stage(self):
        with patch.object(f.os, 'fsync', side_effect=OSError(errno.ENOSPC, 'disk full')):
            with self.assertRaises(f.Problem) as caught: self.put('file', b'abc')
        self.assertEqual(caught.exception.status, 507)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_late_conflict_and_moved_parent_do_not_publish(self):
        outer = self
        class Changed(io.BytesIO):
            def read(self, n=-1):
                if not self.tell(): (outer.root / 'late').write_bytes(b'keep')
                return super().read(n)
        with self.assertRaises(f.Problem):
            f.upload_stream({'path':str(self.root / 'late'), 'size':3}, Changed(b'abc'+COMMIT))
        self.assertEqual((self.root / 'late').read_bytes(), b'keep')
        (self.root / 'folder').mkdir()
        class Moved(io.BytesIO):
            def read(self, n=-1):
                if not self.tell():
                    (outer.root / 'folder').rename(outer.root / 'moved')
                    (outer.root / 'folder').mkdir()
                return super().read(n)
        with self.assertRaises(f.Problem):
            f.upload_stream({'path':str(self.root / 'folder/file'), 'size':3}, Moved(b'abc'+COMMIT))
        self.assertEqual(list((self.root / 'folder').iterdir()), [])
        self.assertEqual(list((self.root / 'moved').iterdir()), [])

    def helper(self):
        script = "import runpy; f=runpy.run_path(%r); f['main'].__globals__.update(ROOTS=[%r],PROTECTED=[],STORE=%r); f['main']()" % (str(source), str(self.root), str(self.store))
        return subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_main_header_and_binary_in_same_pipe_write(self):
        payload = b'\0\n\xfffirst bytes' * 8192
        with self.helper() as proc:
            output, _ = proc.communicate(json.dumps({'action':'upload-stream','path':str(self.root/'binary'),'size':len(payload)}).encode()+b'\n'+payload+COMMIT, timeout=10)
            self.assertTrue(json.loads(output)['ok'])
        self.assertEqual((self.root/'binary').read_bytes(), payload)

    def test_sigterm_cleans_in_progress_stage(self):
        with self.helper() as proc:
            proc.stdin.write(json.dumps({'action':'upload-stream','path':str(self.root/'cancelled'),'size':2000000}).encode()+b'\npartial')
            proc.stdin.flush()
            deadline = time.monotonic()+5
            while not list(self.root.glob('.management-upload-*')) and time.monotonic()<deadline: time.sleep(.02)
            self.assertTrue(list(self.root.glob('.management-upload-*')))
            proc.terminate()
            proc.communicate(timeout=10)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__': unittest.main()
