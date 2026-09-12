#!/usr/bin/env python3
"""Create Flint's private bucket and add only a scoped policy to the existing role."""
import argparse
import json
from pathlib import Path
import subprocess

from deployment_config import load_config
CFG = {}


def aws(*args, absent_ok=False):
    result = subprocess.run(['aws', '--profile', CFG['profile'], '--region', CFG['region'], *args, '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        if absent_ok and any(code in result.stderr for code in ('NoSuchEntity', '404', 'Not Found')):
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    global CFG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[2] / '.data/aws/deployment.json')
    args = parser.parse_args()
    CFG = load_config(args.config)
    if aws('sts', 'get-caller-identity')['Account'] != CFG['account']:
        raise SystemExit('Wrong AWS account')
    instance = aws('ec2', 'describe-instances', '--instance-ids', CFG['instance'])['Reservations'][0]['Instances'][0]
    if instance.get('IamInstanceProfile', {}).get('Arn', '').split('/')[-1] != CFG['instanceProfile']:
        raise SystemExit('Unexpected instance profile; no role replacement is allowed')
    roles = aws('iam', 'get-instance-profile', '--instance-profile-name', CFG['instanceProfile'])['InstanceProfile']['Roles']
    if [role['RoleName'] for role in roles] != [CFG['role']]:
        raise SystemExit('Unexpected attached role')
    bucket = CFG['bucket']
    if aws('s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', CFG['account'], absent_ok=True) is None:
        location = () if CFG['region'] == 'us-east-1' else ('--create-bucket-configuration', json.dumps({'LocationConstraint': CFG['region']}))
        aws('s3api', 'create-bucket', '--bucket', bucket, *location)
    common = ('--bucket', bucket, '--expected-bucket-owner', CFG['account'])
    aws('s3api', 'put-public-access-block', *common, '--public-access-block-configuration', json.dumps(dict(BlockPublicAcls=True, IgnorePublicAcls=True, BlockPublicPolicy=True, RestrictPublicBuckets=True)))
    aws('s3api', 'put-bucket-ownership-controls', *common, '--ownership-controls', '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}')
    aws('s3api', 'put-bucket-encryption', *common, '--server-side-encryption-configuration', '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}')
    aws('s3api', 'put-bucket-versioning', *common, '--versioning-configuration', '{"Status":"Enabled"}')
    aws('s3api', 'put-bucket-lifecycle-configuration', *common, '--lifecycle-configuration', json.dumps({'Rules': [{'ID': 'flint-retention', 'Status': 'Enabled', 'Filter': {'Prefix': 'backups/'}, 'Expiration': {'Days': 30}, 'NoncurrentVersionExpiration': {'NoncurrentDays': 7}, 'AbortIncompleteMultipartUpload': {'DaysAfterInitiation': 1}}]}))
    aws('s3api', 'put-bucket-policy', *common, '--policy', json.dumps({'Version': '2012-10-17', 'Statement': [{'Sid': 'RequireTLS', 'Effect': 'Deny', 'Principal': '*', 'Action': 's3:*', 'Resource': [f'arn:aws:s3:::{bucket}', f'arn:aws:s3:::{bucket}/*'], 'Condition': {'Bool': {'aws:SecureTransport': 'false'}}}]}))
    aws('iam', 'put-role-policy', '--role-name', CFG['role'], '--policy-name', 'FlintBackupWriteOnly', '--policy-document', json.dumps({'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], 'Resource': f'arn:aws:s3:::{bucket}/backups/*'}]}))
    print(json.dumps({'bucket': bucket, 'role': CFG['role'], 'policy': 'FlintBackupWriteOnly', 'retentionDays': 30}))


if __name__ == '__main__':
    main()
