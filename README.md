# Flint

A Markdown workspace for writing, connecting ideas, syncing a local folder, and publishing selected notes.

Flint combines a browser editor with encrypted vaults and a background companion for macOS. Your files remain Markdown; account login and vault encryption use separate passwords.

## Get started

Use **Node.js 22.13 or later in the Node 22 release line**. With nvm, run `nvm use` first.

```sh
git clone https://github.com/AlexLisong/flint-notes-public.git
cd flint-notes-public
npm ci
npm run dev
```

Open **http://127.0.0.1:5191** and choose **Create account**. For this local development server, the registration code is `flint-local-development`. Create a vault with a separate unlock phrase, then write a note. No third-party account or API key is required.

The API runs on loopback port 4317. Development data is stored in the ignored `.data/local` directory. The local registration code is public test configuration; production requires a private random bootstrap code and HTTPS. See [self-hosting](docs/aws.md).

## Features

- **Write and navigate:** Source, rendered and split Markdown views; folders, tabs, daily notes, templates, frontmatter, backlinks, graphs and search.
- **Sync:** An encrypted browser cache and durable outbox, per-file revisions, conflict copies, selective transfer and a [macOS folder companion](docs/bridge.md).
- **Recover:** Immutable file revisions, history diff, restore, Trash and portable ZIP import/export with attachments.
- **Share privately:** Vault roles, invitations, revocable device tokens and content-key rotation.
- **Publish deliberately:** Selected note snapshots and referenced assets, preview, update/unpublish, optional site passwords, search, backlinks and a responsive reader.

## Privacy model

Paths, note contents, manifests, attachments and history are encrypted on clients with AES-256-GCM. A separate vault phrase wraps versioned content keys. Account passwords are salted and hashed on the server. Account/vault names, membership, times and sizes remain service metadata.

Resetting an account password cannot recover a lost vault phrase. Keep your phrase or a trusted device. The browser trusts the host to deliver honest JavaScript; this project has automated tests, but has not had an external cryptographic audit. Revocation cannot remove copies someone has already downloaded.

Publishing explicitly uploads decrypted snapshots into separate public tables. Private edits do not update a published snapshot automatically. Published content is readable by its selected audience and is not end-to-end encrypted.

## Status and limits

Flint is an early-stage, single-server application. It preserves conflicting edits as separate files, rather than merging simultaneous character-level changes. Background sync requires an awake, connected device; mobile operating systems may suspend browser work.

Private attachments use 1 MiB encrypted chunks with a 200 MiB client limit. Large transfers have not been certified across every device. History defaults to 365 days; storage defaults to 10 GiB per vault. Canvas supports basic text cards and edges. Obsidian plugins, Bases formulas and arbitrary scripts are not executed. [Feature coverage](docs/feature-coverage.md) documents the remaining limits.

## Development and contribution

```sh
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/aws -p 'test_*.py'
```

The last command needs Python 3.11+ and tests packaging and disposable backup restores. Application tests use temporary synthetic vaults, never your personal files. The build emits browser assets, the Express server and the companion CLI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the project map, first contribution ideas and review requirements. Bugs, documentation, accessibility improvements and focused fixes are welcome. Review the [Code of Conduct](CODE_OF_CONDUCT.md) and [security policy](SECURITY.md).

- [Architecture](docs/architecture.md)
- [API and synchronization contract](docs/contracts.md)
- [Companion setup and conflict behavior](docs/bridge.md)
- [Frontend capabilities and verification](docs/frontend-status.md)
- [Self-hosting and recovery](docs/aws.md)

## License and references

Project code is available under the [MIT License](LICENSE). Dependencies retain their upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Flint is independently implemented and unaffiliated with Obsidian. Public [Sync](https://obsidian.md/sync), [Publish](https://obsidian.md/publish) and [JSON Canvas](https://jsoncanvas.org/) documentation informed its feature scope; no Obsidian account, service or proprietary code is used.
