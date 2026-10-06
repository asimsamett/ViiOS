import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location('package_source', Path(__file__).parents[1] / 'scripts/package-source.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PublicSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.put('package.json', '{"version":"1.0.0"}')
        self.put('app/main.js', 'export const name = "example";')
        self.list_sources(['app/main.js'])

    def put(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def list_sources(self, names):
        self.put(package.MANIFEST, json.dumps([package.MANIFEST, 'package.json', *names]))

    def test_zip_includes_only_approved_sources_never_runtime_data(self):
        for name in ('data/admin.json', 'data/connections/master.key', 'data/connections/servers.json',
                     'outputs/preview.png', '.env', '.codex/session.json', 'server/unreviewed-config.json'):
            self.put(name, 'DO_NOT_PUBLISH_THIS_RUNTIME_DATA')
        contents = package.collect_sources(self.root)
        archive, checksum = package.build_archive(self.root, contents)
        self.assertEqual(checksum, hashlib.sha256(archive.read_bytes()).hexdigest())
        with zipfile.ZipFile(archive) as bundle:
            self.assertEqual(set(bundle.namelist()), {package.ARCHIVE_ROOT + name for name in contents} |
                             {package.ARCHIVE_ROOT + 'PUBLIC-SOURCE-MANIFEST.json'})
            for entry in bundle.namelist():
                self.assertNotIn(b'DO_NOT_PUBLISH_THIS_RUNTIME_DATA', bundle.read(entry))
            manifest = json.loads(bundle.read(package.ARCHIVE_ROOT + 'PUBLIC-SOURCE-MANIFEST.json'))
            for item in manifest['files']:
                self.assertEqual(item['sha256'], hashlib.sha256(bundle.read(package.ARCHIVE_ROOT + item['path'])).hexdigest())
                self.assertNotIn(str(self.root), json.dumps(item))

    def test_even_explicitly_listed_private_paths_are_rejected(self):
        for name in ('data/admin.json', 'outputs/report.json', 'server/master.key', 'app/.env.local',
                     'server/inventory.json', '../outside.txt', '/absolute.txt', 'C:/private.txt', 'app/../package.json'):
            with self.subTest(name=name):
                self.list_sources([name])
                with self.assertRaises(package.PublicationError):
                    package.collect_sources(self.root)

    def test_private_addresses_and_credentials_stop_packaging_without_printing_values(self):
        private_address = '.'.join(('10', '42', '18', '23'))
        for sample in (private_address, private_address + '/24', 'ghp_' + 'x' * 36,
                       '-----BEGIN ' + 'PRIVATE KEY-----\n' + 'A' * 80 + '\n-----END PRIVATE KEY-----'):
            with self.subTest(kind=sample[:2]):
                self.put('app/main.js', sample)
                with self.assertRaises(package.PublicationError) as error:
                    package.collect_sources(self.root)
                self.assertNotIn(sample, str(error.exception))

    def test_documentation_addresses_and_loopback_are_valid_examples(self):
        self.put('app/main.js', 'http://192.0.2.10 http://198.51.100.10 http://203.0.113.10 http://127.0.0.1')
        self.assertIn('app/main.js', package.collect_sources(self.root))

    def test_nonempty_default_inventories_are_rejected(self):
        for name in ('server/apps.json', 'server/projects.json', 'server/file-targets.json', 'server/model-targets.json'):
            with self.subTest(name=name):
                self.put(name, '{"saved-server":"example"}')
                self.list_sources([name])
                with self.assertRaises(package.PublicationError):
                    package.collect_sources(self.root)

    def test_unreviewed_binary_and_duplicate_entry_are_rejected(self):
        (self.root / 'app/main.js').write_bytes(b'\xff\xfe\x00')
        with self.assertRaises(package.PublicationError):
            package.collect_sources(self.root)
        self.list_sources(['package.json'])
        with self.assertRaises(package.PublicationError):
            package.collect_sources(self.root)

    def test_custom_or_unknown_configuration_fields_are_rejected(self):
        for name in ('server/versioning.json', 'server/model-catalog-targets.json'):
            with self.subTest(name=name):
                config = {**package.GENERIC_CONFIGS[name], 'username': 'saved-account'}
                self.put(name, json.dumps(config))
                self.list_sources([name])
                with self.assertRaises(package.PublicationError):
                    package.collect_sources(self.root)
        config = {**package.GENERIC_CONFIGS['server/model-catalog-targets.json'], 'modelRoots': ['/private-project/models']}
        self.put('server/model-catalog-targets.json', json.dumps(config))
        with self.assertRaises(package.PublicationError):
            package.collect_sources(self.root)

    def test_hardlink_cannot_smuggle_unlisted_data(self):
        self.put('data/private.txt', 'private data')
        os.link(self.root / 'data/private.txt', self.root / 'app/linked.txt')
        self.list_sources(['app/linked.txt'])
        with self.assertRaises(package.PublicationError):
            package.collect_sources(self.root)

    def test_symlink_cannot_smuggle_unlisted_data(self):
        self.put('data/private.txt', 'private data')
        link = self.root / 'app/linked.txt'
        try:
            link.symlink_to(self.root / 'data/private.txt')
        except OSError:
            self.skipTest('Creating symbolic links requires privileges on this host')
        self.list_sources(['app/linked.txt'])
        with self.assertRaises(package.PublicationError):
            package.collect_sources(self.root)

    def test_archive_uses_the_validated_snapshot_and_is_reproducible(self):
        contents = package.collect_sources(self.root)
        self.put('app/main.js', 'changed after validation')
        first, checksum = package.build_archive(self.root, contents)
        second, repeated_checksum = package.build_archive(self.root, contents)
        self.assertEqual((first, checksum), (second, repeated_checksum))
        with zipfile.ZipFile(first) as bundle:
            self.assertEqual(bundle.read(package.ARCHIVE_ROOT + 'app/main.js'), contents['app/main.js'])


if __name__ == '__main__':
    unittest.main()
