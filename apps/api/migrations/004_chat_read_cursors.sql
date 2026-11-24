ALTER TABLE memberships ADD COLUMN read_sequence bigint NOT NULL DEFAULT 0
    CHECK (read_sequence >= 0);
