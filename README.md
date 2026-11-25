# FluxParcel

**Connect. Transfer. Discover.**

[FluxParcel.xyz](https://fluxparcel.xyz)

FluxParcel is a self-hosted browser workspace for messaging and file sharing. The app supports accounts, private group and direct text chat, with QR invitations and issuer approval for new contacts. The roadmap tracks file transfers, compression and search.

## Local development

Install Docker with the Compose v2 plugin. Copy the environment template, then set three unique random values using hex characters so credentials can be safely interpolated in connection URLs.

```sh
cp .env.example .env
openssl rand -hex 24
openssl rand -hex 24
openssl rand -hex 24
docker compose up --build --wait
```

Open [FluxParcel](http://localhost:8080) and use [Mailpit](http://localhost:8025) to read local verification emails. If you change the frontend port, set `WEB_PORT` and `APP_ORIGIN` together. The web and mail interfaces bind to loopback. PostgreSQL, Redis and S3 are on the Compose network. Attachments can be up to 64 GiB; set `MAX_FILE_SIZE` in bytes to lower the limit. The worker cleans up expired and abandoned uploads every `CLEANUP_INTERVAL` (default `1m`). The stack uses development-only HTTP settings.

`docker compose stop` stops services while retaining their data. `docker compose run --rm --no-deps migrate` reruns the idempotent migration command against a running stack. When serving an HTTPS deployment, terminate TLS at a trusted edge and configure the API with the public HTTPS origin (for example, `APP_ORIGIN=https://fluxparcel.xyz`), private dependencies and a trusted SMTP relay. Leave proxy IP trust disabled unless the API is reachable exclusively through a proxy that overwrites `X-Real-IP`.

## Verification

With Node.js 24, Go 1.25 or later, and the Compose stack running:

```sh
npm ci
npm run lint
npm run typecheck
npm run build
(cd apps/api && go test -race ./... && go vet ./...)
npx playwright install chromium
npm run test:e2e
```

Tests create disposable accounts and use synthetic mail. Running the whole suite more than once a minute can exceed the per-address rate limits. For a disposable stack, start Compose with `RATE_LIMIT_SCALE=5` and `CLEANUP_INTERVAL=2s` as CI does. Leave them unset elsewhere. CI also adds `compose.test.yaml`, which publishes PostgreSQL and S3 on loopback for the storage integration test in `apps/api`; never use it for a shared or production stack. GitHub Actions runs the same foundation checks and publishes the API and web container images to GHCR on verified pushes to `main`.

- [Product requirements](PRD.md)
- [Roadmap](ROADMAP.md)
- [Implementation progress](docs/progress.md)
- [Foundation architecture](docs/adr/0001-foundation.md)
- [Private group chat architecture](docs/adr/0002-private-group-chat.md)
- [Contact approval architecture](docs/adr/0003-contact-approval.md)
- [Invitation scanning architecture](docs/adr/0004-invitation-scanning.md)
- [Live message synchronization architecture](docs/adr/0005-live-message-sync.md)
- [Offline text outbox architecture](docs/adr/0006-offline-text-outbox.md)
- [Private read cursor architecture](docs/adr/0007-private-read-cursors.md)
- [Shared read receipt architecture](docs/adr/0008-shared-read-receipts.md)
- [Group member administration](docs/adr/0009-group-member-administration.md)
- [Message edits and deletion](docs/adr/0010-message-edits-and-deletion.md)
- [Resumable verified attachments](docs/adr/0011-resumable-attachments.md)
- [Persisted uploads, large files and storage cleanup](docs/adr/0012-persisted-uploads-and-cleanup.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
