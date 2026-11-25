CREATE TABLE files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    object_key text NOT NULL UNIQUE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    mime text NOT NULL CHECK (char_length(mime) <= 255),
    size bigint NOT NULL CHECK (size BETWEEN 1 AND 2147483648),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    scan_status text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned', 'clean', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX files_conversation ON files(conversation_id);
CREATE INDEX files_expiry ON files(expires_at);

CREATE TABLE transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    mime text NOT NULL CHECK (char_length(mime) <= 255),
    size bigint NOT NULL CHECK (size BETWEEN 1 AND 2147483648),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    part_size integer NOT NULL CHECK (part_size >= 5242880),
    object_key text NOT NULL UNIQUE,
    upload_id text NOT NULL,
    state text NOT NULL DEFAULT 'uploading'
        CHECK (state IN ('uploading', 'verifying', 'completed', 'cancelled', 'failed')),
    file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    message_sequence bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE (sender_id, client_id)
);
CREATE INDEX transfers_expiry ON transfers(state, expires_at);

CREATE TABLE transfer_parts (
    transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    size integer NOT NULL CHECK (size > 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    etag text NOT NULL,
    PRIMARY KEY (transfer_id, part_number)
);

ALTER TABLE messages ADD COLUMN file_id uuid REFERENCES files(id) ON DELETE SET NULL;
CREATE INDEX messages_file ON messages(file_id) WHERE file_id IS NOT NULL;
