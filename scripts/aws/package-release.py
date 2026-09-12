#!/usr/bin/env python3
"""Package only verified build outputs and dependency manifests, never local data."""
import datetime
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SCRIPTS = (
    'backup.py',
    'deployment_config.py',
    'flint-backup.service',
    'flint-backup.timer',
    'flint.service',
    'nginx-http.conf',
    'nginx.conf',
    'snapshot.mjs',
    'verify-backup.py',
)


def package():
    for name in ('dist/index.html', 'dist-server/index.js', 'dist-bridge/cli.js'):
        if not (ROOT / name).is_file():
            raise SystemExit('Run npm run build before packaging')
    paths = [ROOT / name for name in ('package.json', 'package-lock.json')]
    # Never walk the operator's script directory: ignored secrets and private
    # configuration can be adjacent to public tooling, including in subfolders.
    for name in RUNTIME_SCRIPTS:
        path = ROOT / 'scripts/aws' / name
        if not path.is_file():
            raise SystemExit(f'Required runtime script missing: scripts/aws/{name}')
        paths.append(path)
    for directory in ('dist', 'dist-server', 'dist-bridge'):
        paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    contents = {}
    for path in sorted(paths):
        rel = path.relative_to(ROOT)
        if any(ROOT.joinpath(*rel.parts[:i]).is_symlink() for i in range(1, len(rel.parts) + 1)):
            raise SystemExit(f'Symlink refused: {rel}')
        contents[str(rel)] = path.read_bytes()
    commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, capture_output=True)
    release = 'flint-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    manifest = {
        'release': release,
        'sourceCommit': commit.stdout.strip() if commit.returncode == 0 else None,
        'workingTreeChanges': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)),
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()},
    }
    contents['release.json'] = json.dumps(manifest, indent=2).encode()
    destination = ROOT / '.data/aws' / (release + '.tar.gz')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with destination.open('xb') as output:
        destination.chmod(0o600)
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, data in contents.items():
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(data), 0o644
                archive.addfile(entry, io.BytesIO(data))
    return {'release': release, 'archive': str(destination), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


if __name__ == '__main__':
    print(json.dumps(package()))
