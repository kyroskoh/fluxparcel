CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    next_sequence bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id, conversation_id);
CREATE TABLE messages (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sequence bigint NOT NULL,
    sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
    client_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, sequence),
    UNIQUE (sender_id, client_id)
);
CREATE TABLE group_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    issuer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
    used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
    revoked_at timestamptz
);
CREATE INDEX group_invitations_group ON group_invitations(conversation_id);
