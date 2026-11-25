# ADR 0001 · FluxParcel foundation

Status: Accepted for the Phase 1 implementation.

## Repository and runtime

Keep the browser and server in a single repository. npm workspaces own the React, TypeScript, Vite and Tailwind
frontend. The Go module exposes a REST application and separate commands for migrations and bounded cleanup. Keep
feature code in the Go monolith until deployment or scaling requirements justify splitting it.

PostgreSQL owns account and device state. The migrator applies embedded, ordered SQL under a transaction-scoped
advisory lock and records applied filenames. Add new numbered migrations for schema changes. Redis holds expiring
authentication rate counters. The API checks the private S3 bucket in readiness. File bytes, signed URLs, scanners
and transfer ledgers belong to the transfer milestone.

## Browser boundary and sessions

A same-origin reverse proxy serves static assets and forwards API calls. Exact Origin checks guard state changes.
Production configuration requires HTTPS and sets Secure, HttpOnly, SameSite=Strict cookies. The API stores SHA-256
digests of 256-bit opaque session credentials and Argon2id password hashes with unique salts. Each device has a
distinct session row. Refresh atomically replaces both credentials on that row. Deleting the session immediately
rejects subsequent requests using either credential.

Email/password is the initial identity method. Email verification links carry a single-use token in the URL fragment
and require a button press. The API stores only the digest. Mailpit is local-only. A production installation needs a
trusted SMTP relay and deployment-specific TLS configuration. Password recovery, avatar upload, account privacy
controls, administrative MFA and credential-abuse hardening remain open release gates.

## Product sequencing and delivery

Apply the roadmap’s Foundation scope first. Chat and transfer routes render explicit availability states. Future
resource handlers must enforce authorization before returning metadata or acting on a resource. The service worker
precaches static build assets and the app shell with an allowlisted navigation fallback. Account data remains in
memory and API requests stay network-only.

Compose is the development reference. GitHub Actions validates pull requests and publishes separate API and web
images tagged with the commit SHA after successful checks on main. Deployment, infrastructure secrets, promotion and
rollback use a future environment-specific workflow. Consume images by digest when deploying.
