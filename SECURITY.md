# Security policy

Security fixes target the latest code on the default branch. This early-stage project does not currently maintain older release branches or promise a response deadline.

## Report privately

Use GitHub's **Security → Report a vulnerability** for this repository if that option is available. If private reporting is unavailable, open an issue titled **Private security contact requested** containing only a request for a private channel. A maintainer will arrange one before you share details. Do not put exploit details, credentials, personal data or private vault/workspace files in a public issue or pull request.

Include the affected revision, a minimal synthetic reproduction, expected and actual behavior, potential impact, and any proposed fix. Share only the information needed to reproduce the issue. Allow time for coordinated investigation and a fix before public disclosure.

## Development boundaries

Use disposable accounts and synthetic data. Keep runtime environments, databases, backups, device pairings and browser session state out of Git. Test access controls at the API boundary as well as in the interface. Report accidental credential exposure privately and revoke affected credentials; deleting a file does not remove it from Git history.

Encrypted vaults still expose service metadata. The web client trusts the server-delivered JavaScript, and publishing intentionally creates plaintext snapshots. Login credentials and vault keys have different recovery and revocation behavior.

This policy is not a security certification or a claim that private vulnerability reporting has been enabled on GitHub.
