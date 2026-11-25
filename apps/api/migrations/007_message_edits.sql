ALTER TABLE conversations ADD COLUMN message_version bigint NOT NULL DEFAULT 0;
ALTER TABLE messages
    ADD COLUMN version bigint,
    ADD COLUMN body_digest bytea,
    ADD COLUMN edited_at timestamptz,
    ADD COLUMN deleted_at timestamptz;
UPDATE messages SET version=sequence, body_digest=sha256(convert_to(body, 'UTF8'));
UPDATE conversations SET message_version=next_sequence-1;
ALTER TABLE messages
    ALTER COLUMN version SET NOT NULL,
    ALTER COLUMN body_digest SET NOT NULL,
    ADD CONSTRAINT messages_deleted_body CHECK (deleted_at IS NULL OR body = '');
CREATE INDEX messages_conversation_version ON messages(conversation_id, version);
