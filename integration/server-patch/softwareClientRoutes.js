/**
 * Drop-in replacement for the two CLIENT-facing endpoints of navgurukul/windows-rms-server:
 *
 *   GET  /api/softwares/notInstalled?serial_number=<serial>[&caps=v2]
 *   POST /api/softwares/addHistory
 *
 * CommonJS, like windows-rms-server. Mount it BEFORE the existing software routes so it
 * wins, and AFTER `app.use('/api', verifyApiKey)` so HMAC auth still applies:
 *
 *   const { createSoftwareClientRouter } = require('./routes/softwareClientRoutes');
 *   const { pool } = require('./config/database');
 *   app.use('/api/softwares', createSoftwareClientRouter({ pool }));   // before softwareRoutes
 *   app.use('/api/softwares', softwareRoutes);                          // getAll/assignments/history keep working
 *
 * 100% backward compatible with deployed clients:
 *   - Unknown serial -> [] (same as legacy). Response items keep the legacy fields
 *     (software_name, winget_id, source, isPortable) and only ADD new ones.
 *   - Old clients don't send `caps=v2`, so they never receive `external_url` items.
 *   - addHistory accepts { serial_number, software_name, isSuccessful } exactly like
 *     before and returns the inserted row (or null for an unknown device, like legacy),
 *     plus optional error_message / exit_code / log_output / software_version.
 *
 * Works with portal install scripts (migration 003): for uploaded/URL software winget_id holds
 * https://…/softwares/rms-install-*.ps1, which the deployed 1.4.0 client downloads and runs.
 *
 * Adds: soft delete, canary devices, admin Retry, bounded auto-retry (per software),
 * install priority (replaces the hard-coded Google.Chrome-first sort), min client version.
 *
 * Every table/column name and limit is configurable through the same env vars the portal
 * uses (DEVICES_TABLE, DEVICES_SERIAL_COLUMN, ... MAX_AUTO_RETRY_ATTEMPTS, ...), or via options.
 * Requires migrations 001 + 002 from rms-software-portal/db/migrations.
 */
'use strict';

const express = require('express');

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(value, name) {
  if (value === '' || value === null || value === undefined) return null;
  if (!IDENT.test(value)) throw new Error(`[softwareClientRoutes] ${name} must be a plain SQL identifier, got "${value}"`);
  return `"${value}"`;
}

const num = (v, d) => (v === undefined || v === '' || v === null || Number.isNaN(Number(v)) ? d : Number(v));
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function resolveOptions(opts) {
  const env = opts.env || process.env;
  const pick = (key, envKey, d) => (opts[key] !== undefined ? opts[key] : env[envKey] !== undefined ? env[envKey] : d);
  return {
    devicesTable: ident(pick('devicesTable', 'DEVICES_TABLE', 'devices'), 'DEVICES_TABLE'),
    serialCol: ident(pick('serialColumn', 'DEVICES_SERIAL_COLUMN', 'serial_number'), 'DEVICES_SERIAL_COLUMN'),
    donorFk: ident(pick('donorFkColumn', 'DEVICES_DONOR_FK_COLUMN', 'donor_id'), 'DEVICES_DONOR_FK_COLUMN'),
    ngoFk: ident(pick('ngoFkColumn', 'DEVICES_NGO_FK_COLUMN', 'ngo_id'), 'DEVICES_NGO_FK_COLUMN'),
    versionCol: ident(pick('rmsVersionColumn', 'DEVICES_RMS_VERSION_COLUMN', 'rms_version'), 'DEVICES_RMS_VERSION_COLUMN'),
    maxAutoAttempts: num(pick('maxAutoAttempts', 'MAX_AUTO_RETRY_ATTEMPTS'), 3),
    defaultPriority: num(pick('defaultPriority', 'INSTALL_PRIORITY_DEFAULT'), 100),
    defaultTimeout: num(pick('defaultTimeoutMinutes', 'TIMEOUT_DEFAULT_MINUTES'), 10),
    // Legacy tie-breaker: winget IDs listed here install first among equal priorities
    // (set PRIORITY_WINGET_IDS=Google.Chrome to keep the old behaviour exactly).
    priorityWingetIds: Array.isArray(opts.priorityWingetIds) ? opts.priorityWingetIds : csv(env.PRIORITY_WINGET_IDS),
    defaultSuccessExitCodes: (Array.isArray(opts.defaultSuccessExitCodes)
      ? opts.defaultSuccessExitCodes
      : csv(env.DEFAULT_SUCCESS_EXIT_CODES || '0,3010,1641')
    ).map(Number),
    publicBaseUrl: String(pick('publicBaseUrl', 'PUBLIC_DOWNLOAD_BASE_URL', '')).replace(/\/+$/, ''),
    maxLogBytes: num(pick('maxLogBytes', 'MAX_LOG_BYTES'), 256 * 1024),
    maxErrorChars: num(pick('maxErrorChars', 'MAX_ERROR_CHARS'), 2000),
    jsonLimit: pick('jsonLimit', 'ADD_HISTORY_JSON_LIMIT', '1mb'),
    logger: opts.logger || console,
  };
}

function createSoftwareClientRouter(opts = {}) {
  const { pool } = opts;
  if (!pool) throw new Error('[softwareClientRoutes] { pool } is required');
  const o = resolveOptions(opts);
  const router = express.Router();

  const deviceSql = `SELECT id,
      ${o.donorFk ? o.donorFk : 'NULL'} AS donor_id,
      ${o.ngoFk ? o.ngoFk : 'NULL'} AS ngo_id,
      ${o.versionCol ? `${o.versionCol}::text` : 'NULL'} AS rms_version
    FROM ${o.devicesTable} WHERE ${o.serialCol} = $1 LIMIT 1`;

  // $1 device id, $2 serial, $3 donor id, $4 ngo id, $5 supportsV2, $6 default max attempts,
  // $7 device rms_version, $8 default priority, $9 priority winget ids
  const pendingSql = `
    WITH hist AS (
      SELECT si.software_name,
             COUNT(*) FILTER (WHERE si.issuccessful IS NOT TRUE)                       AS failures,
             (ARRAY_AGG(si.issuccessful ORDER BY si.created_at DESC, si.id DESC))[1]  AS last_ok,
             BOOL_OR(si.issuccessful IS TRUE)                                          AS ever_ok,
             MAX(si.created_at)                                                        AS last_at
      FROM softwares_installed si
      WHERE si.device_id = $1
      GROUP BY si.software_name
    )
    SELECT s.*
    FROM softwares s
    LEFT JOIN hist h ON h.software_name = s.software_name
    LEFT JOIN software_retry_requests rr ON rr.software_id = s.id AND rr.serial_number = $2
    WHERE s.isactive IS NOT FALSE
      AND s.deleted_at IS NULL
      -- Old clients can't run raw external URLs, but they CAN run a portal install script (winget_id = …/*.ps1)
      AND ($5::boolean OR s.source IS DISTINCT FROM 'external_url' OR s.winget_id ~* '^https?://.+[.]ps1$')
      -- targeting -----------------------------------------------------------
      AND (
            s.is_global = TRUE
         OR EXISTS (SELECT 1 FROM donor_softwares ds WHERE ds.software_id = s.id AND ds.donor_id = $3)
         OR EXISTS (SELECT 1 FROM ngo_softwares   ns WHERE ns.software_id = s.id AND ns.ngo_id   = $4)
         OR EXISTS (SELECT 1 FROM software_test_devices td WHERE td.software_id = s.id AND td.serial_number = $2)
      )
      -- minimum client version ------------------------------------------------
      AND (
            s.min_rms_version IS NULL
         OR ($7::text ~ '^[0-9]+(\\.[0-9]+)*$'
             AND string_to_array($7::text, '.')::int[] >= string_to_array(s.min_rms_version, '.')::int[])
      )
      -- install state ---------------------------------------------------------
      AND (
            h.software_name IS NULL                                            -- never attempted
         OR (h.last_ok IS NOT TRUE AND (
                (h.ever_ok IS NOT TRUE AND h.failures < COALESCE(s.max_retry_attempts, $6))  -- bounded auto-retry
             OR rr.requested_at > h.last_at                                                  -- admin clicked "Retry"
            ))
      )
    ORDER BY COALESCE(s.install_priority, $8),
             array_position($9::text[], s.winget_id::text) NULLS LAST,
             s.created_at NULLS LAST, s.id`;

  const downloadUrl = (s) => {
    if (s.source === 'external_url') return s.file_url;
    // winget_id may hold the generated install-script URL; file_name is the real installer.
    if (s.source === 'rms-repository' && o.publicBaseUrl) return `${o.publicBaseUrl}/${encodeURIComponent(s.file_name || s.winget_id)}`;
    return null;
  };

  router.get('/notInstalled', async (req, res) => {
    const serial = String(req.query.serial_number || '').trim();
    if (!serial) return res.status(400).json({ error: 'serial_number is required' });
    const caps = String(req.query.caps || req.get('x-rms-client-caps') || '');
    const supportsV2 = caps.split(',').map((c) => c.trim()).includes('v2');

    try {
      const dev = (await pool.query(deviceSql, [serial])).rows[0];
      if (!dev) return res.json([]); // legacy behaviour for unregistered laptops

      const { rows } = await pool.query(pendingSql, [
        dev.id,
        serial,
        dev.donor_id,
        dev.ngo_id,
        supportsV2,
        o.maxAutoAttempts,
        dev.rms_version,
        o.defaultPriority,
        o.priorityWingetIds,
      ]);

      res.json(
        rows.map((s) => ({
          // ---- legacy fields (unchanged names/meaning) ----
          id: s.id,
          software_name: s.software_name,
          winget_id: s.winget_id,
          source: s.source,
          isPortable: !!s.is_portable,
          is_global: !!s.is_global,
          isactive: s.isactive !== false,
          // ---- additive fields (ignored by old clients) ----
          version: s.version,
          installer_type: s.installer_type,
          silent_args: s.silent_args,
          execution_context: s.execution_context || 'SYSTEM',
          target_install_path: s.target_install_path,
          create_desktop_shortcut: s.create_desktop_shortcut !== false,
          timeout_minutes: s.timeout_minutes || o.defaultTimeout,
          sha256_checksum: s.sha256_checksum,
          file_size_bytes: s.file_size_bytes != null ? Number(s.file_size_bytes) : null,
          download_url: downloadUrl(s),
          // NOTE: no `file_url` here on purpose. The 1.4.0 client checks file_url BEFORE winget_id when
          // looking for a script, so sending the raw installer URL would hide the install script.
          client_script_url: s.client_script_url || null,
          detection_type: s.detection_type || 'exit_code_zero',
          detection_path: s.detection_path,
          success_exit_codes: s.success_exit_codes ? s.success_exit_codes.split(',').map(Number) : o.defaultSuccessExitCodes,
          install_priority: s.install_priority ?? o.defaultPriority,
        })),
      );
    } catch (err) {
      o.logger.error('[notInstalled]', err);
      res.status(500).json({ error: 'Failed to fetch not installed softwares' });
    }
  });

  router.post('/addHistory', express.json({ limit: o.jsonLimit }), async (req, res) => {
    const b = req.body || {};
    const serial = String(b.serial_number || '').trim();
    const name = String(b.software_name || '').trim();
    if (!serial || !name) return res.status(400).json({ error: 'serial_number and software_name are required' });

    // Legacy clients send a boolean; tolerate "true"/"false" strings too.
    const ok = b.isSuccessful === true || b.isSuccessful === 'true' ? true : b.isSuccessful === false || b.isSuccessful === 'false' ? false : null;
    const log = typeof b.log_output === 'string' && b.log_output ? b.log_output.slice(-o.maxLogBytes) : null; // keep the tail
    const err = typeof b.error_message === 'string' && b.error_message ? b.error_message.slice(0, o.maxErrorChars) : null;
    const exit = Number.isInteger(b.exit_code) ? b.exit_code : null;
    const ver = typeof b.software_version === 'string' && b.software_version ? b.software_version.slice(0, 50) : null;

    try {
      const r = await pool.query(
        `INSERT INTO softwares_installed (device_id, software_name, issuccessful, error_message, exit_code, log_output, software_version)
         SELECT d.id, $2, $3, $4, $5, $6, $7 FROM ${o.devicesTable} d WHERE d.${o.serialCol} = $1
         RETURNING id, device_id, software_name, issuccessful, created_at`,
        [serial, name, ok, err, exit, log, ver],
      );
      if (!r.rowCount) {
        o.logger.error('Device not found for serial number:', serial);
        return res.json(null); // legacy behaviour
      }
      // A recorded attempt consumes any pending admin retry for this device/software.
      if (ok) {
        await pool
          .query(
            `DELETE FROM software_retry_requests rr USING softwares s
             WHERE rr.software_id = s.id AND s.software_name = $1 AND rr.serial_number = $2`,
            [name, serial],
          )
          .catch(() => {});
      }
      res.json(r.rows[0]);
    } catch (e) {
      o.logger.error('[addHistory]', e);
      res.status(500).json({ error: 'Failed to add history' });
    }
  });

  return router;
}

module.exports = { createSoftwareClientRouter, resolveOptions };
