-- =============================================================================
-- RMS Software Portal — Migration 004 (UP): pilot → release rollouts
-- -----------------------------------------------------------------------------
-- Additive, idempotent, transactional.
--
-- The portal now keeps TWO sets of targets per software and derives the live RMS
-- targeting (softwares.is_global, donor_softwares, ngo_softwares) from the stage:
--
--   stage = 'pilot'    -> live targets = pilot groups only (+ pilot serials via software_test_devices)
--   stage = 'released' -> live targets = release targets + pilot groups
--   paused / deleted   -> live targets emptied (works even on RMS servers that ignore isactive)
--
-- windows-rms-server only READS these tables (models/softwareModel.js), so nothing
-- on the RMS side changes. Single-laptop pilots (serials) need the optional server
-- patch; the portal detects it through rms_server_heartbeat.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE softwares ADD COLUMN IF NOT EXISTS rollout_stage            VARCHAR(20) DEFAULT 'released';
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pilot_outcome            VARCHAR(20);           -- NULL/running | passed | failed
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pilot_required_successes INTEGER;               -- NULL = all pilot laptops
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pilot_max_failures       INTEGER;               -- NULL = PILOT_DEFAULT_MAX_FAILURES
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS auto_release             BOOLEAN DEFAULT TRUE;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS release_is_global        BOOLEAN DEFAULT FALSE;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pilot_started_at         TIMESTAMPTZ;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS pilot_decided_at         TIMESTAMPTZ;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS released_at              TIMESTAMPTZ;
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS released_by              VARCHAR(100);
-- "New version" entries: the software this one replaces (paused automatically when this one is released).
ALTER TABLE softwares ADD COLUMN IF NOT EXISTS replaces_software_id     VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_rollout_stage_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_rollout_stage_chk
      CHECK (rollout_stage IS NULL OR rollout_stage IN ('pilot', 'released')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'softwares_pilot_outcome_chk') THEN
    ALTER TABLE softwares ADD CONSTRAINT softwares_pilot_outcome_chk
      CHECK (pilot_outcome IS NULL OR pilot_outcome IN ('running', 'passed', 'failed')) NOT VALID;
  END IF;
END $$;

-- Pilot and release targets owned by the portal (donor / NGO ids kept as text so any id type works).
DO $$
DECLARE
  id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'softwares'::regclass AND a.attname = 'id' AND NOT a.attisdropped;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS software_targets (
      id          BIGSERIAL PRIMARY KEY,
      software_id %s NOT NULL REFERENCES softwares(id) ON DELETE CASCADE,
      stage       VARCHAR(10) NOT NULL CHECK (stage IN ('pilot', 'release')),
      kind        VARCHAR(10) NOT NULL CHECK (kind IN ('donor', 'ngo')),
      ref_id      VARCHAR(64) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (software_id, stage, kind, ref_id)
    )$f$, id_type);
END $$;

CREATE INDEX IF NOT EXISTS software_targets_lookup_idx ON software_targets (software_id, stage);

-- Written by the optional server patch so the portal knows what the RMS server can do.
CREATE TABLE IF NOT EXISTS rms_server_heartbeat (
  source        VARCHAR(50) PRIMARY KEY,
  version       VARCHAR(20),
  capabilities  JSONB,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill (first run only): everything that exists today is treated as already released
-- with its current targets. Guarded so a manual re-run never copies pilot groups into release.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM software_portal_migrations WHERE version = '004') THEN
    UPDATE softwares SET release_is_global = COALESCE(is_global, FALSE),
                         rollout_stage = 'released',
                         released_at = COALESCE(created_at, NOW());
    INSERT INTO software_targets (software_id, stage, kind, ref_id)
      SELECT ds.software_id, 'release', 'donor', ds.donor_id::text FROM donor_softwares ds ON CONFLICT DO NOTHING;
    INSERT INTO software_targets (software_id, stage, kind, ref_id)
      SELECT ns.software_id, 'release', 'ngo', ns.ngo_id::text FROM ngo_softwares ns ON CONFLICT DO NOTHING;
  END IF;
END $$;

INSERT INTO software_portal_migrations (version) VALUES ('004') ON CONFLICT DO NOTHING;

COMMIT;
