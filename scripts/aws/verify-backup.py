#!/usr/bin/env python3
"""Restore an archive into a disposable directory, verify hashes and SQLite integrity."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tarfile
import tempfile


def verify(archive):
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='flint-restore-') as temporary:
        destination = Path(temporary)
        with tarfile.open(archive, 'r:gz') as source:
            members = source.getmembers()
            names = set()
            for member in members:
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in names:
                    raise RuntimeError('Invalid or duplicate backup archive member')
                names.add(member.name)
                if member.name not in ('flint.db', 'runtime.env', 'backup.json') and not member.name.startswith('chunks/'):
                    raise RuntimeError('Unexpected backup member')
            for member in members:
                target = destination / member.name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                data = source.extractfile(member)
                with target.open('xb') as output:
                    while chunk := data.read(1024 * 1024):
                        output.write(chunk)
        manifest = json.loads((destination / 'backup.json').read_text())
        if names != set(manifest['files']) | {'backup.json'}:
            raise RuntimeError('Manifest file list mismatch')
        for name, expected in manifest['files'].items():
            with (destination / name).open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                    raise RuntimeError(f'Checksum mismatch: {name}')
        if not (destination / 'runtime.env').stat().st_size:
            raise RuntimeError('Runtime environment missing')
        db = sqlite3.connect(f'file:{destination / "flint.db"}?mode=ro', uri=True)
        try:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise RuntimeError('SQLite integrity check failed')
            if db.execute('PRAGMA foreign_key_check').fetchall():
                raise RuntimeError('SQLite foreign key check failed')
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            counts = {table: db.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0] for table in tables}
            if 'chunks' not in tables:
                raise RuntimeError('Flint chunk table missing')
            for vault, chunk_id, size, expected in db.execute('SELECT vault_id, id, bytes, hash FROM chunks'):
                if not all(re.fullmatch(r'[0-9a-fA-F-]{36}', value) for value in (vault, chunk_id)):
                    raise RuntimeError('Invalid chunk identifier')
                path = destination / 'chunks' / vault / chunk_id
                if not path.is_file() or path.stat().st_size != size:
                    raise RuntimeError('Referenced chunk missing or incomplete')
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        raise RuntimeError('Referenced chunk hash mismatch')
        finally:
            db.close()
        return {'verified': True, 'sourceRelease': manifest['sourceRelease'], 'files': len(manifest['files']), 'tables': counts}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive)))
