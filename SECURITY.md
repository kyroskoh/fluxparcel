# Security

## Reporting a vulnerability

Please open a private security advisory on GitHub
(**Security → Advisories → Report a vulnerability**) rather than a public issue. Do not publish exploit details or
sensitive data in issues.

## Hardening checklist

- **Serve over HTTPS only.** Terminate TLS at a trusted edge and set `APP_ORIGIN` to the public HTTPS origin. Session
  cookies are `Secure` only on HTTPS origins, and every non-GET request must come from that origin.
- **Keep dependencies private.** PostgreSQL, Redis and S3 belong on a private network. Never deploy with
  `compose.test.yaml`, which publishes PostgreSQL and S3 for disposable test stacks.
- **Protect `.env`.** It holds the database and storage credentials. It is listed in `.gitignore`, so don't commit it,
  and use unique random values for every deployment.
- **Trust proxy addresses only behind a proxy you control.** `TRUST_PROXY=true` makes rate limits use `X-Real-IP`.
  Compose sets it because the bundled nginx overwrites that header; keep it off whenever clients can reach the API
  directly.
- **Keep production rate limits.** Leave `RATE_LIMIT_SCALE` unset outside disposable test stacks.
- **Choose administrators deliberately.** `ADMIN_EMAILS` grants storage administration to **verified** accounts with
  those addresses. Admin routes answer `404` to everyone else, and restores and purges are written to an audit table.
  Administrator MFA is not implemented yet.
- **Disclose snapshot retention.** Expired files stay restorable by administrators for `SNAPSHOT_RETENTION` (default
  30 days), and the app tells senders so. Set `SNAPSHOT_RETENTION=0` if expired files must be purged at expiry.
- **Treat attachments as untrusted.** Files are served as `application/octet-stream` attachments with a sandboxing
  Content-Security-Policy. Malware scanning is not implemented yet, and the app marks files as not scanned.
- **Know what is not end-to-end encrypted.** Messages and files are protected in transit and by access control, but the
  server can read them. Don't describe the product as end-to-end encrypted.

## Release gates

Test access revocation, archive traversal and cross-user search isolation before release, and track the remaining
gates in [docs/progress.md](docs/progress.md).
