# ADR 0008 · Shared read receipts

Read sharing is an account preference stored as `users.share_read_receipts`. It is off by default, including for
existing accounts. `PATCH /v1/account` accepts it alongside or instead of the display name. Omitted fields keep
their stored values, so a change on one device does not overwrite another device's edit.

`GET /v1/conversations/{id}/receipts` returns the requester's sharing state and the read cursors of other members
who share theirs. Sharing is reciprocal: an account that does not share sees no receipts. One statement checks
membership and both preferences on the same snapshot. Non-members and unknown conversations get the standard
not-found response. The response lists at most 200 readers, highest cursor first.

Receipts reuse the private read cursor from ADR 0007 instead of storing per-message rows. The preference only
controls who can see the cursor. Switching it off hides receipts on the next refresh and leaves the cursor and
unread counts unchanged. Switching it back on reveals the current cursor, including reads made while sharing was
off. This deviates from the PRD's per-message `Receipt` entity. Per-message rows and delivered-to-device state stay
open until device acknowledgements exist.

When an account that shares receipts advances its cursor, the API publishes the existing conversation change notice.
Open chats refresh receipts after each successful message synchronization. A preference change does not notify other
members; they see it on their next synchronization, within about fifteen seconds while connected. A direct chat
labels the sender's messages "Sent" or "Read", and a group shows "Read by N". Neither label appears while the viewer
is not sharing.

The integration suite now creates and deletes more disposable accounts per minute than the production per-address
limits allow. `RATE_LIMIT_SCALE` (1–20, default 1) multiplies every per-address limit. CI sets it to 5 for the
disposable stack only.
