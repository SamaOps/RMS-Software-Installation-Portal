-- =============================================================================
-- RMS Software Portal — Migration 002 (DOWN / rollback)
-- Removes ONLY what 002_up added. Run before 001_down if rolling back both.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS softwares_priority_idx;
DROP INDEX IF EXISTS softwares_installed_failed_idx;

ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_install_priority_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_success_exit_codes_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_max_retry_attempts_chk;

ALTER TABLE softwares DROP COLUMN IF EXISTS install_priority;
ALTER TABLE softwares DROP COLUMN IF EXISTS success_exit_codes;
ALTER TABLE softwares DROP COLUMN IF EXISTS max_retry_attempts;
ALTER TABLE softwares DROP COLUMN IF EXISTS min_rms_version;

DELETE FROM software_portal_migrations WHERE version = '002';

COMMIT;
