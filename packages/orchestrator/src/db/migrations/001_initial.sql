-- PGOS schema: projects, jobs, locks, UIDs, baselines, overrides, audit, fencing ledger

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  godot_version TEXT NOT NULL DEFAULT '4.3.1',
  project_root TEXT NOT NULL,
  high_volume BOOLEAN NOT NULL DEFAULT false,
  admin_contacts TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  tier TEXT CHECK (tier IS NULL OR tier IN ('A', 'B')),
  commit_strategy TEXT NOT NULL DEFAULT 'same-machine'
    CHECK (commit_strategy IN ('same-machine', 'cross-machine')),
  godot_version TEXT NOT NULL,
  fencing_token TEXT,
  lock_key TEXT,
  github_run_id BIGINT,
  callback_token_hash TEXT,
  callback_token_expires_at TIMESTAMPTZ,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  blocked_by_job_id UUID REFERENCES jobs(id),
  depends_on_job_id UUID REFERENCES jobs(id),
  estimated_wait_seconds INTEGER,
  s3_staging_prefix TEXT,
  s3_validation_report_key TEXT,
  s3_snapshot_key TEXT,
  s3_artifacts_prefix TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  last_heartbeat_at TIMESTAMPTZ,
  error_code TEXT,
  error_detail TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat ON jobs(last_heartbeat_at)
  WHERE status NOT IN ('COMPLETED', 'ROLLBACK', 'CANCELLED', 'DEAD_LETTER', 'DEP_FAILED', 'VALIDATION_FAILED', 'REIMPORT_FAILED', 'COMMIT_FAILED');

CREATE TABLE IF NOT EXISTS job_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  class TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  artifacts_s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_errors_job ON job_errors(job_id);
CREATE INDEX IF NOT EXISTS idx_job_errors_fts ON job_errors
  USING gin (to_tsvector('english', coalesce(detail, '') || ' ' || coalesce(class, '') || ' ' || coalesce(code, '')));

-- Authoritative fencing-token ledger (§3.1)
CREATE TABLE IF NOT EXISTS lock_fencing_seq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'ACQUIRED', 'REENTRANT', 'STALE_RECOVERED', 'ADMIN_RECLAIM', 'FAILOVER'
  )),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  admin_identity TEXT
);

CREATE INDEX IF NOT EXISTS idx_lock_fencing_key_time
  ON lock_fencing_seq(lock_key, acquired_at DESC);
CREATE INDEX IF NOT EXISTS idx_lock_fencing_owner
  ON lock_fencing_seq(lock_key, owner, acquired_at DESC);

-- Soft lock bookkeeping in Postgres (Redis remains source of truth for validity)
CREATE TABLE IF NOT EXISTS pg_locks (
  lock_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  job_id UUID REFERENCES jobs(id),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_seconds INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS uid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  logical_asset_path TEXT NOT NULL,
  uid TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK (namespace IN ('GEN-', 'OVRD-', 'TMP-', 'USER-')),
  reserved_by_job_id UUID REFERENCES jobs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, logical_asset_path)
);

CREATE INDEX IF NOT EXISTS idx_uid_project_uid ON uid_mappings(project_id, uid);
CREATE INDEX IF NOT EXISTS idx_uid_reserved ON uid_mappings(reserved_by_job_id)
  WHERE reserved_by_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  patch JSONB NOT NULL,
  introduces_script BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_role TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_jti ON api_tokens(jti);

CREATE TABLE IF NOT EXISTS token_revocations (
  jti TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extension_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  godot_version_range TEXT NOT NULL DEFAULT '>=4.2, <5.0',
  network_allowed BOOLEAN NOT NULL DEFAULT false,
  approved_domains TEXT[] NOT NULL DEFAULT '{}',
  max_cpu NUMERIC NOT NULL DEFAULT 1,
  max_memory_mib INTEGER NOT NULL DEFAULT 512,
  max_disk_mib INTEGER NOT NULL DEFAULT 1024,
  timeout_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extension_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id TEXT NOT NULL,
  requested_domains TEXT[] NOT NULL,
  reason TEXT NOT NULL,
  risk_assessment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS parity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_a_checksum TEXT NOT NULL,
  tier_b_checksum TEXT NOT NULL,
  tier_a_duration_ms INTEGER NOT NULL,
  tier_b_duration_ms INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  diff_s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secret_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reference_token_hash TEXT NOT NULL UNIQUE,
  payload_encrypted TEXT NOT NULL,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  escalated_24h BOOLEAN NOT NULL DEFAULT false,
  escalated_72h BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tier_health (
  tier TEXT PRIMARY KEY CHECK (tier IN ('A', 'B')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  avg_cold_start_ms INTEGER,
  last_probe_at TIMESTAMPTZ,
  degraded BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS redis_instance_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instance_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cron_heartbeats (
  name TEXT PRIMARY KEY,
  last_beat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tier_health (tier, enabled) VALUES ('A', true), ('B', true)
ON CONFLICT DO NOTHING;

INSERT INTO redis_instance_state (id, instance_id)
VALUES (1, gen_random_uuid())
ON CONFLICT DO NOTHING;
