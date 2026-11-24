# Agent instructions

Read PRD.md before implementation. Follow P0 requirements first; document deviations in ADRs. Use React/TypeScript/Vite and Go, PostgreSQL, Redis and S3-compatible storage. Keep browser capability detection explicit; never promise background transfers. Implement authorization on every resource and search result. Never log secrets or file contents. Use bounded streaming, durable checkpoints, idempotency and checksum validation. Test desktop and mobile browsers, network interruptions, manual pause, archive resource limits and permission revocation. Run lint, type checks, unit and integration tests before proposing changes. Do not commit credentials or claim untested features work.

## Commits and pull requests

- Name branches `<type>/<short-kebab-description>`, for example `feature/group-member-admin` or `fix/receipt-refresh`. Use `feature`, `fix`, `docs`, `chore` or `refactor` as the type. Never use generated or session IDs in branch names.
- Author and commit as Kyros Koh <me@kyroskoh.com>. Add no co-author, session or tool trailers to commit messages.
- Do not mention AI assistants or tools in code, comments, documentation, commit messages or pull requests.
- Use a short imperative commit subject and a wrapped body that explains what changed and why.
- Title a pull request with a user-facing summary. The body has a `## Changes` section with up to three bullets and a `## Verification` section with one paragraph stating which checks ran and what remains untested. Add no attribution footer.
