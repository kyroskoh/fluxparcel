# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Nothing has been released yet.

## [Unreleased]

### Added
- **File expiry:** senders choose how long an attachment stays available (from 1 minute up to `FILE_RETENTION`,
  30 days by default). When it expires it disappears for every member, and open chats update immediately.
- **Admin snapshots:** expired files become snapshots that only administrators can see, restore with a new expiry, or
  purge, for `SNAPSHOT_RETENTION` (30 days by default; `0` disables snapshots). Restores and purges are audited.
  Administrators are the verified accounts listed in `ADMIN_EMAILS`.
- **Storage lifecycle:** files move through `active`, `snapshot` and `purged`. A storage administration page shows usage
  per state, uploads in progress and the retention settings. The bucket gets an 8-day rule for abandoned multipart
  uploads where the store supports lifecycle rules.
- **Persisted uploads:** uploads survive reloads and crashes. Selecting the same file again resumes from the parts the
  server acknowledged; a file with a different size or SHA-256 is refused. Web Locks keep one tab per upload.
- **Storage cleanup:** the worker aborts cancelled, failed and expired uploads, removes deleted and expired files, and
  reconciles unreferenced objects and uploads from an API-kept ledger. CI runs it against real PostgreSQL and storage.
- **Resumable verified attachments:** files upload in 8 MiB parts, each checked with SHA-256, and are re-hashed as a
  whole before publication. Downloads support Range and If-Range keyed by the file's SHA-256.
- **Group ownership transfer:** owners hand a group to any member and can then leave.
- **Message edits and deletion:** senders edit for 24 hours and delete at any time; group owners and admins moderate.
- **Group member administration:** member lists, admin promotion and demotion, removal that blocks rejoining, and
  leaving.
- **Read receipts:** opt-in and reciprocal, built on private cross-device unread counts.
- **Offline outbox and live sync:** queued messages survive offline reloads; open chats sync over authorized
  WebSockets with cursor catch-up.
- **Contacts and invitations:** QR contact invitations with issuer approval, camera and gallery QR scanning, and
  expiring group invitations.
- **Foundation:** accounts, email verification, device sessions, the responsive shell, PWA basics and CI.

### Changed
- The default attachment limit is **64 GiB** (8,192 parts); `MAX_FILE_SIZE` can lower it.
- End-to-end authentication fixtures honor the API's `authentication_busy` load shedding and `Retry-After`.
- `RATE_LIMIT_SCALE` lets disposable test stacks raise per-address rate limits.

### Security
- Administration routes answer `404` to non-administrators, and administrator rights need a verified email.
- Attachments are served as sandboxed `application/octet-stream` downloads and authorized against current membership.
