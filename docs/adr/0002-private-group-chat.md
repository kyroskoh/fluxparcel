# ADR 0002 · Private group chat

PostgreSQL stores messages, memberships and invitations. A conversation row lock serializes sequence allocation and member-count checks. A unique sender and client-message ID prevents duplicate sends. The authenticated history query checks membership in the same statement that selects a page.

Group invite links place opaque tokens in a URL fragment. The browser removes it and retains it in memory through the sign-in flow. The server verifies email before issuance and stores only a token hash. Inspection is read-only. Redemption validates and consumes a use under a row lock. Repeated acceptance by an existing member is idempotent. Revocation blocks future enrollment and preserves existing memberships. Group history is visible after joining. Deleting the owner account removes that owner's groups. Messages by deleted non-owners retain their content without account attribution.

The first chat slice uses two-second cursor polling with bounded jitter and exponential reconnect backoff. It keeps the composer and retry ID in memory. WebSocket delivery, durable offline outbox, member administration, direct chats, contact invitations, camera/gallery scanning, message mutation, receipts and group unread counts remain open.
