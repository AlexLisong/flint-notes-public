# Contributing to Flint

We welcome focused fixes, reproducible reports, documentation and accessibility improvements. Read the [Code of Conduct](CODE_OF_CONDUCT.md); report vulnerabilities through [SECURITY.md](SECURITY.md).

## Set up a development checkout

Fork and clone the repository, then create a branch for one change. Use Node 22 (`nvm use`), run `npm ci` and `npm run dev`, and open `http://127.0.0.1:5191`. Register a disposable account with the local code `flint-local-development`; choose a separate vault phrase. Keep `.data` and device pairing files out of Git.

Tests create temporary synthetic vaults. Never point test or first-sync utilities at personal notes. The companion's [setup guide](docs/bridge.md) describes pairing, exclusions and conflict behavior.

## Project map

| Area | Responsibility |
| --- | --- |
| `src/` | React editor, reader, vault UI, encrypted cache and synchronization |
| `server/` | Express routes, authentication, memberships, SQLite and public snapshots |
| `shared/` | Wire types and client encryption primitives |
| `bridge/` | Local-folder sync, durable queue, Keychain and companion CLI |
| `tests/` | Crypto, API, browser sync and real local companion integration tests |
| `scripts/aws/` | Optional packaging, deployment and backup tools |

Read [architecture](docs/architecture.md) and [contracts](docs/contracts.md) before changing encryption, file revisions or client/server interfaces. Change shared types and both clients together when needed. Never log plaintext keys, note bodies, bearer tokens or pairing files. Preserve immutable revisions, idempotent retries, conflict copies and manifest-first selective downloads.

## Contribution workflow

1. Search issues and file a minimal reproduction. For significant features or dependencies, discuss the problem, expected behavior and tradeoffs first.
2. Make a focused change using the existing TypeScript style. Explain data compatibility, migration and rollback implications where applicable.
3. Add meaningful regression coverage for changed behavior. Use disposable fixtures for cryptography, access controls and sync races.
4. Run the checks below. For UI changes, verify keyboard/focus behavior, mobile widths, error handling and save/reload using synthetic notes.
5. Open a pull request describing the problem, resulting behavior, checks actually run and remaining limits. Maintainers review scope, privacy, compatibility and tests before merging; review timing is not guaranteed.

Contributions are accepted under the project's MIT license. Retain attribution and license terms for third-party material. No separate CLA process is currently required.

## Checks

```sh
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/aws -p 'test_*.py'
```

Python tooling tests require Python 3.11+. On macOS, real Keychain and LaunchAgent behavior needs a separate disposable profile; Linux CI does not certify those OS integrations. There is no dedicated lint script yet, so typechecking, tests and review are the current code checks. Documentation-only changes need example and link review, not redundant tests.

Useful first contributions include docs corrections, focused regression fixtures, accessible controls and better error recovery. Crypto design changes, new sync protocols and schema redesigns require prior discussion and careful review.
