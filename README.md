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

Open [FluxParcel](http://localhost:8080) and use [Mailpit](http://localhost:8025) to read local verification emails. If you change the frontend port, set `WEB_PORT` and `APP_ORIGIN` together. The web and mail interfaces bind to loopback. PostgreSQL, Redis and S3 are on the Compose network. The stack uses development-only HTTP settings.

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

Tests create disposable accounts and use synthetic mail. GitHub Actions runs the same foundation checks and publishes the API and web container images to GHCR on verified pushes to `main`.

- [Product requirements](PRD.md)
- [Roadmap](ROADMAP.md)
- [Implementation progress](docs/progress.md)
- [Foundation architecture](docs/adr/0001-foundation.md)
- [Private group chat architecture](docs/adr/0002-private-group-chat.md)
- [Contact approval architecture](docs/adr/0003-contact-approval.md)
- [Invitation scanning architecture](docs/adr/0004-invitation-scanning.md)
- [Live message synchronization architecture](docs/adr/0005-live-message-sync.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
