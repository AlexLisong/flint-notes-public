"""Load operator-owned configuration; public source contains examples only."""
import json
import re
from pathlib import Path


def load_config(path):
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise SystemExit('Deployment configuration is required; copy config.example.json to a private location and configure it.')
    config = json.loads(path.read_text())
    patterns = {
        'profile': r'[A-Za-z0-9_.-]+', 'region': r'[a-z]{2}(?:-[a-z]+)+-\d',
        'account': r'\d{12}', 'instance': r'i-[a-f0-9]{8,17}',
        'hostname': r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',
        'sshUser': r'[a-z_][a-z0-9_-]*', 'bucket': r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',
        'instanceProfile': r'[A-Za-z0-9+=,.@_-]+', 'role': r'[A-Za-z0-9+=,.@_-]+',
    }
    if any(not isinstance(config.get(key), str) or not re.fullmatch(pattern, config[key]) for key, pattern in patterns.items()):
        raise SystemExit('Deployment configuration is missing or has invalid fields.')
    if config['account'] == '000000000000' or config['hostname'].endswith('.example.com'):
        raise SystemExit('Replace example deployment values before using this tool.')
    return config
