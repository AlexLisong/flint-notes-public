# Feature coverage

Flint independently implements the main Sync and Publish workflows. It does not use Obsidian's service or proprietary code, and does not claim full Obsidian compatibility.

| Capability | Current implementation |
| --- | --- |
| Browser notes | Markdown editor, source/read/split modes, folders, tabs, search, daily notes, templates, frontmatter, links, backlinks and graphs |
| Automatic sync | Mac LaunchAgent watches a connected folder and reconciles periodically; browser uses an encrypted durable outbox and configurable schedule |
| Encryption | Client AES-256-GCM for paths, contents, manifests, attachments and history; separate vault phrase wraps versioned content keys |
| Access control | Password login, private registration code/invitations, secure session cookies, CSRF checks, per-vault roles, scoped revocable device tokens |
| Selective sync | Encrypted manifest listing filters folders/types before downloading note bodies; attachments download on demand. Legacy records without manifests require one body fetch to discover their path |
| Offline | Cached app shell and encrypted downloaded files; edits survive refresh and upload on reconnect |
| History and Trash | Immutable revisions, browser diff/restore, deletion recovery; default 365-day history, configurable 30–3650 days |
| Storage | Default 10 GiB per vault; private attachments chunked at 1 MiB with 200 MiB client limit. Capacity is constrained by the actual host |
| Shared vaults | Owner/editor/viewer memberships, invitations, revocation and content-key rotation. Vault phrase is shared separately; previously downloaded copies cannot be revoked |
| Settings | Optional encrypted Flint appearance sync; scheduling/exclusions stay per device. Companion can opt into selected Obsidian settings files |
| Publish | Explicit selected-note snapshots, preview, update/unpublish, selected referenced assets, light/dark reader, search, graph, backlinks and mobile layout |
| Protected publishing | Optional separate site password; API/assets share the same gate; protected pages excluded from sitemaps |
| SEO and domain | Server title/description/canonical metadata and sitemap; deployment-configured HTTPS origin. Per-site domains require operator-managed DNS/proxy/certificate configuration |
| Ownership and backups | Markdown/attachment/Canvas ZIP import/export, local original files, optional private server backups, checksum/integrity restore tooling |

## Limits

- Conflicts preserve separate copies; there is no realtime coediting or automatic three-way merge.
- Mac automatic sync requires an awake, connected Mac and its user Keychain. Mobile browsers work, but a native mobile Obsidian sync plugin is not included.
- Canvas supports basic text cards and edges. Bases formulas, Dataview, Templater and community plugins are not executed. Unknown formats remain files.
- Browser attachment upload is not restart-resumable. Large attachment mobile-memory testing remains outstanding.
- Custom hotkeys/themes, stacked-page browsing and full Obsidian link/plugin semantics are not complete.
- This is a single-server service, without automatic failover or an external security audit. The browser trusts the server to deliver its client code.
- Obsidian supporter badges, beta access, priority support and commercial sponsorship benefits belong to Obsidian and are not app features Flint supplies.

See [frontend verification](frontend-status.md), [companion behavior](bridge.md) and [self-hosting guide](aws.md) for implementation and operational details.
