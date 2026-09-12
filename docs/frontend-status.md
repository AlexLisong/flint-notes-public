# Browser frontend status

The browser workspace and public reader live in `src/` and `public/`. This guide records supported flows and practical limits.

## Available flows

- Account registration with server-issued code/invitation, password login, vault creation and separate phrase unlock. Private keys and phrases remain in memory. Offline cached account metadata restores CSRF for reconnect. Signout waits for local saves, attempts sync, and refuses to clear pending edits.
- Charcoal/Paper desktop and mobile workspace: note tree, folders, tabs, Cmd/Ctrl+K title/content search, Cmd/Ctrl+Shift+N create, Cmd/Ctrl+S synchronize, source CodeMirror, rendered Markdown and split view, daily notes and templates, frontmatter editor, graph, backlinks and outline.
- Markdown wikilinks and aliases, same-note headings, unique filename resolution, relative attachments, single-level note embeds, heading/block embeds, callout display, GFM tables/task lists, mathematics, and block anchors. Raw Markdown is authoritative; original unsupported text remains editable/exportable. Ambiguous or unresolved links are visibly marked.
- Per-file encrypted cache and durable encrypted outbox in IndexedDB. Cache rows/chunks are vault-scoped. Staging, acknowledgment/rebase, conflict recovery, and incoming changes use one serialized mutation queue; HTTP runs outside it. Concurrent writes preserve the latest local content as a separate conflict copy. Outbox requests retain their mutation ID until edited or rebased. Old-epoch queued changes reencrypt after unlock with the current keyring.
- Automatic on-change or configurable-minute browser synchronization and explicit pause. A browser must be running. Network restoration triggers synchronization. Status and errors are visible.
- Encrypted file revisions, on-device history diff, restore as new revision, deletion tombstones and Trash restoration.
- Attachment uploads in 1 MiB encrypted chunks; attachment download/decryption and cached encrypted chunks. ZIP import/export preserves relative folders, Markdown, Canvas, Bases and unknown files. Import preflights path collisions and refuses to overwrite existing files.
- Basic JSON Canvas editing: text cards, card drag, edge creation and removal; imported unsupported node fields remain preserved. Source mode edits the complete JSON.
- Shared-vault member list, editor/viewer invitation links and member removal; phrase is shared separately. Owner key rotation and member-removal guidance. Device pairing downloads explicit one-time credential JSON and documents the actual `npm run bridge --` commands.
- Deliberate publication: exact selected Markdown notes plus only their referenced attachments, preview using selected notes, theme, noindex, optional password, publish/update/unpublish, and public links. Owner actions are server-enforced. Public reading includes password gate, search, graph, hover title previews, backlinks and attachment references from the public metadata response.
- Service worker caches the application shell and static assets only, never API responses or published routes. Private ciphertext lives separately in IndexedDB. Remote Markdown image URLs are not automatically fetched, preventing passive image tracking. External clicked links use `noopener noreferrer`.
- Experimental WebMCP note-create tool registers only when a compatible browser API exists and returns `save-pending`, never an unverified persisted/public status.

## Verification guidance

Run `npm run typecheck`, `npm test` and `npm run build`. The client-sync suite covers encrypted manifests, immutable revisions, exclusions, acknowledgment/rebase races and retained pending edits.

For browser changes, use synthetic data to check editor/history/search/graph, offline refresh/edit/reconnect, ZIP round-trip, multi-chunk attachments, protected publication and asset isolation, Unicode links, keyboard use and mobile widths. Do not include real notes, credentials or deployment identifiers in screenshots. OS integration and deployed-server verification are separate operator checks.

## Practical limits and accuracy notes

- Browser folder/type exclusions use separately encrypted manifests to skip excluded note bodies before download. Selected bodies are fetched by immutable revision and validated against the authenticated metadata. Changing selection replays the metadata cursor; existing encrypted cache rows remain intact and hidden. Legacy records without a separate manifest require a body fetch per update to identify the path; the settings dialog discloses this fallback. Attachment bytes remain on demand. Native companion transfer exclusions are separate.
- Browser attachment uploads require a connection. Chunks upload sequentially and are immutable; interrupted uploads may leave unreferenced chunks and retry from the selected file. They are not claimed as resumable across browser restart. A full 200 MB attachment has not been browser-memory-tested here.
- Concurrency uses safe conflict copies rather than automatic three-way merging or realtime collaborative cursors.
- Canvas is a basic text-card/edge editor, not full Canvas node-type or Bases/plugin execution parity.
- Moving a note updates matching wikilinks. Folder rename via context menu preserves file paths but does not rewrite every Markdown/plugin reference; relative `../` links, duplicate heading anchors, nested embeds, frontmatter interpretation and full Obsidian plugin semantics are not complete compatibility claims.
- Public pages are client-rendered. Server-provided SEO/sitemap/canonical behavior must be assessed separately. Custom domain, backups and production capacity are deployment concerns.
- Appearance can be deliberately synchronized via encrypted `.flint/preferences.json`; interval/exclusion/pause preferences stay per-device. No hotkey customization UI or synced custom themes is implemented.
- Private search decrypts the downloaded note index in memory; it is not a worker-based incremental search implementation.
- Existing content is not automatically published. Synthetic Welcome/About/Template documents are created only by the explicit browser create-vault onboarding flow; server-created existing vaults do not seed them.
