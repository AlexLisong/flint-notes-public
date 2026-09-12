#!/usr/bin/env python3
"""Check AWS identity and DNS, then transfer and install an existing release."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import socket
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]
from deployment_config import load_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / '.data/aws/deployment.json')
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--env-file', type=Path)
    args = parser.parse_args()
    CFG = load_config(args.config)
    if args.env_file and (not args.env_file.is_file() or args.env_file.is_symlink() or args.env_file.stat().st_mode & 0o077):
        raise SystemExit('Runtime environment file must be mode 0600')
    def aws(*arguments):
        return json.loads(subprocess.check_output(['aws', '--profile', CFG['profile'], '--region', CFG['region'], *arguments, '--output', 'json']))
    if aws('sts', 'get-caller-identity')['Account'] != CFG['account']:
        raise SystemExit('AWS account mismatch')
    instance = aws('ec2', 'describe-instances', '--instance-ids', CFG['instance'])['Reservations'][0]['Instances'][0]
    if instance['State']['Name'] != 'running':
        raise SystemExit('Target instance is not running')
    ip = instance['PublicIpAddress']
    if socket.gethostbyname(CFG['hostname']) != ip:
        raise SystemExit('DNS does not match the configured AWS instance')
    target = CFG['sshUser'] + '@' + ip
    options = ['-i', str(args.key.expanduser().resolve()), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']
    ssh = ['ssh', *options, target]
    remote = '/tmp/flint-deploy-' + uuid.uuid4().hex
    subprocess.run([*ssh, 'umask 077 && mkdir ' + shlex.quote(remote)], check=True)
    archive = args.archive.expanduser().resolve()
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    try:
        for local, name in ((archive, 'release.tar.gz'), (Path(__file__).with_name('install-release.py'), 'install-release.py'), (Path(__file__).with_name('deployment_config.py'), 'deployment_config.py'), (args.config.resolve(), 'deployment.json')):
            subprocess.run(['scp', *options, str(local), target + ':' + remote + '/' + name], check=True)
        command = ['sudo', 'python3', remote + '/install-release.py', remote + '/release.tar.gz', '--config', remote + '/deployment.json']
        if args.env_file:
            subprocess.run(['scp', *options, str(args.env_file.resolve()), target + ':' + remote + '/runtime.env'], check=True)
            command.extend(['--env-file', remote + '/runtime.env'])
        check = 'test "$(sha256sum ' + shlex.quote(remote + '/release.tar.gz') + ' | cut -d\' \' -f1)" = ' + shlex.quote(checksum)
        subprocess.run([*ssh, check + ' && ' + shlex.join(command)], check=True)
    finally:
        subprocess.run([*ssh, 'rm -rf -- ' + shlex.quote(remote)], check=True)
    print(json.dumps({'url': 'https://' + CFG['hostname'], 'archiveSha256': checksum}))


if __name__ == '__main__':
    main()
