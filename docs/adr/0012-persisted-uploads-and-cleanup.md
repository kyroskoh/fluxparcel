# ADR 0012 · Persisted uploads, large files and storage cleanup

## Large files

Attachments can be up to 64 GiB by default. Deployments can lower the limit with `MAX_FILE_SIZE` in bytes, down to 1 MiB. The PRD's 2 GiB default is raised because the parts design keeps every stage bounded:

- Parts stay at 8 MiB, so a 64 GiB file has 8,192 parts, within storage's 10,000-part limit.
- `GET /v1/capabilities` reports `maxFileSize` and `partSize`, so the browser rejects an oversized file before hashing it.
- Downloads use a rolling two-minute idle deadline instead of a fixed total duration.

A manual end-to-end check sent a 7.5 GiB file: 960 parts uploaded in 42 seconds, the server re-hashed it in 14 seconds, and it downloaded in 22 seconds with a matching SHA-256. API memory peaked about 60 MiB above its starting level.

## Persisted uploads

The browser keeps one IndexedDB record per upload, scoped to the account. A record holds the conversation, name, size, type, last-modified time, whole-file SHA-256, server transfer ID, pause intent and last error. It never holds file bytes or signed URLs: browsers copy a stored `File` into origin storage, which multi-gigabyte files would exhaust.

After a reload or crash, each record is reconciled with `GET /v1/transfers/{id}`:

- Completed transfers are forgotten.
- Cancelled, failed, expired and missing transfers become failed jobs with an explanation.
- Paused jobs stay paused.
- Other jobs ask the user to select the file again. A file of a different size is refused immediately. Otherwise the browser re-hashes it and resumes only if the SHA-256 matches the record, then sends only the parts the server lacks.
- If the server already holds every part, completion runs without reselection.

Sign-out deletes the records; the server keeps the transfer until cleanup.

Each running upload holds a Web Lock named after its client ID, so only one tab sends it. Other tabs show it as uploading in another tab and refresh through a BroadcastChannel. The server's idempotent client IDs and part reconciliation still protect against duplicates where Web Locks are unavailable.

## Cleanup

The worker now has storage access. Every `CLEANUP_INTERVAL` (default one minute) it:

- aborts the multipart uploads of cancelled, failed and expired transfers, removes any partial object, and deletes the transfer;
- deletes completed transfer records after seven days;
- removes the bytes of expired files and of files whose message was deleted. The file row is kept with `removed_at`, so the message can say the file is no longer available.

Every sixty passes it reconciles storage. It removes `files/` objects older than a day that no file or transfer refers to, such as files left behind when an account or conversation is deleted. It also aborts multipart uploads in the `multipart_uploads` ledger that no transfer refers to. The API records every multipart upload it starts in that ledger, because not every S3-compatible store lists incomplete uploads; the bundled RustFS release returns none. Each pass handles bounded batches.

A Go integration test runs the cleanup against PostgreSQL and storage in CI through `compose.test.yaml`, which publishes those services on loopback for the disposable stack only. End-to-end tests run with a two-second interval and check that a cancelled upload's transfer disappears.

## Still open

Bytes of files deleted with an account or conversation remain until the next reconciliation, up to about a day later. File System Access handles, which could avoid reselection in some browsers, are not used. Network policies, priorities, batch actions, quotas, malware scanning and app-managed download resume remain open.
