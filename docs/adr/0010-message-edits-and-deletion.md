# ADR 0010 · Message edits and deletion

Each conversation keeps a message version counter. Every send, edit and deletion takes the next value and stores it
on the message, so a message's version shows when it last changed. Clients keep two cursors. `after` pages new
messages by sequence, as before. `changedSince` pages any message whose version is newer, ordered by version, in
pages of 100. Clients apply changes only to messages they have already loaded, because the sequence cursor always
returns current state. Existing messages take their sequence as their first version.

Only the sender can edit a message, within 24 hours of sending it. An optional `expectedVersion` rejects an edit
based on a stale copy, so one device cannot silently overwrite a newer edit from another. Resending the current text
keeps the version. The sender can delete a message at any time. In groups, owners and admins can also delete other
members' messages. A message from a deleted account can only be removed by a moderator. Deleting a message clears
its stored text and keeps a placeholder. Deleting it again succeeds without changing anything. A deleted message
cannot be edited and no longer counts as unread. Copies that recipients already saved are outside the server's
control.

Each message stores a SHA-256 digest of its original text. Idempotent resends compare that digest instead of the
current text, so an outbox retry still succeeds after the message was edited or deleted. Every change locks the
conversation row that sends already lock, so versions increase strictly. The API then publishes the existing change
notice, and open chats apply edits on their next synchronization.

Edit history, edit-window configuration and per-message delete-for-me remain open. The 24-hour limit is enforced by
the database clock and has no automated test.
