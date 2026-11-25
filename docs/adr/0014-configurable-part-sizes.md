# ADR 0014 · Configurable, backward-compatible part sizes

## Decision

Part size is a property of each transfer, not a global constant. A new transfer gets its part size when it is
created, stores it in `transfers.part_size`, and keeps it until the transfer ends:

- The deployment default is `TRANSFER_PART_SIZE`, 8 MiB unless configured, from 5 MiB to 64 MiB in whole MiB.
- A client may request `partSize` in `POST /v1/transfers` within the same bounds. Clients that do not ask get the
  deployment default.
- The server raises the size to the next whole MiB when a file would otherwise need more than 10,000 parts, the
  multipart limit of S3-compatible storage. A 64 GiB file fits in 8 MiB parts; a 100 GiB file would get 11 MiB parts.
- `GET /v1/capabilities` reports `partSize`, `minPartSize` and `maxPartSize`.

## Backward compatibility

- **Uploads in progress are unaffected by a new default.** Part boundaries, expected lengths and completion all use
  the transfer's stored size, so raising `TRANSFER_PART_SIZE` changes only transfers created afterwards.
- **Clients follow the server.** The browser reads `partSize` from each transfer response and slices parts at that size.
  Upload records persisted before a change resume against the server's stored size after a reload. A browser test
  assigns 5 MiB parts to a transfer and checks that the upload follows them and delivers the exact bytes.
- **Older clients keep working.** The new request field is optional, and the response shape is unchanged.

## Resource bounds

The API holds a whole part in memory while it checks its SHA-256, so a byte budget replaces the fixed eight part
slots: eight default-size parts, and always room for at least two of the largest allowed size. Uploads beyond the
budget receive `503 transfers_busy` with `Retry-After`. Buffers are pooled per part size. The read deadline is two
minutes per 8 MiB of part, and nginx accepts part bodies up to 64 MiB with matching timeouts.

## Choosing a size

8 MiB stays the default because larger parts cost more on unreliable networks: an interruption discards the part in
flight, the browser holds more bytes per upload, and slow links need longer per-request deadlines. Measured uploads
of 7.5 GiB showed request overhead was not the bottleneck. Raise the default only when measurements on the
deployment's networks show it helps.
