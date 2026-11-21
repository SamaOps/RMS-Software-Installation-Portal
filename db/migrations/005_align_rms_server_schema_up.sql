-- =============================================================================
-- RMS Software Portal — Migration 005 (UP): Align with windows-rms-server schema
-- -----------------------------------------------------------------------------
-- Safe, additive, idempotent:
--   * Adds columns introduced by windows-rms-server (0014_cheerful_magneto.sql)
--     if they don't already exist.
--   * Relaxes softwares_installer_type_chk constraint so both portal types
--     and server types ('winget', 'inno', 'msi', 'custom_exe', 'script', 'portable')
--     are accepted.
--   * Synchronizes timeout_seconds and run_as values with portal values.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

-- 1. Ensure server columns exist
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS run_as                VARCHAR(30) DEFAULT 'system';
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS elevation             VARCHAR(30) DEFAULT 'highest';
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pre_install_script    TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS post_install_script   TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS custom_install_script TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS process_name_to_wait  VARCHAR(100);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS timeout_seconds       INTEGER DEFAULT 600;

-- 2. Update installer_type constraint to accept both portal and server values
ALTER TABLE softwares DROP CONSTRAINT IF EXISTS softwares_installer_type_chk;
ALTER TABLE softwares ADD CONSTRAINT softwares_installer_type_chk
  CHECK (installer_type IS NULL OR installer_type IN (
    'InnoSetup', 'NSIS', 'MSI', 'Portable', 'Custom',
    'winget', 'inno', 'msi', 'custom_exe', 'script', 'portable'
  )) NOT VALID;

-- 3. Backfill defaults for consistency where columns were just added
UPDATE softwares 
   SET timeout_seconds = COALESCE(timeout_seconds, timeout_minutes * 60, 600)
 WHERE timeout_seconds IS NULL;

UPDATE softwares
   SET run_as = CASE WHEN execution_context = 'LOGGED_IN_USER' THEN 'user' ELSE 'system' END
 WHERE run_as IS NULL;

UPDATE softwares
   SET elevation = CASE WHEN execution_context = 'LOGGED_IN_USER' THEN 'none' ELSE 'highest' END
 WHERE elevation IS NULL;

INSERT INTO software_portal_migrations (version) VALUES ('005') ON CONFLICT DO NOTHING;

COMMIT;
