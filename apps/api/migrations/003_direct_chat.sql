ALTER TABLE conversations ADD COLUMN kind text NOT NULL DEFAULT 'group'
    CHECK (kind IN ('group', 'direct'));

CREATE TABLE direct_pairs (
    first_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    second_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    CHECK (first_user < second_user),
    PRIMARY KEY (first_user, second_user)
);
CREATE INDEX direct_pairs_second_user ON direct_pairs(second_user);

CREATE TABLE contact_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 20),
    used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
    revoked_at timestamptz
);
CREATE INDEX contact_invitations_issuer ON contact_invitations(issuer_id, expires_at);

CREATE TABLE contact_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitation_id uuid REFERENCES contact_invitations(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (issuer_id <> requester_id),
    UNIQUE (issuer_id, requester_id)
);
CREATE INDEX contact_requests_requester ON contact_requests(requester_id);

CREATE FUNCTION remove_direct_conversations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM conversations WHERE id IN (
        SELECT conversation_id FROM direct_pairs WHERE first_user = OLD.id OR second_user = OLD.id
    );
    RETURN OLD;
END;
$$;
CREATE TRIGGER delete_direct_conversations BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION remove_direct_conversations();
