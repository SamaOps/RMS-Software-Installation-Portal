-- =============================================================================
-- RMS Software Portal — Migration 002 (UP): rollout parameters
-- -----------------------------------------------------------------------------
-- Same guarantees as 001: additive only, idempotent, transactional. Old
-- windows-rms-server queries (SELECT * FROM softwares) and deployed clients
-- ignore the new columns.
--
--   install_priority    Lower installs first. Replaces the hard-coded
--                       "Google.Chrome first" sort in the legacy notInstalled.
--   success_exit_codes  Comma-separated exit codes that count as success for this
--                       package (e.g. "0,3010,1641"). NULL = server/client default.
--   max_retry_attempts  Per-software cap on automatic retries after a failure.
--                       NULL = MAX_AUTO_RETRY_ATTEMPTS from the environment.
--   min_rms_version     Only offer to clients whose devices.rms_version >= this
--                       (lets you ship params that need the patched client). NULL = all.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 002_rollout_parameters_up.sql
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE softwares ADD COLUMN IF NOT EXISTS install_priority   INTEGER DEFAULT 100;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS success_exit_codes VARCHAR(200);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS max_retry_attempts INTEGER;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS min_rms_version    VARCHAR(50);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_install_priority_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_install_priority_chk
      CHECK (install_priority IS NULL OR install_priority >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_success_exit_codes_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_success_exit_codes_chk
      CHECK (success_exit_codes IS NULL OR success_exit_codes ~ '^-?[0-9]+(,-?[0-9]+)*$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_max_retry_attempts_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_max_retry_attempts_chk
      CHECK (max_retry_attempts IS NULL OR max_retry_attempts >= 0) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS softwares_priority_idx ON softwares (install_priority, id) WHERE deleted_at IS NULL;

-- Exit-code lookups for the dashboard's "top errors" and the history filter.
CREATE INDEX IF NOT EXISTS softwares_installed_failed_idx
  ON softwares_installed (created_at DESC) WHERE issuccessful IS NOT TRUE;

INSERT INTO software_portal_migrations (version) VALUES ('002') ON CONFLICT DO NOTHING;

COMMIT;
