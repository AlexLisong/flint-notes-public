# Architecture

Flint has three cooperating clients: the React browser workspace, the public reader, and the local-folder companion. An Express API stores private ciphertext and separately selected public snapshots in SQLite. It never needs a vault phrase to synchronize private data.

## Data flow

1. Account login creates a server session. Browser writes carry a CSRF token; scoped device tokens authenticate the companion.
2. Unlocking a vault derives a wrapping key with PBKDF2-SHA256 and opens a versioned content-key ring on the client.
3. Note paths and bodies use authenticated encryption bound to vault, file, revision, epoch and deletion state. Separately encrypted manifests support selective transfer without first fetching excluded note bodies.
4. The browser stages ciphertext in IndexedDB; the companion uses a durable local queue. Writes include a mutation ID and expected base revision. Retries are idempotent within the replay window; stale writes preserve a conflict copy.
5. Publishing sends explicit decrypted snapshots of selected notes and referenced assets. Public routes read only that separate snapshot, with a site-password gate when configured.

## Code boundaries

- `shared/types.ts` defines the wire structures; `shared/crypto.ts` implements client encryption and key rotation.
- `server/db.ts` owns SQLite schema and storage. `server/security.ts` supplies authentication helpers. `server/app.ts` composes route authorization, quotas, file history and publication behavior.
- `src/sync.ts` serializes mutation state changes; `src/storage.ts` manages the encrypted cache/outbox; `src/Workspace.tsx` connects editor state and user operations.
- `bridge/engine.ts` scans and reconciles local files with durable retries. `bridge/secrets.ts` manages credentials; `bridge/cli.ts` exposes enrollment, one-shot sync, background operation and status.

## Invariants for contributors

Check current membership on every protected route. Device tokens cannot manage membership or publish. Viewers must remain read-only even when they forge a client request.

Bind ciphertext to its context, preserve old keys needed by history, and stop stale-epoch writes until a client re-pairs. Do not store raw vault keys in browser local storage or server configuration. Revocation prevents future access but cannot erase downloaded data.

A complete readable folder scan must precede deletion inference. Reject symlinks and traversal; preserve local edits in conflicts. Never turn unreadable/replaced folders into remote deletions. Pending mutations remain durable across selection changes and restarts.

App-shell caching must not cache API responses or published pages. Private cache rows remain vault-scoped. Public snapshots include only explicitly selected plaintext and are independently revisioned.

## Verification and scope

`tests/crypto.test.ts`, `bridge.test.ts`, `client-sync.test.ts` and server tests cover encryption context, conflicts, authorization, revisions, retries and publication isolation. `scripts/aws/test_tooling.py` exercises packaging and disposable backup restores. CI uses synthetic data; manual OS integration checks require their own fixtures.

The system is a single-server application without automatic failover, realtime coediting or a native mobile background client. See [contracts](contracts.md), [feature coverage](feature-coverage.md) and [companion behavior](bridge.md) for exact limits.
