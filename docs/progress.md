# Implementation progress

Phase 1 Foundation merged in PR #1. Phase 2 Chat is underway. The PRD’s P0 criteria remain MVP release gates across the later milestones.

| P0 requirement | Implementation | Remaining release gates |
| --- | --- | --- |
| FR-01 Accounts and device sessions | Registration, login, logout, refresh rotation, email verification, display names, device listing and revocation, account deletion | Password recovery, avatars, further account privacy controls, production email and abuse testing |
| FR-02, FR-03 QR and messaging | Private group and direct text chat, group and contact QR links, contact approval, camera/gallery QR scanning, invitation review and revocation, group member listing, role changes, removal, leaving and ownership transfer, message edits and deletion | Replies, reactions and edit history |
| FR-04, FR-06, FR-15, FR-18 Transfers, policies and folders | Private S3 development bucket and readiness check, chat attachments with part and whole-file SHA-256 verification, foreground pause/resume/cancel/retry, Range downloads | Malware scanning, persisted queues across reloads, app-managed download resume, expiry cleanup, quotas, storage preflight, network policy, priorities, folders and batch controls |
| FR-05 Offline delivery and synchronization | Static offline shell, PostgreSQL message history, live WebSocket notices, cursor catch-up, polling fallback, durable offline text outbox, cross-device unread counts and opt-in reciprocal read receipts | Web Push, device delivery receipts and per-message receipt history |
| FR-07 Abuse and administration | Authentication and chat rate limits, group invitation revocation | Blocking, reporting and authorized admin tools |
| FR-08 Temporary file sharing | Scheduled | Authenticated temporary file-session grants and revocation |
| FR-13, FR-21 Compression and archives | Scheduled | Original byte verification, lossless/media presets, ZIP/7z, resource limits and safe archive operations |
| FR-16, FR-22 Chat tools and universal search | Scheduled | Search, indexing, mute, archive, forwarding, attachment history and ACL tests |
| FR-19 Responsive browser UI | Authentication and workspace navigation shell, dark theme and supported route handling | Real-device coverage, keyboard and screen-reader assessment, physical-device QR onboarding and complete settings |
| FR-20 PWA and Web Push | Manifest, icons, static service worker | Installation across reference devices, push and update lifecycle tests |

## Verification scope

The foundation suite covers the account lifecycle, session rotation and revocation, foreign-origin rejection, the chat shell at reference widths, navigation and offline caching behavior. The PR records the checks executed for this revision. The Chromium mobile profile emulates an Android device. Physical mobile devices, Safari, Firefox, load targets and the transfer- and archive-specific acceptance suites remain open. Local Compose is a development reference. Staging, production setup, backup recovery, telemetry, dependency and container release gates remain open.

The Phase 2 suite exercises private group access, authenticated QR invitation review, single-use redemption, revocation, idempotent sends and cursor synchronization. See ADR 0002 for the current chat delivery model.

The contact suite covers issuer approval, duplicate and unauthorized requests, direct-message membership and account deletion. See ADR 0003 for the approval model.

The scanner integration tests use real QR images and a synthetic camera stream. They exercise permission denial, file fallback, foreign links, camera release and explicit preview. Physical cameras and browser-specific image decoding remain unverified.

Live message coverage checks same-origin and membership enforcement, reconnect catch-up and closure after session revocation. Load targets remain unverified. See ADR 0005.

Outbox coverage checks offline reload and recovery, send order, lost responses, sender mismatches and removal of local queue data on sign-out. See ADR 0006.

Read-progress coverage checks private cross-device counts, incoming-only totals, stale cursor retries, authorization and clearing the badge after the latest message is visible. See ADR 0007.

Read-receipt coverage checks the off-by-default preference, reciprocal sharing, non-member and signed-out access, live "Sent" to "Read" updates, and switching off without changing the private cursor or unread count. It runs on the desktop and mobile Chromium profiles. The "Read by N" group label has no browser test yet. See ADR 0008.

Member-administration coverage checks owner, admin, member and non-member permissions. It also covers closing a removed member's live view, blocking rejoining after removal, revoking a demoted admin's invitations, and leaving and rejoining through the browser. See ADR 0009.

Edit and deletion coverage checks sender-only edits, moderator and sender deletion, stale and idempotent edits, outbox resends after an edit, the change cursor, and live updates in other open chats. See ADR 0010.

Ownership transfer coverage checks owner-only transfer, self and non-member targets, the browser confirmation, leaving after a transfer, and that the group survives deletion of the previous owner's account. Authentication fixtures retry the API's documented `authentication_busy` load shedding instead of failing. See ADR 0009.

Attachment coverage checks idempotent transfer creation, part checksum and length validation, completion before all parts arrive, whole-file integrity failure, cancellation, Range and If-Range downloads, and access for senders, members, non-members and deleted messages. A browser test pauses a three-part upload, confirms no parts are sent while paused, and that acknowledged parts are not resent after resuming. The recipient's bytes match the original SHA-256. Manual load checks of 480 MiB and 960 MiB files kept API memory bounded. See ADR 0011.
