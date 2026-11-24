# Implementation progress

Phase 1 is the roadmap’s Foundation milestone. The PRD’s P0 criteria remain MVP release gates across the later milestones.

| P0 requirement | Phase 1 implementation | Remaining release gates |
| --- | --- | --- |
| FR-01 Accounts and device sessions | Registration, login, logout, refresh rotation, email verification, display names, device listing and revocation, account deletion | Password recovery, avatars, account privacy controls, production email and abuse testing |
| FR-02, FR-03 QR and messaging | Workspace navigation and chat layout | Invitation generation, preview, redemption, group authorization and chat behavior |
| FR-04, FR-06, FR-15, FR-18 Transfers, policies and folders | Private S3 development bucket and readiness check, transfers route | Multipart and Range transfers, quotas, durable queues, storage preflight, network policy, folders and batch controls |
| FR-05 Offline delivery and synchronization | Static offline shell infrastructure | Web Push, queued drafts, durable message delivery and reconnect sync |
| FR-07 Abuse and administration | Authentication rate limits | Blocking, reporting, invitation revocation and authorized admin tools |
| FR-08 Temporary file sharing | Scheduled | Authenticated temporary file-session grants and revocation |
| FR-13, FR-21 Compression and archives | Scheduled | Original byte verification, lossless/media presets, ZIP/7z, resource limits and safe archive operations |
| FR-16, FR-22 Chat tools and universal search | Scheduled | Search, indexing, mute, archive, forwarding, attachment history and ACL tests |
| FR-19 Responsive browser UI | Authentication and workspace navigation shell, dark theme and supported route handling | Chat composer, real-device coverage, keyboard and screen-reader assessment, QR onboarding and complete settings |
| FR-20 PWA and Web Push | Manifest, icons, static service worker | Installation across reference devices, push and update lifecycle tests |

## Verification scope

The foundation suite covers the account lifecycle, session rotation and revocation, foreign-origin rejection, the chat shell at reference widths, navigation and offline caching behavior. The PR records the checks executed for this revision. The Chromium mobile profile emulates an Android device. Physical mobile devices, Safari, Firefox, load targets and the transfer- and archive-specific acceptance suites remain open. Local Compose is a development reference. Staging, production setup, backup recovery, telemetry, dependency and container release gates remain open.
