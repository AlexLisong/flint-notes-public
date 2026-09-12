#!/usr/bin/env python3
"""Snapshot SQLite before copying immutable chunks; upload root-only archive to S3."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT = Path('/var/lib/flint')
DEST = Path('/var/backups/flint')
from deployment_config import load_config


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def snapshot_files(stage):
    """Accept only the standalone database, private config and immutable chunks."""
    files = []
    for path in sorted(stage.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Symlink in backup staging directory')
        if not path.is_file():
            continue
        name = str(path.relative_to(stage))
        if name not in ('flint.db', 'runtime.env') and not name.startswith('chunks/'):
            raise RuntimeError('Unexpected snapshot file: ' + name)
        files.append(path)
    if not {'flint.db', 'runtime.env'}.issubset({str(path.relative_to(stage)) for path in files}):
        raise RuntimeError('Snapshot database or runtime configuration missing')
    return files


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    CFG = load_config(os.environ.get('FLINT_DEPLOY_CONFIG', '/etc/flint/deployment.json'))
    os.umask(0o077)
    DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (DEST / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        final = DEST / f'flint-{stamp}.tar.gz'
        with tempfile.TemporaryDirectory(prefix='snapshot-', dir=DEST) as temporary:
            stage = Path(temporary)
            subprocess.run(['/usr/bin/node', str(Path(__file__).with_name('snapshot.mjs')), str(ROOT / 'flint.db'), str(stage / 'flint.db')], check=True)
            (stage / 'chunks').mkdir(mode=0o700)
            source = ROOT / 'chunks'
            if source.is_symlink():
                raise RuntimeError('Chunk directory must not be a symlink')
            for base, directories, files in os.walk(source):
                for name in directories + files:
                    path = Path(base) / name
                    if path.is_symlink():
                        raise RuntimeError('Symlink in chunk storage')
                    rel = path.relative_to(source)
                    target = stage / 'chunks' / rel
                    if path.is_dir():
                        target.mkdir(mode=0o700, exist_ok=True)
                    else:
                        shutil.copyfile(path, target)
            shutil.copyfile('/etc/flint/runtime.env', stage / 'runtime.env')
            paths = snapshot_files(stage)
            files = {str(path.relative_to(stage)): digest(path) for path in paths}
            release = json.loads(Path('/opt/flint/current/release.json').read_text())
            (stage / 'backup.json').write_text(json.dumps({'createdAt': stamp, 'sourceRelease': release['release'], 'files': files}, indent=2) + '\n')
            with tarfile.open(final, 'x:gz') as archive:
                for path in [stage / 'backup.json', *paths]:
                    archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
        # A local restore check is necessary before uploading any backup.
        subprocess.run(['/usr/bin/python3', str(Path(__file__).with_name('verify-backup.py')), str(final)], check=True)
        key = 'backups/' + final.name
        subprocess.run(['aws', 's3', 'cp', str(final), f's3://{CFG["bucket"]}/{key}', '--region', CFG['region'], '--sse', 'AES256', '--only-show-errors'], check=True)
        for path in DEST.glob('flint-*.tar.gz'):
            if path.stat().st_mtime < time.time() - 14 * 86400:
                path.unlink()
        print(json.dumps({'backup': final.name, 'sha256': digest(final), 's3Key': key, 'verified': True}))


if __name__ == '__main__':
    main()
