# ADR 0011 · Resumable verified attachments

A sender attaches files in a chat. The browser hashes each file with an incremental SHA-256 in a worker, reading 8 MiB slices so memory stays bounded. It then creates a transfer with the file's name, size, type and checksum. Creation is idempotent per client ID. The file is split into 8 MiB parts. Each part is sent with its own SHA-256, and the API stores only parts whose bytes match that checksum, which storage checks again. Completion assembles the recorded parts and re-hashes the stored object as a stream. Only a matching whole-file SHA-256 publishes the file as a message. Multipart ETags are never treated as checksums. A mismatch fails the transfer, removes the object and publishes nothing.

## Deviation: the API relays bytes

The PRD describes short-lived signed storage URLs. This slice sends parts and downloads through the API instead. Storage stays on the private network, and every part and download is authorized against current membership. Browser access needs no storage CORS or public endpoint. The cost is API bandwidth. Part memory is bounded by eight concurrent part slots with pooled 8 MiB buffers, and further uploads receive `503 transfers_busy` with `Retry-After`. Measured peak API memory stayed within about 80 MiB of baseline for 480 MiB and 960 MiB files. Signed URLs remain an option once storage has a public endpoint.

## Behavior

- Uploads: three files at a time per tab and two parts per file. Transient failures back off exponentially with jitter, honor `Retry-After` and stop after five attempts. Pause aborts in-flight parts and is never resumed automatically. Resume asks the server which parts it holds and sends only the missing ones. Network loss parks uploads until the browser reports it is online. The tab warns before closing during active uploads.
- Completion takes over a verification stalled for 15 minutes. Concurrent completions answer `409 transfer_verifying` with `Retry-After`. Publication locks the conversation like a text send and fails if the sender lost membership during verification.
- Downloads: `GET /v1/files/{id}/content` streams with Range support. The quoted SHA-256 is the strong ETag, so `If-Range` never mixes bytes from another object. Responses are `application/octet-stream` attachments with a sandbox content security policy. Deleting the message, losing membership or the file expiring denies access.
- Files are kept for 30 days and unfinished uploads for 7 days.

## Open release gates

- Malware scanning is not implemented. Files are published with `scan_status` `not_scanned`, and the interface says so.
- Upload jobs live in memory. Persisting them in IndexedDB and reselecting files after a reload are not implemented.
- Downloads use the browser's download manager, so the app cannot pause and resume them.
- No cleanup job yet aborts expired uploads or deletes expired, cancelled, deleted or orphaned objects. The worker has no storage access.
- Network policies (Wi-Fi only, cellular prompts), priorities, batch actions, quotas and cross-tab coordination remain open.
