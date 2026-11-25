# Contributing

Bug reports, fixes and new features are welcome.

1. **Start from the PRD.** New behaviour traces to a requirement and its acceptance criteria in `PRD.md`. P0
   requirements come first; record any deviation in an architecture decision record under `docs/adr/`.
2. Open an issue for substantial changes, then create a branch named `<type>/<short-kebab-description>`, for example
   `feature/group-member-admin` or `fix/receipt-refresh`.
3. Keep authorization on every resource. Every endpoint checks the caller against current membership or role, and
   unauthorized requests reveal nothing about the resource.
4. Code rules:
   - Go: must pass `gofmt -l .` (no output), `go vet ./...` and `go test -race ./...`.
   - Web: must pass `npm run lint`, `npm run typecheck` and `npm run build`.
   - Never log secrets or file contents. Use bounded streaming, idempotency and checksum validation for transfers.
   - Keep browser capability detection explicit and never promise background transfers.
5. Add or update tests with the change:
   - API and storage: Go tests in `apps/api`. Storage behaviour also runs against real PostgreSQL and S3 through
     `compose.test.yaml` (see [README.md](README.md#verification)).
   - Browser flows: Playwright tests in `apps/web/e2e`, on both the desktop and the emulated Android profile. Cover
     network interruptions, manual pause and permission revocation where they apply.
   - Never put real private files or secrets in fixtures.
6. Document architecture decisions and browser limitations in `docs/adr/`, update `docs/progress.md`, and add an
   entry under **[Unreleased]** in `CHANGELOG.md`.
7. Commit as yourself with a short imperative subject and a wrapped body that explains what changed and why.
8. Open a pull request with a `## Changes` section of up to three bullets and a `## Verification` paragraph that
   states which checks ran and what remains untested. CI runs the same checks and the end-to-end suite.
