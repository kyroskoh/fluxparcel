# ADR 0013 · File expiry, admin snapshots and storage lifecycle

## Lifecycle

Every published file is in one of three states, kept in `files.lifecycle`:

| State | Who can see it | Bytes | Leaves the state when |
|---|---|---|---|
| `active` | Conversation members, until `expires_at` | Stored | It expires (to `snapshot`) or its message is deleted (to `purged`) |
| `snapshot` | Administrators only | Stored | An administrator restores it (to `active`), purges it, or `snapshot_expires_at` passes (to `purged`) |
| `purged` | Nobody; messages say the file expired | Deleted (`removed_at`) | Never |

Transfers have their own short lifecycle (ADR 0011 and 0012): `uploading` and `verifying` end as `completed`,
`failed` or `cancelled`, and the worker deletes all but recently completed transfer records.

## Expiry

A sender may set `expiresInSeconds` when creating a transfer, from one minute up to `FILE_RETENTION` (30 days by
default, which is also the lifetime when none is chosen). The file's `expires_at` starts when it is published.

Availability ends at `expires_at` for everyone: downloads require `active` and an unexpired file, and messages
report the file as unavailable, so the sender and every recipient lose it at the same moment. On its next pass the
worker moves the file to `snapshot` and gives the file's message a new version. Open chats pick up the change
through the change cursor, and the worker's Redis notice makes that immediate. Copies already downloaded to a device
are outside the service's control, as the PRD states for deletion.

## Snapshots and administration

Administrators are the verified accounts whose email is listed in `ADMIN_EMAILS`. This is a deliberately small model
for self-hosted deployments: it needs no extra tables, and an email that is not yet verified grants nothing.
Administration routes answer `404` to everyone else.

A snapshot keeps the file's bytes under the same object key for `SNAPSHOT_RETENTION` (30 days by default). Snapshots
are a state change, not a copy, so even 64 GiB files snapshot instantly; a deployment can map the state to a colder
storage class later. `SNAPSHOT_RETENTION=0` disables snapshots, so files are purged on the pass that expires them.
Because administrators can restore expired files, the upload form tells senders how long that is possible.

- `GET /v1/admin/storage` reports file counts and bytes per state, uploads in progress, and the retention settings.
- `GET /v1/admin/snapshots` lists snapshots with name, size, conversation, sender and both timestamps.
- `POST /v1/admin/snapshots/{id}/restore` makes a snapshot available again with a new expiry (7 days by default, at
  most `FILE_RETENTION`), touches its message and notifies open chats. A file whose message was deleted cannot be
  restored.
- `DELETE /v1/admin/snapshots/{id}` purges a snapshot early.

Restores and purges are written to `admin_audit` with the administrator, action, file and time.

Purging, by the worker or by an administrator, first claims the row as `purged` and only then deletes the bytes. A
restore therefore cannot revive a file whose bytes are being removed. If deleting bytes fails, reconciliation
removes the unreferenced object later. Files whose message is deleted are purged without a snapshot, because the
sender asked for removal.

## Storage-level backstop

Storage setup adds a bucket lifecycle rule that aborts multipart uploads under `files/` 8 days after they start. The
worker's 7-day transfer expiry stays authoritative; the rule only catches uploads the application lost track of. The
bundled RustFS stores the rule, but its enforcement has not been verified, and setup only logs a warning on stores
that refuse lifecycle rules.

## Still open

Administrator MFA and a viewable audit log, per-conversation retention policies, and storage classes for snapshots
remain open.
