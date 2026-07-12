-- Outbox for structural merges when project_root is not local to orchestrator (H-02)
CREATE TABLE IF NOT EXISTS merge_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  override_id UUID NOT NULL REFERENCES overrides(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'failed')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_merge_outbox_pending
  ON merge_outbox(project_id, status)
  WHERE status = 'pending';

-- Optional content hash of merged file when written locally
ALTER TABLE overrides ADD COLUMN IF NOT EXISTS merged_hash TEXT;
ALTER TABLE overrides ADD COLUMN IF NOT EXISTS apply_mode TEXT
  CHECK (apply_mode IS NULL OR apply_mode IN ('local_fs', 'outbox'));
