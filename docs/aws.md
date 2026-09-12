# Self-hosting and recovery

Flint can run on a Node 22 host with SQLite and a trusted HTTPS reverse proxy. Optional Linux/systemd/nginx and AWS backup tools live under `scripts/aws/`; they are configurable examples, not a description of a current deployment.

## Runtime configuration

Build with `npm ci` and `npm run build`. Supply a private environment file outside the checkout with restrictive permissions:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4317
APP_ORIGIN=https://flint.example.com
FLINT_DATA_DIR=/var/lib/flint
FLINT_BOOTSTRAP_CODE=replace-with-a-private-random-code-at-least-32-characters
```

Replace the example origin and bootstrap value. Keep the exact HTTPS origin, loopback listener and private data directory. Start the built server with `node --env-file=/path/to/private/runtime.env dist-server/index.js`, or use the systemd tooling below. Development's public registration code must never be used on a shared server.

Account passwords and private vault phrases have separate recovery paths. A server backup cannot recover a lost vault phrase; keep recovery material with a trusted client. Published snapshots are deliberately plaintext.

## Optional AWS tooling

The scripts assume an operator-owned Linux instance, Node 22, Python 3.11+, nginx, Certbot, AWS CLI and an existing instance role. They do not create a VM, replace its role or manage security groups.

Copy `scripts/aws/config.example.json` to an ignored private path such as `.data/aws/deployment.json`, then replace every example field. This file contains operator infrastructure identifiers and must not be committed. The config loader rejects placeholder account/domain values and malformed fields.

```sh
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/aws -p 'test_*.py'
python3 scripts/aws/provision-backups.py --config .data/aws/deployment.json
python3 scripts/aws/package-release.py
python3 scripts/aws/deploy.py \
  --config .data/aws/deployment.json \
  --key /path/to/private/ssh-key.pem \
  --archive .data/aws/flint-RELEASE.tar.gz \
  --env-file /path/to/private/runtime.env
```

Provisioning and deployment commands mutate the configured account/host. Run them only after checking the target identity and reviewing the generated configuration. Packaging and tests are local. `provision-backups.py` verifies the account, instance profile and role before creating a private encrypted/versioned bucket and adding a scoped write-only policy.

The deploy tool checks account identity, instance state, DNS and SSH host keys before upload. It transfers private deployment configuration separately from the public release archive. The installer stores it as `/etc/flint/deployment.json` mode 0600, derives nginx/certificate names from its validated hostname, and checks the runtime origin matches. The release archive excludes private configuration files and data.

The service runs as `flint`, with root-owned releases under `/opt/flint/releases` and a `/opt/flint/current` symlink. Private SQLite and encrypted chunks live under `/var/lib/flint`; runtime secrets live under `/etc/flint/runtime.env`. These are tooling defaults. nginx binds HTTPS and forwards to loopback. The installer restarts only Flint and validates nginx before reload.

For later releases, omit `--env-file`; existing runtime secrets are preserved. The installer verifies an off-server backup before replacement activation. Existing installations adopting these scripts must first provide `/etc/flint/deployment.json`; backup tooling no longer reads configuration from a release directory. Deliberate configuration changes need a separately reviewed migration.

## Release verification and rollback

Check local and public `/api/health`, native login, a synthetic encrypted note and attachment, and publication access if used. Verify anonymous private endpoints reject requests. Do not put real notes, passwords, pairing files or infrastructure identifiers in public reports.

Failed activation restores the prior code symlink and service/vhost definitions when available; first-install failure stops the candidate service. Rollback does not reverse database migrations. Preserve data and matching configuration before selecting a prior compatible release.

## Backups

The provided daily systemd timer snapshots SQLite with Node's backup API, then copies immutable encrypted chunks and matching runtime configuration into a private checksummed archive. Each archive is restored into disposable storage for checksum, SQLite integrity, foreign-key and referenced-chunk verification before upload.

Local archives are root-only under `/var/backups/flint` with 14-day retention. The example bucket policy enables encryption, versioning, 30-day current-version retention and seven-day noncurrent retention. Review these policies for your needs. The instance backup role has write-only access; recovery uses separate operator credentials.

To verify a downloaded archive locally:

```sh
python3 scripts/aws/verify-backup.py /path/to/private/backup.tar.gz
```

Backups contain password hashes, sessions, runtime secrets and published plaintext even though private notes and attachments are encrypted. Handle the entire archive as private. Failed uploads fail the backup service and retain the local archive.

## Disaster recovery

1. Download and verify an off-server archive in private disposable storage.
2. Preserve current data and stop Flint. Keep the old SQLite DB, WAL and SHM together; never combine a restored database with stale WAL files.
3. Restore `flint.db` and its matching `chunks/` tree with directories 0700/files 0600, owned by the service user. Restore matching runtime settings as root:flint mode 0640 and supply the operator-owned deployment config separately as root-only.
4. Select a compatible release, start the service and verify login, a decrypted synthetic note, attachment bytes and publication access. Rotate active session/device credentials after an incident.
5. Re-enable the timer and verify a new off-server backup.

This is a single-server design without automatic failover. Restore tooling checks archive integrity; it does not certify capacity or every operational failure mode. Custom publication domains require separate DNS, proxy and certificate configuration.
