# Automatic Obsidian folder synchronization

The Flint companion connects a local Markdown folder to an encrypted Flint vault. It runs independently of Obsidian and your browser. The Mac must be awake, online, and able to unlock its login Keychain. After sleep or a disconnected period, the next cycle catches up. The companion never publishes notes.

## One-time setup on macOS

Use Node 22 (`nvm use` in the repository), install dependencies with `npm ci`, and build with `npm run build`. In Flint, unlock your vault and create a device pairing file from the device/sync settings. The downloaded JSON contains a vault-scoped device token and the encryption keyring. Transfer it only to the intended device.

```sh
node dist-bridge/cli.js pair \
  --pairing-file "$HOME/Downloads/flint-pairing.json" \
  --folder "$HOME/Documents/Flint Vault" \
  --remove-pairing-file

node dist-bridge/cli.js once
node dist-bridge/cli.js status
node dist-bridge/cli.js install --mode change --interval 5
```

`pair` creates the folder if necessary, verifies the server credential and encryption keys, and stores credentials in macOS Keychain. It does not import, delete, or write notes. `once` performs the first merge. An existing local note that differs from a remote note of the same name is kept in a visible conflict copy. An initially empty local folder downloads remote notes; it does not delete them.

The installation starts a user LaunchAgent immediately and at subsequent logins. It uses the exact Node executable and built companion path from installation, so keep that Node installation and repository in place. Rebuild/reinstall if those paths change. Review the initial merge before pointing Obsidian at the folder. Use one sync service for each folder; disable an existing Obsidian Sync, Dropbox, or other vault synchronization before handing the same folder to this companion.

## Scheduling and multiple vaults

`--mode change` uploads local changes after a short debounce and checks remote changes every N minutes. `--mode interval --interval 5` checks both directions every five minutes. Both perform an immediate startup cycle. Failed network operations retry with increasing delays up to five minutes. Timers are targets while the Mac can run, rather than guarantees during sleep.

```sh
node dist-bridge/cli.js run --mode interval --interval 5
node dist-bridge/cli.js install --mode interval --interval 15
node dist-bridge/cli.js uninstall
```

`run` stays in the foreground until interrupted. `uninstall` removes only the LaunchAgent; it keeps local notes, sync history and Keychain credentials. Revoke a lost device in Flint's device settings. Use `--profile work` consistently with `pair`, `once`, `status`, `install` and `uninstall` for additional vaults. Overlapping folders cannot be enrolled into multiple companion profiles.

State is stored outside the vault in `~/Library/Application Support/Flint/bridge/<profile>/`. It contains file paths, hashes, revisions, the durable encrypted outbox and staged encrypted attachment chunks. It does not contain note plaintext or vault keys. Mac credentials are stored under the `flint-notes-bridge` Keychain service. The startup service is `~/Library/LaunchAgents/app.flint.bridge.<profile>.plist`. Its log is `<state directory>/bridge.log`; filenames in sync/conflict messages are visible to your local user.

`status` shows the last completed cycle, pending writes and the last error. After changing the schedule with `install`, those command-line values control the service; the paired schedule remains its fallback. To change that fallback and filters, pair again using the same profile/folder with the desired options.

## Selective files and Obsidian settings

Pairing accepts comma-separated excluded paths and file extensions. Omit `--types` to include all supported ordinary files.

```sh
node dist-bridge/cli.js pair \
  --pairing-file "$HOME/Downloads/flint-pairing.json" \
  --folder "$HOME/Documents/Flint Vault" \
  --exclude "Private,Archive" \
  --types "md,canvas,base,png,jpg,pdf" \
  --obsidian-settings \
  --remove-pairing-file
```

Each current file write has a separate encrypted manifest containing its path and optional attachment type/size. The companion downloads these small manifests first, then requests the exact immutable body revision only for included files. Excluded current-format note bodies and attachment chunks are not downloaded. A legacy record without a manifest requires its encrypted body once to determine its path. Changing an exclusion never requests remote deletion. Already downloaded excluded files remain on disk. Pending mutations created before a selection change remain durable and are completed rather than discarded.

By default all hidden files/directories, including `.env*`, `.git`, `.DS_Store` and `.obsidian`, are excluded. `--obsidian-settings` permits top-level `.obsidian/*.json`, snippet CSS, and plugin `data.json` files as opaque data. It does not run or install plugins. Editor swap/temporary files are also ignored. A symlink in the included tree stops the cycle before uploading or downloading any file rather than following it outside the selected folder.

## Integrity and conflict behavior

- Every write has an immutable mutation ID and expected file revision. A request committed just before a disconnection is safely retried after restart.
- Local edits are durably queued before network requests. The queue and attachment staging survive process restarts. A later local edit becomes a further revision.
- Concurrent content edits produce visible `(... conflict ...)` copies. A remote deletion of a locally edited note preserves the local content in a conflict copy. These copies also sync to other devices.
- Unique unchanged-content local renames retain their file ID and history. Ambiguous renames, or simultaneous rename plus content changes, may become a deletion and a new file; both contents remain recoverable through history. The companion does not rewrite Markdown links when Obsidian has not already done so.
- A complete readable folder scan must finish before any remote/local file mutation, and another scan precedes local missing-file deletion inference. A missing, moved, unreadable or symlinked vault root fails the cycle. The enrolled folder's device/inode identity is persisted; replacing it with a different empty directory at the same path stops synchronization instead of requesting deletions. Create a new profile to review a fresh merge after a deliberate migration.
- Remote paths are validated and parent symlinks rejected. Remote writes use a synced temporary file and atomic rename, checking again for local edits before replacement. As with other folder synchronizers, external programs must not deliberately race filesystem path changes during a write.

## Key rotation and recovery

If the owner rotates encryption, stale writes stop with an explicit re-pair message. Unlock the new vault epoch in the web app, download a new device pairing file, and repeat `pair` for the same profile/folder. Restart `run`, or rerun `install` for its LaunchAgent. Pending notes and staged attachment chunks are reencrypted under the new epoch. Historical keys in the new keyring preserve access to old file revisions.

A lost login password and a lost vault passphrase are different problems. A trusted unlocked client or an existing authorized device keyring is required if the unlock passphrase is lost. Retain your passphrase/recovery material in your password manager. The service cannot decrypt your private notes or manufacture their keys. Revocation cannot remove files or keys a collaborator previously downloaded.

## Capacity and other platforms

Binary attachments use 1 MiB authenticated encrypted chunks. The companion accepts files up to 200 MiB but currently reads a complete local file into memory; peak memory use and maximum-size transfers have not been certified on every client. The automated cross-device fixture exercises an attachment larger than one chunk. UTF-8 Markdown preserves original line endings and byte-order marks. Non-UTF8 text and large text files round-trip as binary attachments.

For Linux/testing, `--allow-file-secrets` explicitly stores the device credential and keyring in a mode-0600 `pairing-secret.json`. This is plaintext credential storage, unlike macOS Keychain; enable it only where appropriate. `FLINT_BRIDGE_HOME` selects another state parent directory. Linux users can run the companion through their service manager. No exact background schedule is promised for iOS/Android; a native mobile plugin is a separate client.

Automated tests use temporary vaults and a real local Express/SQLite API. They cover crypto authentication/context binding, first pairing, conflict preservation, local/web rename/delete, exclusions, unreadable/replaced folders, durable retries/restart, binary chunks, stale epochs, re-pairing, traversal/symlinks, UTF-8 BOM and credential-file permissions. A synthetic macOS Keychain write/read was separately verified and its temporary item deleted. Production enrollment and LaunchAgent scheduling require their own live verification and are not claimed by the automated tests.
