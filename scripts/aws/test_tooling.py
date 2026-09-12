"""Local safety checks for artifact boundaries and disposable backup restores."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def archive_at(path, contents):
    with tarfile.open(path, 'w:gz') as archive:
        for name, data in contents.items():
            entry = tarfile.TarInfo(name)
            entry.mode, entry.size = 0o600, len(data)
            archive.addfile(entry, io.BytesIO(data))


class ToolingTest(unittest.TestCase):
    def test_private_config_and_public_examples(self):
        loader = module('deployment_config')
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'deployment.json'
            config = json.loads((HERE / 'config.example.json').read_text())
            path.write_text(json.dumps(config))
            with self.assertRaises(SystemExit):
                loader.load_config(path)
            config.update(account='123456789012', hostname='notes.example.net')
            path.write_text(json.dumps(config))
            self.assertEqual(loader.load_config(path)['hostname'], 'notes.example.net')
            for invalid in ('notes.example.net;command', '../../private', 'notes.example.net\\nserver {}'):
                config['hostname'] = invalid
                path.write_text(json.dumps(config))
                with self.assertRaises(SystemExit):
                    loader.load_config(path)

    def test_release_allowlist_and_manifest(self):
        packager = module('package-release')
        installer = module('install-release')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            runtime_scripts = {
                'scripts/aws/backup.py', 'scripts/aws/deployment_config.py',
                'scripts/aws/flint-backup.service', 'scripts/aws/flint-backup.timer',
                'scripts/aws/flint.service', 'scripts/aws/nginx-http.conf',
                'scripts/aws/nginx.conf', 'scripts/aws/snapshot.mjs',
                'scripts/aws/verify-backup.py',
            }
            private_neighbors = {
                'scripts/aws/config.json', 'scripts/aws/deployment.json',
                'scripts/aws/.env.production', 'scripts/aws/private-key.pem',
                'scripts/aws/config.production.json', 'scripts/aws/private/backup.py',
                'scripts/aws/private/.env', 'scripts/aws/private/session.json',
            }
            outputs = {'package.json', 'package-lock.json', 'dist/index.html', 'dist-server/index.js', 'dist-bridge/cli.js'}
            (root / '.gitignore').write_text('.env*\n*.pem\nconfig*.json\nprivate/\n')
            for name in outputs | runtime_scripts | private_neighbors | {'.data/secret.json', 'vault/private.md'}:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}')
            (root / 'scripts/aws/private-link.pem').symlink_to(root / '.data/secret.json')
            with patch.object(packager, 'ROOT', root):
                result = packager.package()
            with tarfile.open(result['archive']) as archive:
                names = set(archive.getnames())
                manifest = json.load(archive.extractfile('release.json'))
                self.assertFalse(any(name.startswith(('.data/', 'vault/')) for name in names))
                self.assertTrue(runtime_scripts.issubset(names))
                self.assertTrue(names.isdisjoint(private_neighbors))
                self.assertNotIn('scripts/aws/private-link.pem', names)
                self.assertEqual(names, outputs | runtime_scripts | {'release.json'})
                self.assertEqual(names, set(manifest['files']) | {'release.json'})
                self.assertIsNone(manifest['sourceCommit'])
            destination = root / 'install'
            (destination / 'releases').mkdir(parents=True)
            with patch.object(installer, 'BASE', destination):
                installed = installer.extract(result['archive'])
                self.assertEqual((installed / 'dist/index.html').read_text(), '{}')
            (root / 'dist/leak').symlink_to(root / '.data/secret.json')
            with patch.object(packager, 'ROOT', root), self.assertRaises(SystemExit):
                packager.package()
            (root / 'dist/leak').unlink()
            required_script = root / 'scripts/aws/backup.py'
            required_script.unlink()
            with patch.object(packager, 'ROOT', root), self.assertRaisesRegex(SystemExit, 'Required runtime script missing'):
                packager.package()
            required_script.symlink_to(root / '.data/secret.json')
            with patch.object(packager, 'ROOT', root), self.assertRaisesRegex(SystemExit, 'Symlink refused'):
                packager.package()

    def test_snapshot_and_verified_restore_reject_tamper_and_missing_chunks(self):
        verifier = module('verify-backup')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b'encrypted-attachment-sample'
            digest = hashlib.sha256(data).hexdigest()
            vault, chunk = '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'
            db = sqlite3.connect(root / 'live.db')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE chunks(vault_id TEXT,id TEXT,bytes INTEGER,hash TEXT)')
            db.execute('INSERT INTO chunks VALUES(?,?,?,?)', (vault, chunk, len(data), digest))
            db.commit()
            subprocess.run(['node', str(HERE / 'snapshot.mjs'), str(root / 'live.db'), str(root / 'snapshot.db')], check=True, capture_output=True)
            self.assertEqual({path.name for path in root.glob('snapshot.db*')}, {'snapshot.db'})
            snapshot = sqlite3.connect(root / 'snapshot.db')
            self.assertEqual(snapshot.execute('PRAGMA journal_mode').fetchone(), ('delete',))
            snapshot.close()
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone(), ('wal',))
            # Subsequent live writes do not affect the consistent backup.
            db.execute('DELETE FROM chunks')
            db.commit()
            db.close()
            contents = {'flint.db': (root / 'snapshot.db').read_bytes(), 'runtime.env': b'PRIVATE_CONFIG=example\n', f'chunks/{vault}/{chunk}': data}
            manifest = {'sourceRelease': 'test-release', 'files': {name: hashlib.sha256(value).hexdigest() for name, value in contents.items()}}
            contents['backup.json'] = json.dumps(manifest).encode()
            archive = root / 'backup.tar.gz'
            archive_at(archive, contents)
            result = verifier.verify(archive)
            self.assertTrue(result['verified'])
            self.assertEqual(result['tables']['chunks'], 1)
            contents[f'chunks/{vault}/{chunk}'] = b'changed'
            archive_at(archive, contents)
            with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
                verifier.verify(archive)
            del contents[f'chunks/{vault}/{chunk}']
            del manifest['files'][f'chunks/{vault}/{chunk}']
            contents['backup.json'] = json.dumps(manifest).encode()
            archive_at(archive, contents)
            with self.assertRaisesRegex(RuntimeError, 'Referenced chunk missing'):
                verifier.verify(archive)
            contents['../escape'] = b'bad'
            archive_at(archive, contents)
            with self.assertRaisesRegex(RuntimeError, 'Invalid or duplicate'):
                verifier.verify(archive)

    def test_backup_packaging_rejects_sidecars_and_restores_live_wal_snapshot(self):
        backuper, verifier = module('backup'), module('verify-backup')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / 'stage'
            stage.mkdir()
            live = sqlite3.connect(root / 'live.db')
            live.execute('PRAGMA journal_mode=WAL')
            live.execute('PRAGMA wal_autocheckpoint=0')
            live.execute('CREATE TABLE chunks(vault_id TEXT,id TEXT,bytes INTEGER,hash TEXT)')
            live.execute('CREATE TABLE notes(id INTEGER, body TEXT)')
            live.executemany('INSERT INTO notes VALUES(?,?)', [(i, 'snapshot data ' + str(i)) for i in range(200)])
            live.commit()
            self.assertGreater((root / 'live.db-wal').stat().st_size, 0)
            try:
                subprocess.run(['node', str(HERE / 'snapshot.mjs'), str(root / 'live.db'), str(stage / 'flint.db')], check=True, capture_output=True)
                self.assertEqual({path.name for path in stage.iterdir()}, {'flint.db'})
                (stage / 'runtime.env').write_text('PRIVATE_CONFIG=example\n')
                (stage / 'chunks').mkdir()
                paths = backuper.snapshot_files(stage)
                manifest = {'sourceRelease': 'wal-regression', 'files': {str(path.relative_to(stage)): backuper.digest(path) for path in paths}}
                contents = {str(path.relative_to(stage)): path.read_bytes() for path in paths}
                contents['backup.json'] = json.dumps(manifest).encode()
                archive = root / 'snapshot.tar.gz'
                archive_at(archive, contents)
                # Changing the live WAL after the snapshot leaves the archive intact.
                live.execute('DELETE FROM notes')
                live.commit()
                self.assertEqual(verifier.verify(archive)['tables']['notes'], 200)
                (stage / 'flint.db-wal').write_bytes(b'')
                with self.assertRaisesRegex(RuntimeError, 'Unexpected snapshot file: flint.db-wal'):
                    backuper.snapshot_files(stage)
            finally:
                live.close()


if __name__ == '__main__':
    unittest.main()
