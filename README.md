# FluxParcel

[![Foundation](https://github.com/kyroskoh/fluxparcel/actions/workflows/foundation.yml/badge.svg)](https://github.com/kyroskoh/fluxparcel/actions/workflows/foundation.yml)
[![Web](https://img.shields.io/badge/web-React%20%2B%20TypeScript-3178C6?logo=typescript&logoColor=white)](apps/web)
[![API](https://img.shields.io/badge/API-Go-00ADD8?logo=go&logoColor=white)](apps/api)
[![Storage](https://img.shields.io/badge/storage-PostgreSQL%20%7C%20Redis%20%7C%20S3-4169E1)](compose.yaml)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](compose.yaml)

**Status:** Pre-release, Phase 3 (transfers) · **Author:** [Kyros Koh](https://github.com/kyroskoh) · **Repository:** [kyroskoh/fluxparcel](https://github.com/kyroskoh/fluxparcel) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

**Connect. Transfer. Discover.** FluxParcel is a self-hosted browser workspace for **messaging** and
**large-file sharing**, built as a responsive web app and installable PWA for desktop and mobile.
Website: [fluxparcel.xyz](https://fluxparcel.xyz).

| Area | Status |
|---|---|
| Accounts, device sessions, email verification | ✅ |
| Private groups and direct chats with QR invitations | ✅ |
| Live sync, offline outbox, unread counts, read receipts | ✅ |
| Message edits and deletion, member administration | ✅ |
| Verified, resumable attachments up to 64 GiB | ✅ |
| Downloads with pause, resume and verification | ✅ |
| File expiry, admin snapshots and storage lifecycle | ✅ |
| Compression, archives and universal search | 🗓️ Planned ([ROADMAP.md](ROADMAP.md)) |

## Features

- **Private chat.** Groups with owner, admin and member roles, and direct chats that need the issuer's approval.
  Invitations are expiring QR codes or links that are previewed before anyone joins.
- **Works through bad connections.** Messages sync live over WebSockets, catch up after reconnecting, and wait in a
  durable offline outbox. Unread counts follow you across devices; read receipts are opt-in and reciprocal.
- **Edit, delete and moderate.** Senders edit for 24 hours and delete at any time; group owners and admins moderate,
  manage members and hand over ownership.
- **Large, verified attachments.** Files up to **64 GiB** move in parts (8 MiB by default, configurable). Every part and the whole file are
  checked with SHA-256 before a file is published, and downloads resume with HTTP Range requests.
- **Downloads you can pause.** Attachments download inside the app, survive reloads, resume only the missing bytes
  and are verified with SHA-256 before you save them.
- **Uploads that survive interruptions.** Pause, resume, retry and cancel. After a reload, select the same file again
  and only the missing parts are sent; a different file is refused.
- **File expiry.** Senders can choose how long a file stays available. When it expires it disappears for everyone in
  the chat.
- **Storage lifecycle and administration.** Expired files become administrator-only snapshots that can be restored
  or purged, then are purged automatically. A worker removes abandoned uploads, deleted files and orphaned objects.
- **Self-hosted and private by default.** Storage stays on the private network, every request is authorized against
  current membership, and secrets and file contents are never logged.

## Quick start

1. Install Docker with the Compose v2 plugin.
2. Create `.env` from the template and set three unique random hex values:

   ```bash
   cp .env.example .env
   openssl rand -hex 24   # POSTGRES_PASSWORD
   openssl rand -hex 24   # S3_ACCESS_KEY
   openssl rand -hex 24   # S3_SECRET_KEY
   ```

3. Start the stack:

   ```bash
   docker compose up --build --wait
   ```

4. Open [FluxParcel](http://localhost:8080) and read local verification emails in [Mailpit](http://localhost:8025).

`docker compose stop` keeps your data. `docker compose run --rm --no-deps migrate` reruns the idempotent migrations
against a running stack.

## Configuration

Set these in `.env`. The defaults suit local development.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN`, `WEB_PORT` | `http://localhost:8080`, `8080` | Public origin and local port; change them together |
| `MAX_FILE_SIZE` | `68719476736` (64 GiB) | Largest attachment, in bytes |
| `TRANSFER_PART_SIZE` | `8388608` (8 MiB) | Part size for new uploads, 5–64 MiB in whole MiB; uploads in progress keep theirs |
| `FILE_RETENTION` | `720h` | Default and longest file lifetime |
| `SNAPSHOT_RETENTION` | `720h` | How long expired files stay restorable by administrators; `0` disables snapshots |
| `ADMIN_EMAILS` | empty | Comma-separated emails whose **verified** accounts administer storage |
| `CLEANUP_INTERVAL` | `1m` | How often the worker advances the storage lifecycle |
| `RATE_LIMIT_SCALE` | `1` | Multiplies per-address rate limits; for disposable test stacks only |

The web and mail interfaces bind to loopback; PostgreSQL, Redis and S3 stay on the Compose network. The stack uses
development-only HTTP settings. For an HTTPS deployment, terminate TLS at a trusted edge, set the public HTTPS origin
(for example `APP_ORIGIN=https://fluxparcel.xyz`), use private dependencies and a trusted SMTP relay, and leave proxy
IP trust off unless the API is reachable only through a proxy that overwrites `X-Real-IP`.

## Verification

With Node.js 24, Go 1.25 or later and the Compose stack running:

```bash
npm ci
npm run lint && npm run typecheck && npm run build
(cd apps/api && go test -race ./... && go vet ./...)
npx playwright install chromium
npm run test:e2e
```

Tests create disposable accounts and use synthetic mail. For a disposable stack, start Compose as CI does, with
`RATE_LIMIT_SCALE=5`, `CLEANUP_INTERVAL=2s`, `ADMIN_EMAILS=admin-desktop@example.test,admin-mobile@example.test` and
`COMPOSE_FILE=compose.yaml:compose.test.yaml`. The test override publishes PostgreSQL and S3 on loopback for the
storage integration test in `apps/api`; never use it for a shared or production stack. GitHub Actions runs the same
checks and publishes the API and web images to GHCR on verified pushes to `main`.

## Repository layout

```
apps/api/                    Go API, worker and migrations (cmd/fluxparcel, internal/foundation, migrations)
apps/web/                    React + TypeScript web app and PWA (src) and Playwright tests (e2e)
deploy/                      API and web Dockerfiles and the nginx configuration
compose.yaml                 Local stack: PostgreSQL, Redis, S3 (RustFS), Mailpit, API, worker and web
compose.test.yaml            Test-only override that publishes PostgreSQL and S3 on loopback
docs/adr/                    Architecture decision records
docs/progress.md             Implementation progress against the PRD's P0 requirements
```

## Documentation

- [PRD.md](PRD.md): product requirements and acceptance criteria (start here before contributing)
- [ROADMAP.md](ROADMAP.md): delivery phases
- [docs/progress.md](docs/progress.md): implementation progress and open release gates
- [CHANGELOG.md](CHANGELOG.md): notable changes
- [SECURITY.md](SECURITY.md): reporting vulnerabilities and hardening advice
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
- [AGENTS.md](AGENTS.md): conventions for automated contributors
- Architecture decisions:
  - [0001 Foundation](docs/adr/0001-foundation.md)
  - [0002 Private group chat](docs/adr/0002-private-group-chat.md)
  - [0003 Contact approval](docs/adr/0003-contact-approval.md)
  - [0004 Invitation scanning](docs/adr/0004-invitation-scanning.md)
  - [0005 Live message synchronization](docs/adr/0005-live-message-sync.md)
  - [0006 Offline text outbox](docs/adr/0006-offline-text-outbox.md)
  - [0007 Private read cursors](docs/adr/0007-private-read-cursors.md)
  - [0008 Shared read receipts](docs/adr/0008-shared-read-receipts.md)
  - [0009 Group member administration](docs/adr/0009-group-member-administration.md)
  - [0010 Message edits and deletion](docs/adr/0010-message-edits-and-deletion.md)
  - [0011 Resumable verified attachments](docs/adr/0011-resumable-attachments.md)
  - [0012 Persisted uploads, large files and storage cleanup](docs/adr/0012-persisted-uploads-and-cleanup.md)
  - [0013 File expiry, snapshots and storage lifecycle](docs/adr/0013-file-expiry-and-storage-lifecycle.md)
  - [0014 Configurable part sizes](docs/adr/0014-configurable-part-sizes.md)
  - [0015 App-managed, resumable downloads](docs/adr/0015-app-managed-downloads.md)

## Support

- 🐛 Issues: [GitHub Issues](https://github.com/kyroskoh/fluxparcel/issues)
- 🔒 Security: see [SECURITY.md](SECURITY.md)

---

Made with ❤️ by [Kyros Koh](https://github.com/kyroskoh)
