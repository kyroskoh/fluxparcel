# ADR 0007 · Private read cursors

Persist one monotonic read sequence per membership in PostgreSQL. The server counts messages by other participants after that sequence. A history fetch leaves the cursor untouched. An acknowledged sequence can advance up to the latest committed message, and unauthorized requests reveal no conversation state.

The chat acknowledges the latest loaded sequence when its end marker is visible in the foreground tab. The conversation list refreshes after acknowledgement and every ten seconds while open. Other devices see the same cursor on refresh. Existing memberships start at zero when the migration runs, so earlier incoming history can appear unread.

The cursor is private to the account. Sender-facing delivery and read receipts, receipt preferences and unread-count load targets remain open.
