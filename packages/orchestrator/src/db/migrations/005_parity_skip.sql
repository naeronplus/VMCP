-- H-12 / H-13: parity canary skip + distinct failure reasons
-- skipped=true (e.g. tier_a_unavailable) must NOT raise E010
ALTER TABLE parity_checks
  ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE parity_checks
  ADD COLUMN IF NOT EXISTS reason TEXT;
