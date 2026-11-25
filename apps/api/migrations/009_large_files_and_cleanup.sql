-- Files can be up to 64 GiB; the API enforces the configured limit (8 GiB by default).
ALTER TABLE files DROP CONSTRAINT files_size_check,
    ADD CONSTRAINT files_size_check CHECK (size BETWEEN 1 AND 68719476736);
ALTER TABLE transfers DROP CONSTRAINT transfers_size_check,
    ADD CONSTRAINT transfers_size_check CHECK (size BETWEEN 1 AND 68719476736);

-- Cleanup removes a file's stored bytes but keeps its row, so messages can show that the file is gone.
ALTER TABLE files ADD COLUMN removed_at timestamptz;
CREATE INDEX files_pending_removal ON files(expires_at) WHERE removed_at IS NULL;
CREATE INDEX transfers_cleanup ON transfers(state, updated_at);

-- A ledger of multipart uploads the API started. Rows outlive transfers deleted with their account or
-- conversation, so cleanup can abort those uploads without relying on storage listing support.
CREATE TABLE multipart_uploads (
    upload_id text PRIMARY KEY,
    object_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX multipart_uploads_created ON multipart_uploads(created_at);
