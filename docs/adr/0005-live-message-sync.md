# ADR 0005 · Live message synchronization

Open one same-origin WebSocket for the conversation currently displayed. The handshake requires an active device
session and current membership. The API rechecks both before sending a change notice and at each 15-second
heartbeat. Each API process accepts up to 256 live connections. The browser falls back to periodic reads when a
socket is unavailable.

After a message commits, the API publishes a best-effort change signal on a conversation-scoped Redis channel.
WebSocket frames carry no message content. PostgreSQL and the authenticated REST cursor remain authoritative. The
browser fetches after its last observed sequence on connection, on change notifications, and periodically to recover
missed notifications. Socket reconnects and failed reads use bounded backoff with jitter.

This slice covers new message synchronization for the open group or direct chat. A durable offline send queue,
notifications for other conversations, receipts, and the target load benchmark remain open.
