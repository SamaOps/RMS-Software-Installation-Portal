-- =============================================================================
-- RMS Software Portal — Migration 004 (DOWN)
-- Restores live targeting to the release targets (so nothing in the field changes
-- unexpectedly), then drops what 004_up added. Run before 003_down.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

UPDATE softwares SET is_global = COALESCE(release_is_global, is_global) WHERE deleted_at IS NULL AND isactive IS NOT FALSE;
INSERT INTO donor_softwares (donor_id, software_id)
  SELECT t.ref_id::int, t.software_id FROM software_targets t WHERE t.stage = 'release' AND t.kind = 'donor'
  ON CONFLICT DO NOTHING;
INSERT INTO ngo_softwares (ngo_id, software_id)
  SELECT t.ref_id::int, t.software_id FROM software_targets t WHERE t.stage = 'release' AND t.kind = 'ngo'
  ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS software_targets;
DROP TABLE IF EXISTS rms_server_heartbeat;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_rollout_stage_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_pilot_outcome_chk;
ALTER TABLE softwares
  DROP COLUMN IF EXISTS rollout_stage, DROP COLUMN IF EXISTS pilot_outcome,
  DROP COLUMN IF EXISTS pilot_required_successes, DROP COLUMN IF EXISTS pilot_max_failures,
  DROP COLUMN IF EXISTS auto_release, DROP COLUMN IF EXISTS release_is_global,
  DROP COLUMN IF EXISTS pilot_started_at, DROP COLUMN IF EXISTS pilot_decided_at,
  DROP COLUMN IF EXISTS released_at, DROP COLUMN IF EXISTS released_by,
  DROP COLUMN IF EXISTS replaces_software_id;

DELETE FROM software_portal_migrations WHERE version = '004';

COMMIT;
