#!/usr/bin/env python3
"""Install a checksummed immutable release on the existing Ubuntu host."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request
from deployment_config import load_config

BASE = Path('/opt/flint')
HOSTNAME = ''
VHOST = Path('/etc/nginx/sites-available/flint')
ENABLED = Path('/etc/nginx/sites-enabled/flint')
ENV = Path('/etc/flint/runtime.env')


def run(*args, **kwargs):
    subprocess.run(list(args), check=True, **kwargs)


def atomic_bytes(path, data, mode=0o644):
    temporary = path.with_name(path.name + '.new')
    temporary.write_bytes(data)
    temporary.chmod(mode)
    temporary.replace(path)


def link_release(path):
    temporary = BASE / 'current.new'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(path)
    temporary.replace(BASE / 'current')


def healthy(url):
    for _ in range(15):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if json.load(response).get('ok') is True:
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError('Flint health check failed: ' + url)


def extract(archive):
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            allowed = member.name in ('package.json', 'package-lock.json', 'release.json') or any(member.name.startswith(prefix) for prefix in ('dist/', 'dist-server/', 'dist-bridge/', 'scripts/aws/'))
            if not member.isfile() or not allowed or path.is_absolute() or '..' in path.parts or member.name in names:
                raise RuntimeError('Invalid release archive member')
            names.add(member.name)
        manifest = json.load(source.extractfile('release.json'))
        if not re.fullmatch(r'flint-\d{8}T\d{12}Z', manifest['release']):
            raise RuntimeError('Invalid release identifier')
        if names != set(manifest['files']) | {'release.json'}:
            raise RuntimeError('Manifest mismatch')
        required = {'package.json', 'package-lock.json', 'dist/index.html', 'dist-server/index.js', 'dist-bridge/cli.js', 'scripts/aws/flint.service', 'scripts/aws/nginx.conf'}
        if not required.issubset(names):
            raise RuntimeError('Required runtime files missing')
        destination = BASE / 'releases' / manifest['release']
        destination.mkdir(mode=0o755)
        for member in members:
            data = source.extractfile(member).read()
            if member.name != 'release.json' and hashlib.sha256(data).hexdigest() != manifest['files'][member.name]:
                raise RuntimeError('Release checksum mismatch')
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
    return destination


def configure_env(source):
    if ENV.exists():
        if source and source.read_bytes() != ENV.read_bytes():
            raise RuntimeError('Existing runtime environment differs; refusing secret rotation')
        source = ENV
    if not source or source.is_symlink() or not source.is_file() or (source != ENV and source.stat().st_mode & 0o077):
        raise RuntimeError('First install requires a private mode-0600 runtime environment file')
    values = {}
    for line in source.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key in values or not re.fullmatch(r'[A-Z_]+', key) or not re.fullmatch(r'[A-Za-z0-9_./:@+-]+', value):
            raise RuntimeError('Invalid environment line')
        values[key] = value
    expected = {'PORT': '4317', 'HOST': '127.0.0.1', 'NODE_ENV': 'production', 'APP_ORIGIN': 'https://' + HOSTNAME, 'FLINT_DATA_DIR': '/var/lib/flint'}
    if any(values.get(key) != value for key, value in expected.items()) or len(values.get('FLINT_BOOTSTRAP_CODE', '')) < 32:
        raise RuntimeError('Runtime environment does not match Flint production configuration')
    if ENV.exists():
        return
    atomic_bytes(ENV, source.read_bytes(), 0o640)
    os.chown(ENV, 0, pwd.getpwnam('flint').pw_gid)


def main():
    global HOSTNAME, VHOST, ENABLED
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = load_config(args.config)
    HOSTNAME = config['hostname']
    VHOST = Path('/etc/nginx/sites-available') / HOSTNAME
    ENABLED = Path('/etc/nginx/sites-enabled') / HOSTNAME
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    if subprocess.check_output(['/usr/bin/node', '--version'], text=True).split('.')[0] != 'v22':
        raise SystemExit('Node 22 required')
    for command in ('nginx', 'certbot', 'aws', 'npm'):
        if not shutil.which(command):
            raise SystemExit(command + ' must already be installed; no shared package upgrades are performed')
    try:
        pwd.getpwnam('flint')
    except KeyError:
        run('useradd', '--system', '--home-dir', '/var/lib/flint', '--shell', '/usr/sbin/nologin', 'flint')
    account = pwd.getpwnam('flint')
    for path, mode, owner in ((BASE / 'releases', 0o755, 0), (Path('/etc/flint'), 0o750, 0), (Path('/var/lib/flint'), 0o700, account.pw_uid), (Path('/var/lib/flint/chunks'), 0o700, account.pw_uid), (Path('/var/backups/flint'), 0o700, 0), (Path('/var/www/flint-acme'), 0o755, 0)):
        path.mkdir(parents=True, exist_ok=True, mode=mode)
        path.chmod(mode)
        os.chown(path, owner, account.pw_gid if path == Path('/etc/flint') or owner else 0)
    configure_env(args.env_file)
    deployment = Path('/etc/flint/deployment.json')
    if deployment.exists() and json.loads(deployment.read_text()) != config:
        raise RuntimeError('Existing deployment configuration differs; review changes separately')
    atomic_bytes(deployment, (json.dumps(config, indent=2) + '\n').encode(), 0o600)
    destination = extract(args.archive)
    run('chown', '-R', 'flint:flint', str(destination))
    try:
        run('runuser', '-u', 'flint', '--', 'env', 'npm_config_cache=' + str(destination / '.npm-cache'), 'npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=destination)
    finally:
        shutil.rmtree(destination / '.npm-cache', ignore_errors=True)
        run('chown', '-R', 'root:root', str(destination))
        run('chmod', '-R', 'a-w', str(destination))
    scripts = destination / 'scripts/aws'
    units = ('flint.service', 'flint-backup.service', 'flint-backup.timer')
    previous_units = {name: (Path('/etc/systemd/system') / name).read_bytes() if (Path('/etc/systemd/system') / name).exists() else None for name in units}
    current = BASE / 'current'
    previous = current.resolve() if current.is_symlink() else None
    if previous:
        # Protect live state before changing runtime code or possible schema migrations.
        # Use verified candidate backup tooling so a backup bug in an old release
        # cannot prevent its own repair. It still snapshots the current live data
        # and records /opt/flint/current as the source release.
        run('python3', str(scripts / 'backup.py'))
    previous_vhost = VHOST.read_bytes() if VHOST.exists() else None
    was_enabled = ENABLED.is_symlink()
    activated = False
    try:
        for name in units:
            atomic_bytes(Path('/etc/systemd/system') / name, (scripts / name).read_bytes())
        run('systemctl', 'daemon-reload')
        link_release(destination)
        activated = True
        run('systemctl', 'restart', 'flint.service')
        healthy('http://127.0.0.1:4317/api/health')
        cert = Path('/etc/letsencrypt/live') / HOSTNAME / 'fullchain.pem'
        if not cert.exists():
            atomic_bytes(VHOST, (scripts / 'nginx-http.conf').read_text().replace('flint.example.com', HOSTNAME).encode())
            if not ENABLED.exists():
                ENABLED.symlink_to(VHOST)
            run('nginx', '-t')
            run('systemctl', 'reload', 'nginx')
            run('certbot', 'certonly', '--webroot', '-w', '/var/www/flint-acme', '-d', HOSTNAME, '--cert-name', HOSTNAME, '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--deploy-hook', 'nginx -t && systemctl reload nginx')
        atomic_bytes(VHOST, (scripts / 'nginx.conf').read_text().replace('flint.example.com', HOSTNAME).encode())
        if not ENABLED.exists():
            ENABLED.symlink_to(VHOST)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        healthy('https://' + HOSTNAME + '/api/health')
        run('systemctl', 'enable', 'flint.service')
        run('systemctl', 'enable', '--now', 'flint-backup.timer')
    except Exception:
        # Revert only Flint's code and service files. SQLite schema rollback is separate.
        if previous_vhost is None:
            VHOST.unlink(missing_ok=True)
        else:
            atomic_bytes(VHOST, previous_vhost)
        if not was_enabled:
            ENABLED.unlink(missing_ok=True)
        for name, data in previous_units.items():
            unit = Path('/etc/systemd/system') / name
            if data is None:
                unit.unlink(missing_ok=True)
            else:
                atomic_bytes(unit, data)
        if activated:
            run('systemctl', 'stop', 'flint.service')
        run('systemctl', 'daemon-reload')
        if previous:
            link_release(previous)
            run('systemctl', 'restart', 'flint.service')
            healthy('http://127.0.0.1:4317/api/health')
        elif activated:
            current.unlink(missing_ok=True)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        raise
    print(json.dumps({'release': destination.name, 'previousRelease': previous.name if previous else None, 'url': 'https://' + HOSTNAME, 'healthy': True}))


if __name__ == '__main__':
    main()
