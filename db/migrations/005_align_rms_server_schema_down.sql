-- =============================================================================
-- RMS Software Portal — Migration 005 (DOWN)
-- =============================================================================
BEGIN;
DELETE FROM software_portal_migrations WHERE version = '005';
COMMIT;
