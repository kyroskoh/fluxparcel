-- Files move through an explicit lifecycle:
--   active   - members can download the file until it expires
--   snapshot - expired for every member; bytes are kept only for administrator restoration
--   purged   - bytes are deleted; the row remains so messages can show that the file is gone
ALTER TABLE files
    ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'snapshot', 'purged')),
    ADD COLUMN expired_at timestamptz,
    ADD COLUMN snapshot_expires_at timestamptz,
    ADD COLUMN restored_at timestamptz,
    ADD CONSTRAINT files_snapshot_expiry CHECK (lifecycle <> 'snapshot' OR snapshot_expires_at IS NOT NULL);
UPDATE files SET lifecycle = 'purged' WHERE removed_at IS NOT NULL;
CREATE INDEX files_lifecycle ON files(lifecycle, expires_at);
CREATE INDEX files_snapshot_expiry_idx ON files(snapshot_expires_at) WHERE lifecycle = 'snapshot';

-- The sender may choose a shorter lifetime than the deployment's default retention.
ALTER TABLE transfers ADD COLUMN lifetime_seconds bigint CHECK (lifetime_seconds > 0);

-- Administrative changes to file availability are recorded.
CREATE TABLE admin_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (action IN ('snapshot.restore', 'snapshot.purge')),
    file_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created ON admin_audit(created_at);
