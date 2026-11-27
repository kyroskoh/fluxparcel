# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Nothing has been released yet.

## [Unreleased]

### Added
- **Network policy:** choose any network, Wi-Fi only, or asking before transfers over 100 MiB on cellular or unknown
  networks. Held transfers wait without failing and continue when the network allows. A running transfer stops,
  keeping its progress, when the device moves to a disallowed network. A single transfer can be allowed with an
  explicit confirmation.
- **Transfer priorities:** set High, Normal or Low per upload or download, and move waiting transfers up or down on the
  Transfers page. Transfers are first in, first out within a priority, and long-waiting ones are never starved.
  Uploads and downloads at a time are configurable from 1 to 5.
- **App-managed downloads:** attachments download inside the app with pause, resume and reload recovery. Bytes stream
  into the browser's private storage in 8 MiB checkpoints, resumes use `If-Range` keyed by the file's SHA-256, and
  the whole file is verified before it can be saved. Browsers without writable private storage keep their own
  download manager.
- **Configurable part sizes:** `TRANSFER_PART_SIZE` (5–64 MiB, 8 MiB by default) and an optional per-transfer
  `partSize` request. Each transfer keeps its own part size, so changing the default never disturbs uploads in
  progress, and the server raises the size when a file would exceed 10,000 parts.
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

### Fixed
- A manual pause now survives an immediate page reload: the pause intent is recorded synchronously as well as in
  IndexedDB, whose write could still be in flight.

### Security
- Administration routes answer `404` to non-administrators, and administrator rights need a verified email.
- Attachments are served as sandboxed `application/octet-stream` downloads and authorized against current membership.
