-- =============================================================================
-- RMS Software Portal — Migration 003 (UP): install scripts for deployed clients
-- -----------------------------------------------------------------------------
-- Additive, idempotent, transactional.
--
-- The RMS 1.4.0 client runs any software whose winget_id is an https://…/*.ps1 URL
-- as an elevated script. The portal generates one such script per software
-- (see backend/src/lib/wrapperScript.js) and records it here; winget_id then holds
-- the script URL while file_name keeps the real installer name.
--
-- software_install_reports stores the detailed result each script posts back
-- (exit code, error, transcript), because the 1.4.0 client only reports true/false.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE softwares ADD COLUMN IF NOT EXISTS client_script_key          TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS client_script_url          TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS client_script_sha256       VARCHAR(64);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS client_script_generated_at TIMESTAMPTZ;

-- Keep the real installer name for legacy uploaded rows before winget_id is repointed.
UPDATE softwares SET file_name = winget_id
 WHERE source IN ('rms-repository', 'external_url') AND file_name IS NULL AND winget_id !~* '^https?://';

DO $$
DECLARE
  id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'softwares'::regclass AND a.attname = 'id' AND NOT a.attisdropped;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS software_install_reports (
      id               BIGSERIAL PRIMARY KEY,
      software_id      %s REFERENCES softwares(id) ON DELETE SET NULL,
      software_name    VARCHAR(255) NOT NULL,
      serial_number    VARCHAR(100) NOT NULL,
      device_id        INTEGER,
      is_successful    BOOLEAN,
      exit_code        INTEGER,
      error_message    TEXT,
      log_output       TEXT,
      software_version VARCHAR(50),
      wrapper_version  VARCHAR(20),
      remote_ip        VARCHAR(64),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )$f$, id_type);
END $$;

CREATE INDEX IF NOT EXISTS software_install_reports_match_idx
  ON software_install_reports (device_id, software_name, created_at DESC);
CREATE INDEX IF NOT EXISTS software_install_reports_created_idx
  ON software_install_reports (created_at DESC);

INSERT INTO software_portal_migrations (version) VALUES ('003') ON CONFLICT DO NOTHING;

COMMIT;
