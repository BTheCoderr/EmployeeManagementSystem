# Security Policy

Security fixes target the current default branch.

Report vulnerabilities privately through GitHub rather than opening a public issue when they could expose employee records, credentials, sessions, compensation data, backup contents, or privileged operations.

Extra review is expected for authentication/session handling, Admin/Manager/Viewer RBAC, compensation-field access, CSRF/CSP/throttling, optimistic concurrency, migrations, and backup/restore behavior.

Never commit production credentials, real employee data, or generated local database files.
