-- =============================================================================
-- RMS Software Portal — Migration 001 (DOWN / rollback)
-- Removes ONLY what 001_up added. Pre-existing columns and data are untouched.
-- WARNING: data stored in the new columns/tables is lost. Take a backup first:
--   pg_dump "$DATABASE_URL" -t softwares -t softwares_installed > backup.sql
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS software_audit_log;
DROP TABLE IF EXISTS software_test_devices;
DROP TABLE IF EXISTS software_retry_requests;

DROP INDEX IF EXISTS softwares_active_idx;
DROP INDEX IF EXISTS softwares_winget_id_idx;
DROP INDEX IF EXISTS softwares_installed_name_idx;
DROP INDEX IF EXISTS softwares_installed_created_idx;
DROP INDEX IF EXISTS softwares_installed_device_idx;
DROP INDEX IF EXISTS donor_softwares_software_idx;
DROP INDEX IF EXISTS ngo_softwares_software_idx;

ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_installer_type_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_execution_context_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_detection_type_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_timeout_chk;
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_sha256_chk;

ALTER TABLE softwares
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS installer_type,
  DROP COLUMN IF EXISTS silent_args,
  DROP COLUMN IF EXISTS execution_context,
  DROP COLUMN IF EXISTS sha256_checksum,
  DROP COLUMN IF EXISTS detection_path,
  DROP COLUMN IF EXISTS file_url,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS file_name,
  DROP COLUMN IF EXISTS storage_key,
  DROP COLUMN IF EXISTS file_size_bytes,
  DROP COLUMN IF EXISTS target_install_path,
  DROP COLUMN IF EXISTS create_desktop_shortcut,
  DROP COLUMN IF EXISTS timeout_minutes,
  DROP COLUMN IF EXISTS detection_type,
  DROP COLUMN IF EXISTS checksum_verified_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE softwares_installed
  DROP COLUMN IF EXISTS error_message,
  DROP COLUMN IF EXISTS exit_code,
  DROP COLUMN IF EXISTS software_version,
  DROP COLUMN IF EXISTS log_output;

DROP TABLE IF EXISTS software_portal_migrations;
COMMIT;
