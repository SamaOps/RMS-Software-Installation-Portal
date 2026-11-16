-- =============================================================================
-- RMS Software Portal — Migration 003 (DOWN)
-- Before running: point winget_id back at the installer file for wrapped rows, e.g.
--   UPDATE softwares SET winget_id = file_name WHERE client_script_url IS NOT NULL AND file_name IS NOT NULL;
-- (done below) so deployed clients fall back to their built-in behaviour.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

UPDATE softwares SET winget_id = file_name
 WHERE client_script_url IS NOT NULL AND winget_id = client_script_url AND file_name IS NOT NULL;

DROP TABLE IF EXISTS software_install_reports;
ALTER TABLE softwares DROP COLUMN IF EXISTS client_script_key;
ALTER TABLE softwares DROP COLUMN IF EXISTS client_script_url;
ALTER TABLE softwares DROP COLUMN IF EXISTS client_script_sha256;
ALTER TABLE softwares DROP COLUMN IF EXISTS client_script_generated_at;

DELETE FROM software_portal_migrations WHERE version = '003';

COMMIT;
