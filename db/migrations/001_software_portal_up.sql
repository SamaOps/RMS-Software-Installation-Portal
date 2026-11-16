-- =============================================================================
-- RMS Software Portal — Migration 001 (UP)
-- -----------------------------------------------------------------------------
-- Safe, additive, idempotent, backward-compatible:
--   * Only ADDs nullable columns / columns with defaults. Nothing is renamed,
--     dropped, or re-typed, so the existing windows-rms-server queries and the
--     deployed windows-rms clients keep working unchanged.
--   * Every statement uses IF NOT EXISTS (or an equivalent guard), so the
--     script can be re-run safely.
--   * Runs in a single transaction: all or nothing.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 001_software_portal_up.sql
-- =============================================================================

BEGIN;

-- Fail fast instead of queueing behind a long-running query on a busy table.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. softwares: new parameter columns
-- -----------------------------------------------------------------------------
-- Columns requested in the spec
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS version            VARCHAR(50);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS installer_type     VARCHAR(50);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS silent_args        TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS execution_context  VARCHAR(20) DEFAULT 'SYSTEM';
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS sha256_checksum    VARCHAR(64);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS detection_path     TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS file_url           TEXT;

-- Additional columns needed to hold the rest of the parameter set
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS description             TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS file_name               VARCHAR(255);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS storage_key             TEXT;          -- object key in S3/R2
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS file_size_bytes         BIGINT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS target_install_path     TEXT;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS create_desktop_shortcut BOOLEAN DEFAULT TRUE;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS timeout_minutes         INTEGER DEFAULT 10;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS detection_type          VARCHAR(30) DEFAULT 'exit_code_zero';
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS checksum_verified_at    TIMESTAMPTZ;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS created_by              VARCHAR(100);
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS deleted_at              TIMESTAMPTZ;   -- soft delete marker

-- Domain checks. NULL is always allowed so legacy rows stay valid.
-- Added NOT VALID so existing rows are never scanned/rejected; new writes are checked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_installer_type_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_installer_type_chk
      CHECK (installer_type IS NULL OR installer_type IN ('InnoSetup','NSIS','MSI','Portable','Custom')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_execution_context_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_execution_context_chk
      CHECK (execution_context IS NULL OR execution_context IN ('SYSTEM','LOGGED_IN_USER')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_detection_type_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_detection_type_chk
      CHECK (detection_type IS NULL OR detection_type IN ('exit_code_zero','file_exists','registry_key')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_timeout_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_timeout_chk
      CHECK (timeout_minutes IS NULL OR timeout_minutes BETWEEN 1 AND 240) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_sha256_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_sha256_chk
      CHECK (sha256_checksum IS NULL OR sha256_checksum ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS softwares_active_idx    ON softwares (isactive) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS softwares_winget_id_idx ON softwares (winget_id);

-- -----------------------------------------------------------------------------
-- 2. softwares_installed: richer telemetry (all nullable; old clients unaffected)
-- -----------------------------------------------------------------------------
ALTER TABLE softwares_installed ADD COLUMN IF NOT EXISTS error_message    TEXT;
ALTER TABLE softwares_installed ADD COLUMN IF NOT EXISTS exit_code        INTEGER;
ALTER TABLE softwares_installed ADD COLUMN IF NOT EXISTS software_version VARCHAR(50);
-- Raw PowerShell / winget transcript sent by patched clients (old clients leave it NULL)
ALTER TABLE softwares_installed ADD COLUMN IF NOT EXISTS log_output       TEXT;

CREATE INDEX IF NOT EXISTS softwares_installed_name_idx    ON softwares_installed (software_name);
CREATE INDEX IF NOT EXISTS softwares_installed_created_idx ON softwares_installed (created_at DESC);
CREATE INDEX IF NOT EXISTS softwares_installed_device_idx  ON softwares_installed (device_id);

-- Assignment lookups
CREATE INDEX IF NOT EXISTS donor_softwares_software_idx ON donor_softwares (software_id);
CREATE INDEX IF NOT EXISTS ngo_softwares_software_idx   ON ngo_softwares (software_id);

-- -----------------------------------------------------------------------------
-- 3. New tables. software_id uses whatever type softwares.id already has
--    (integer, bigint or uuid), so the foreign key always matches.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'softwares'::regclass AND a.attname = 'id' AND NOT a.attisdropped;

  -- Canary / test devices: software is offered to these serials regardless of targeting.
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS software_test_devices (
      id            BIGSERIAL PRIMARY KEY,
      software_id   %s NOT NULL REFERENCES softwares(id) ON DELETE CASCADE,
      serial_number VARCHAR(100) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (software_id, serial_number)
    )$f$, id_type);

  -- "Retry Deployment" requests: ask a device to re-attempt a software that failed.
  -- Consumed by the notInstalled query (see integration/server-patch).
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS software_retry_requests (
      id            BIGSERIAL PRIMARY KEY,
      software_id   %s NOT NULL REFERENCES softwares(id) ON DELETE CASCADE,
      serial_number VARCHAR(100) NOT NULL,
      requested_by  VARCHAR(100),
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (software_id, serial_number)
    )$f$, id_type);

  -- Admin audit trail (who changed what, when).
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS software_audit_log (
      id          BIGSERIAL PRIMARY KEY,
      software_id %s REFERENCES softwares(id) ON DELETE SET NULL,
      actor       VARCHAR(100) NOT NULL,
      action      VARCHAR(50)  NOT NULL,
      details     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )$f$, id_type);
END $$;

CREATE INDEX IF NOT EXISTS software_test_devices_serial_idx ON software_test_devices (serial_number);
CREATE INDEX IF NOT EXISTS software_audit_log_software_idx  ON software_audit_log (software_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Backfill sensible values for legacy rows (non-destructive)
-- -----------------------------------------------------------------------------
UPDATE softwares
   SET file_name = winget_id
 WHERE source = 'rms-repository' AND file_name IS NULL;

UPDATE softwares
   SET installer_type = 'Portable'
 WHERE is_portable = TRUE AND installer_type IS NULL;

-- Migration bookkeeping
CREATE TABLE IF NOT EXISTS software_portal_migrations (
  version    VARCHAR(20) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO software_portal_migrations (version) VALUES ('001') ON CONFLICT DO NOTHING;

COMMIT;
