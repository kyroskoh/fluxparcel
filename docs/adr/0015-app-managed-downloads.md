# ADR 0015 · App-managed, resumable downloads

## Decision

Browsers that support synchronous file handles in the origin private file system (OPFS) download attachments
inside the app. Capability detection is explicit: the app checks `navigator.storage.getDirectory` and `Worker`,
then a download worker confirms `FileSystemFileHandle.prototype.createSyncAccessHandle` before the first download
button appears. Other browsers keep the browser download manager, and the app says it cannot pause those downloads.

A dedicated worker owns the file because a synchronous access handle writes in place. An earlier design that
reopened `createWritable({ keepExistingData: true })` for each segment made Chromium copy the whole partial file on
every checkpoint, so work grew quadratically and storage doubled; a 1 GiB download stalled at about 430 MiB.

## Behavior

- **Bounded memory, durable checkpoints.** The worker streams the response into
  `fluxparcel-downloads/<account>/<file>.part` in OPFS and flushes every 8 MiB. A pause or reload
  keeps every byte written, and a crash loses at most the unflushed segment; the final checksum catches anything
  damaged. A 1 GiB download keeps the page's JavaScript heap
  under 10 MiB. A reader that receives nothing for 30 seconds is aborted and retried.
- **Resume never mixes versions.** A resumed request sends `Range: bytes=N-` and `If-Range` with the file's quoted
  SHA-256, which the API uses as its strong ETag. Only a `206` whose `Content-Range` starts at `N` and reports the
  expected total is appended. A `200`, or any other range, means the server's copy changed: the download stops and
  offers a restart that discards the partial bytes. A fresh download checks the ETag the same way.
- **Verified before saving.** After the last byte, the download worker re-reads the file in 8 MiB chunks and compares its SHA-256 with
  the attachment's. A mismatch deletes the partial copy. Only a verified file can be saved; saving hands the browser
  an object URL backed by the OPFS file, not a copy in memory.
- **Sticky pause and recovery.** Records in IndexedDB keep each download's identity and pause intent, with the pause
  also written synchronously to `localStorage`. After a reload, paused downloads stay paused and others continue from
  the committed bytes without reselecting anything. Network loss parks downloads until the browser is online, and
  transient failures back off exponentially with jitter, honor `Retry-After`, and stop after five attempts.
- **Device-local.** Pause, cancel and removal affect only this device's copy, never the published file. One Web Lock
  per file keeps a download to one tab; other tabs show it as downloading elsewhere.
- **Access changes.** A `404` or `403` while resuming means the message was deleted, membership was revoked or the file
  expired. The download fails and its partial copy is deleted.
- **Storage.** The app requests persistent storage and checks `navigator.storage.estimate()` before fetching missing
  bytes. A quota failure keeps the committed bytes so the user can free space and resume. Sign-out deletes this
  account's records and every byte kept for it in OPFS. Private windows may keep OPFS in memory with far less space
  than the estimate reports; Chromium's in-memory profiles fail near 1 GiB, which surfaces as the same storage
  message, and the attachment's browser download link still works.

## Coverage

Browser tests throttle the connection with the Chrome DevTools Protocol to pause mid-download, reload, and resume.
They check that no request is sent while paused, that the resume carries `Range` and `If-Range` and receives `206`,
and that the saved file matches the original SHA-256. They also cover a changed file answered with `200` (stop, then
restart), corrupted bytes (discarded), deleted access (partial copy removed) and the fallback without writable OPFS.

## Still open

Safari exposes writable OPFS files only in recent releases, and real-device runs on Safari and Firefox are pending.
Saving very large files relies on the browser's handling of object URLs. Verification hashes in JavaScript at
roughly 25 MiB/s, so a 64 GiB file takes about 40 minutes to verify. Bandwidth caps, download priorities and
batch actions remain open.
