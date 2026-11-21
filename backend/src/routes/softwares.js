import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { softwareInput, SERIAL_RE, hasPilotTargets, fieldError } from '../lib/validation.js';
import { schema, q, targetNamesSql, targetedDevicesSql } from '../lib/schema.js';
import {
  evaluateGate, pilotSummarySql, pilotStatus, serverCapabilities, saveTargets, syncLiveTargets,
  startPilot, releaseNow, checkPilot, replaceTestDevices,
} from '../lib/rollout.js';
import { SOURCE_TYPES } from '../lib/installerDefaults.js';
import { limits, wrapper, rollout as R } from '../settings.js';
import { publishClientScript, buildForRow } from '../lib/clientScripts.js';
import { needsWrapper } from '../lib/wrapperScript.js';
import { headObject, keyFor, sha256OfObject, publicUrlFor } from '../storage/index.js';

const r = Router();
const t = config.tables;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Stats are per DEVICE using each device's latest attempt, so a laptop that
 * failed twice then succeeded counts as 1 success, not 2 failures + 1 success.
 * Note: legacy softwares_installed links to software by NAME (no software_id).
 */
const SELECT_SOFTWARE = (caps) => `
  WITH latest AS (
    SELECT DISTINCT ON (software_name, device_id) software_name, device_id, issuccessful
    FROM softwares_installed
    ORDER BY software_name, device_id, created_at DESC, id DESC
  ), agg AS (
    SELECT software_name,
           COUNT(*)                                   AS devices_attempted,
           COUNT(*) FILTER (WHERE issuccessful)       AS devices_succeeded,
           COUNT(*) FILTER (WHERE issuccessful IS NOT TRUE) AS devices_failed
    FROM latest GROUP BY software_name
  ), attempts AS (
    SELECT software_name, COUNT(*) AS total_attempts, MAX(created_at) AS last_attempt_at
    FROM softwares_installed GROUP BY software_name
  )
  SELECT s.*,
         COALESCE(agg.devices_attempted, 0) AS devices_attempted,
         COALESCE(agg.devices_succeeded, 0) AS devices_succeeded,
         COALESCE(agg.devices_failed, 0)    AS devices_failed,
         COALESCE(attempts.total_attempts, 0) AS total_attempts,
         attempts.last_attempt_at,
         ${targetNamesSql('donor', 'release')} AS assigned_donors,
         ${targetNamesSql('ngo', 'release')}   AS assigned_ngos,
         ${targetNamesSql('donor', 'pilot')}   AS pilot_donors,
         ${targetNamesSql('ngo', 'pilot')}     AS pilot_ngos,
         ${pilotSummarySql(!!caps?.device_targeting)} AS pilot_summary,
         ${targetedDevicesSql()} AS devices_targeted,
         (SELECT COALESCE(json_agg(td.serial_number ORDER BY td.serial_number), '[]'::json)
            FROM software_test_devices td WHERE td.software_id = s.id) AS test_device_serials
  FROM softwares s
  LEFT JOIN agg      ON agg.software_name = s.software_name
  LEFT JOIN attempts ON attempts.software_name = s.software_name
  WHERE s.deleted_at IS NULL`;

function toApi(row) {
  const fileName = row.file_name || (row.source === 'rms-repository' ? row.winget_id : null);
  const wrapped = !!row.client_script_url && row.winget_id === row.client_script_url;
  let silentArgs = row.silent_args;
  if (typeof silentArgs === 'object' && silentArgs !== null) {
    silentArgs = silentArgs.args !== undefined ? silentArgs.args : (Object.keys(silentArgs).length === 0 ? '' : JSON.stringify(silentArgs));
  }
  return {
    id: row.id,
    software_name: row.software_name,
    version: row.version,
    description: row.description,
    is_active: row.isactive !== false,
    source_type: row.source,
    winget_id: row.winget_id,
    // How deployed RMS clients receive it: 'install_script' = portal-generated .ps1 (works on client 1.4.0)
    delivery: row.source === 'winget' ? 'winget' : wrapped ? 'install_script' : 'direct',
    client_script_url: row.client_script_url ?? null,
    client_script_generated_at: row.client_script_generated_at ?? null,
    file_name: fileName,
    storage_key: row.storage_key,
    file_url: row.file_url,
    download_url: row.source === 'rms-repository' ? publicUrlFor(fileName) : row.file_url,
    file_size_bytes: row.file_size_bytes,
    sha256_checksum: row.sha256_checksum,
    checksum_verified_at: row.checksum_verified_at,
    installer_type: row.installer_type,
    silent_args: silentArgs,
    execution_context: row.execution_context || (row.run_as === 'user' ? 'LOGGED_IN_USER' : 'SYSTEM'),
    run_as: row.run_as || (row.execution_context === 'LOGGED_IN_USER' ? 'user' : 'system'),
    elevation: row.elevation || (row.execution_context === 'LOGGED_IN_USER' ? 'none' : 'highest'),
    pre_install_script: row.pre_install_script ?? null,
    post_install_script: row.post_install_script ?? null,
    custom_install_script: row.custom_install_script ?? null,
    process_name_to_wait: row.process_name_to_wait ?? null,
    timeout_seconds: row.timeout_seconds ?? (row.timeout_minutes ? row.timeout_minutes * 60 : 600),
    is_portable: !!row.is_portable,
    target_install_path: row.target_install_path,
    create_desktop_shortcut: row.create_desktop_shortcut !== false,
    timeout_minutes: row.timeout_minutes ?? (row.timeout_seconds ? Math.ceil(row.timeout_seconds / 60) : limits.timeoutDefaultMinutes),
    success_exit_codes: row.success_exit_codes,
    install_priority: row.install_priority ?? limits.installPriorityDefault,
    max_retry_attempts: row.max_retry_attempts,
    effective_max_retry_attempts: row.max_retry_attempts ?? limits.maxAutoRetryAttempts,
    min_rms_version: row.min_rms_version,
    // Release targets (where it goes after the pilot). `live_is_global` is what RMS reads right now.
    is_global: !!row.release_is_global,
    live_is_global: !!row.is_global,
    detection_type: row.detection_type || 'exit_code_zero',
    detection_path: row.detection_path,
    assigned_donors: row.assigned_donors ?? [],
    assigned_ngos: row.assigned_ngos ?? [],
    test_device_serials: row.test_device_serials ?? [],
    pilot_ngos: row.pilot_ngos ?? [],
    pilot_donors: row.pilot_donors ?? [],
    pilot_required_successes: row.pilot_required_successes,
    pilot_max_failures: row.pilot_max_failures,
    auto_release: row.auto_release !== false,
    replaces_software_id: row.replaces_software_id ?? null,
    rollout: {
      stage: row.rollout_stage || 'released',
      pilot_outcome: row.pilot_outcome,
      pilot_started_at: row.pilot_started_at,
      released_at: row.released_at,
      released_by: row.released_by,
      gate: evaluateGate(row, row.pilot_summary ?? { total: 0, succeeded: 0, failed: 0 }),
    },
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: {
      devices_targeted: row.devices_targeted ?? null,
      devices_pending:
        row.devices_targeted != null ? Math.max(0, Number(row.devices_targeted) - Number(row.devices_succeeded ?? 0) - Number(row.devices_failed ?? 0)) : null,
      devices_attempted: row.devices_attempted ?? 0,
      devices_succeeded: row.devices_succeeded ?? 0,
      devices_failed: row.devices_failed ?? 0,
      total_attempts: row.total_attempts ?? 0,
      last_attempt_at: row.last_attempt_at ?? null,
      success_rate: row.devices_attempted ? +((row.devices_succeeded / row.devices_attempted) * 100).toFixed(1) : null,
    },
  };
}

async function loadOne(id, db = { query }) {
  const caps = await serverCapabilities(db);
  const res = await db.query(`${SELECT_SOFTWARE(caps)} AND s.id::text = $1`, [String(id)]);
  if (!res.rowCount) throw new HttpError(404, 'Software not found');
  return toApi(res.rows[0]);
}

const audit = (db, softwareId, actor, action, details) =>
  db.query(`INSERT INTO software_audit_log (software_id, actor, action, details) VALUES ($1, $2, $3, $4)`, [
    softwareId,
    actor,
    action,
    details ? JSON.stringify(details) : null,
  ]);

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function assertIdsExist(db, table, ids, label) {
  if (!ids.length) return;
  const res = await db.query(`SELECT id::text AS id FROM ${q(table)} WHERE id::text = ANY($1::text[])`, [ids]);
  const found = new Set(res.rows.map((x) => x.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) throw new HttpError(400, `Unknown ${label} id(s): ${missing.join(', ')}`);
}

async function validateAgainstDb(db, d, existingId = null) {
  const excludeSelf = existingId ? `AND id::text <> $2` : '';
  const p = (v) => (existingId ? [v, String(existingId)] : [v]);

  // Name must be unique: legacy install history is keyed by software_name.
  const dupName = await db.query(
    `SELECT id FROM softwares WHERE deleted_at IS NULL AND lower(software_name) = lower($1) ${excludeSelf}`,
    p(d.software_name),
  );
  if (dupName.rowCount) throw new HttpError(409, `A software named "${d.software_name}" already exists`);

  // A downloadable file name may only back one live software (it maps 1:1 to /softwares/<file>).
  if (d.source_type !== 'winget') {
    const dupFile = await db.query(
      `SELECT software_name FROM softwares WHERE deleted_at IS NULL AND source <> 'winget'
         AND COALESCE(file_name, winget_id) = $1 ${excludeSelf}`,
      p(d.file_name),
    );
    if (dupFile.rowCount)
      throw new HttpError(409, `File "${d.file_name}" is already used by "${dupFile.rows[0].software_name}"`);
  }

  if (d.source_type === 'rms-repository') {
    if (d.storage_key !== keyFor(d.file_name)) throw new HttpError(400, 'storage_key does not match file_name');
    const obj = await headObject(d.storage_key);
    if (!obj) throw new HttpError(400, 'Uploaded file not found in storage. Please upload again.');
    if (Number(obj.size) !== Number(d.file_size_bytes))
      throw new HttpError(400, `Stored file is ${obj.size} bytes but ${d.file_size_bytes} was expected. Upload again.`);
  }

  if (schema.donors) await assertIdsExist(db, t.donors, [...d.assigned_donors, ...d.pilot_donors], 'donor');
  if (schema.ngos) await assertIdsExist(db, t.ngos, [...d.assigned_ngos, ...d.pilot_ngos], 'NGO');

  if (d.replaces_software_id) {
    if (existingId && String(existingId) === d.replaces_software_id) throw new HttpError(400, 'A software cannot replace itself');
    const prev = await db.query(`SELECT 1 FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`, [d.replaces_software_id]);
    if (!prev.rowCount) throw new HttpError(400, 'The version being replaced was not found');
  }

  // Serial-only pilots need an RMS server that can target single laptops (server patch).
  if (!d.release_now && d.test_device_serials.length && !d.pilot_ngos.length && !d.pilot_donors.length) {
    const caps = await serverCapabilities(db);
    if (!caps.device_targeting)
      throw new HttpError(
        400,
        'Your RMS server cannot target single laptops yet, so pilot serials alone would never receive it. ' +
          'Add a pilot NGO or donor group (e.g. a lab NGO with your test laptops), or deploy the optional server patch.',
        { field: 'test_device_serials' },
      );
  }
}

function getSoftwareColumns() {
  const cols = [
    'software_name', 'version', 'description', 'isactive', 'source', 'winget_id', 'file_name', 'storage_key',
    'file_url', 'file_size_bytes', 'sha256_checksum', 'installer_type', 'silent_args', 'execution_context',
    'is_portable', 'target_install_path', 'create_desktop_shortcut', 'timeout_minutes',
    'detection_type', 'detection_path', 'success_exit_codes', 'install_priority', 'max_retry_attempts', 'min_rms_version',
    'pilot_required_successes', 'pilot_max_failures', 'auto_release', 'replaces_software_id',
  ];
  if (schema.hasRunAs) cols.push('run_as', 'elevation');
  if (schema.hasScripts) cols.push('pre_install_script', 'post_install_script', 'custom_install_script', 'process_name_to_wait');
  if (schema.hasTimeoutSeconds) cols.push('timeout_seconds');
  return cols;
}

function getSoftwareValues(d, cols) {
  let silentArgsVal = d.silent_args;
  if (schema.isSilentArgsJsonb) {
    silentArgsVal = JSON.stringify(typeof d.silent_args === 'object' && d.silent_args !== null ? d.silent_args : { args: d.silent_args || '' });
  }
  const mapping = {
    software_name: d.software_name,
    version: d.version,
    description: d.description,
    isactive: d.is_active,
    source: d.source_type,
    winget_id: d.winget_id,
    file_name: d.file_name,
    storage_key: d.storage_key,
    file_url: d.file_url,
    file_size_bytes: d.file_size_bytes,
    sha256_checksum: d.sha256_checksum,
    installer_type: d.installer_type ?? null,
    silent_args: silentArgsVal,
    execution_context: d.execution_context,
    is_portable: d.is_portable,
    target_install_path: d.target_install_path,
    create_desktop_shortcut: d.create_desktop_shortcut,
    timeout_minutes: d.timeout_minutes,
    detection_type: d.detection_type,
    detection_path: d.detection_path,
    success_exit_codes: d.success_exit_codes,
    install_priority: d.install_priority,
    max_retry_attempts: d.max_retry_attempts,
    min_rms_version: d.min_rms_version,
    pilot_required_successes: d.pilot_required_successes,
    pilot_max_failures: d.pilot_max_failures,
    auto_release: d.auto_release,
    replaces_software_id: d.replaces_software_id,
    run_as: d.run_as ?? (d.execution_context === 'LOGGED_IN_USER' ? 'user' : 'system'),
    elevation: d.elevation ?? (d.execution_context === 'LOGGED_IN_USER' ? 'none' : 'highest'),
    pre_install_script: d.pre_install_script ?? null,
    post_install_script: d.post_install_script ?? null,
    custom_install_script: d.custom_install_script ?? null,
    process_name_to_wait: d.process_name_to_wait ?? null,
    timeout_seconds: d.timeout_seconds ?? (d.timeout_minutes * 60),
  };
  return cols.map((c) => mapping[c]);
}

// Fields whose change means laptops would run something different -> re-test on the pilot first.
const INSTALL_FIELDS = [
  'source', 'file_name', 'file_url', 'sha256_checksum', 'installer_type', 'silent_args', 'execution_context',
  'target_install_path', 'detection_type', 'detection_path', 'success_exit_codes', 'timeout_minutes',
  'pre_install_script', 'post_install_script', 'custom_install_script', 'process_name_to_wait',
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/admin/softwares?search=&source=&target=&status= */
r.get(
  '/',
  ah(async (req, res) => {
    const f = z
      .object({
        search: z.string().trim().max(200).optional(),
        source: z.enum(SOURCE_TYPES).optional(),
        sort: z.enum(['newest', 'priority', 'name', 'failures']).default('newest'),
        target: z.enum(['global', 'donor', 'ngo', 'canary', 'unassigned']).optional(),
        status: z.enum(['active', 'paused']).optional(),
        stage: z.enum(['pilot', 'released']).optional(),
      })
      .parse(req.query);

    const where = [];
    const params = [];
    if (f.search) {
      params.push(`%${f.search}%`);
      where.push(`(s.software_name ILIKE $${params.length} OR s.winget_id ILIKE $${params.length})`);
    }
    if (f.source) {
      params.push(f.source);
      where.push(`s.source = $${params.length}`);
    }
    if (f.status) where.push(f.status === 'active' ? `s.isactive IS NOT FALSE` : `s.isactive = FALSE`);
    // Filters use the portal's release/pilot targets (live RMS targeting is derived from them).
    const tgt = (stage, kind) => `EXISTS (SELECT 1 FROM software_targets x WHERE x.software_id = s.id AND x.stage = '${stage}' AND x.kind = '${kind}')`;
    const hasSerials = `EXISTS (SELECT 1 FROM software_test_devices x WHERE x.software_id = s.id)`;
    const hasPilot = `(${hasSerials} OR EXISTS (SELECT 1 FROM software_targets x WHERE x.software_id = s.id AND x.stage = 'pilot'))`;
    if (f.target === 'global') where.push(`s.release_is_global = TRUE`);
    if (f.target === 'donor') where.push(tgt('release', 'donor'));
    if (f.target === 'ngo') where.push(tgt('release', 'ngo'));
    if (f.target === 'canary') where.push(hasPilot);
    if (f.target === 'unassigned')
      where.push(`s.release_is_global IS NOT TRUE AND NOT ${tgt('release', 'donor')} AND NOT ${tgt('release', 'ngo')} AND NOT ${hasPilot}`);
    if (f.stage) where.push(`COALESCE(s.rollout_stage, 'released') = '${f.stage}'`);

    const order = {
      newest: 's.created_at DESC NULLS LAST, s.id DESC',
      priority: 's.install_priority ASC NULLS LAST, s.id',
      name: 'lower(s.software_name)',
      failures: 'COALESCE(agg.devices_failed, 0) DESC, s.id DESC',
    }[f.sort];
    const caps = await serverCapabilities();
    const sql = `${SELECT_SOFTWARE(caps)} ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY ${order}`;
    const result = await query(sql, params);
    res.json({ data: result.rows.map(toApi) });
  }),
);

r.get('/:id', ah(async (req, res) => res.json({ data: await loadOne(req.params.id) })));

/** POST /api/admin/softwares — create + assign */
r.post(
  '/',
  ah(async (req, res) => {
    const d = softwareInput.parse(req.body);
    if (!d.release_now && !hasPilotTargets(d))
      throw fieldError('test_device_serials', 'Choose pilot laptops (serials) or a pilot NGO/donor group to test on first');
    const created = await tx(async (db) => {
      await validateAgainstDb(db, d);
      const baseCols = getSoftwareColumns();
      const cols = [...baseCols, 'created_by', 'created_at', 'updated_at'];
      const vals = [...getSoftwareValues(d, baseCols), req.user.username];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      const ins = await db.query(
        `INSERT INTO softwares (${cols.join(', ')}) VALUES (${placeholders}, NOW(), NOW()) RETURNING id`,
        vals,
      );
      const id = ins.rows[0].id;
      await saveTargets(db, id, d);
      const script = await publishClientScript(db, id); // before going live: laptops must get the script, not the raw file
      if (d.release_now) await releaseNow(db, id, req.user.username, null);
      else await startPilot(db, id);
      await audit(db, id, req.user.username, 'create', {
        source: d.source_type, file: d.file_name ?? d.winget_id, script: script?.url, stage: d.release_now ? 'released' : 'pilot',
      });
      return loadOne(id, db);
    });
    res.status(201).json({ data: created });
  }),
);

/** PUT /api/admin/softwares/:id — full update of parameters + targeting */
r.put(
  '/:id',
  ah(async (req, res) => {
    const d = softwareInput.parse(req.body);
    const updated = await tx(async (db) => {
      const cur = await db.query(
        `SELECT id, software_name, rollout_stage, winget_id, ${INSTALL_FIELDS.join(', ')} FROM softwares WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`,
        [req.params.id],
      );
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      const id = cur.rows[0].id;

      // Renaming would orphan install history and make every device reinstall it.
      if (cur.rows[0].software_name !== d.software_name) {
        const hist = await db.query(`SELECT 1 FROM softwares_installed WHERE software_name = $1 LIMIT 1`, [
          cur.rows[0].software_name,
        ]);
        if (hist.rowCount)
          throw new HttpError(
            409,
            'This software already has install history, so it cannot be renamed (devices track installs by name). Create a new entry instead.',
          );
      }

      await validateAgainstDb(db, d, id);
      const cols = getSoftwareColumns();
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const vals = getSoftwareValues(d, cols);
      vals.push(id);
      // Changing the binary invalidates any previous server-side verification.
      await db.query(
        `UPDATE softwares SET ${sets},
           checksum_verified_at = CASE WHEN sha256_checksum IS DISTINCT FROM $${cols.indexOf('sha256_checksum') + 1}::varchar
                                       THEN NULL ELSE checksum_verified_at END,
           updated_at = NOW()
         WHERE id = $${vals.length}`,
        vals,
      );
      await saveTargets(db, id, d);
      const script = await publishClientScript(db, id);

      // Stage: a changed installer goes back to the pilot; an explicit release_now goes to the fleet.
      const before = cur.rows[0];
      const after = (await db.query(`SELECT ${INSTALL_FIELDS.join(', ')} FROM softwares WHERE id = $1`, [id])).rows[0];
      const changed = INSTALL_FIELDS.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
      if (d.source_type === 'winget' && before.winget_id !== d.winget_id) changed.push('winget_id');
      const stage = before.rollout_stage || 'released';
      // RMS remembers installs BY NAME and never re-offers a name that succeeded on a laptop, so a changed
      // installer would never reach laptops that already have it (and old successes would pass the pilot).
      // Updates are therefore a new entry ("New version"). The transaction rolls back on this error.
      if (changed.length) {
        const installed = await db.query(
          `SELECT COUNT(DISTINCT device_id) AS n FROM softwares_installed WHERE software_name = $1 AND issuccessful IS TRUE`,
          [before.software_name],
        );
        if (Number(installed.rows[0].n) > 0)
          throw new HttpError(
            409,
            `"${before.software_name}" is already installed on ${installed.rows[0].n} laptop(s). Laptops never reinstall the same name, ` +
              `so changing the installer here would not update them. Use "New version" to create "${before.software_name} (new version)" ` +
              `and pilot it; the old version is paused automatically when the new one is released.`,
            { code: 'new_version_required', changed },
          );
      }
      const stays = stage === 'pilot' && !(d.release_now && !R.requirePilot);
      if ((changed.length || stays) && !d.release_now && !hasPilotTargets(d))
        throw fieldError('test_device_serials', changed.length
          ? 'The installer changed, so it must be re-tested: choose pilot laptops or a pilot NGO/donor group'
          : 'This software is in its pilot: keep at least one pilot laptop or group');
      let stageNote = null;
      if (d.release_now && !R.requirePilot) {
        await releaseNow(db, id, req.user.username, null);
        stageNote = 'released';
      } else if (changed.length) {
        await startPilot(db, id); // nothing installed yet: re-test the changed installer (also resets a failed pilot)
        stageNote = 'pilot_restarted';
      } else {
        await syncLiveTargets(db, id);
      }
      await audit(db, id, req.user.username, 'update', { script: script?.url, changed, stage: stageNote });
      return loadOne(id, db);
    });
    res.json({ data: updated });
  }),
);

/** PATCH /api/admin/softwares/:id/status — kill switch */
r.patch(
  '/:id/status',
  ah(async (req, res) => {
    const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
    const u = await query(
      `UPDATE softwares SET isactive = $1, updated_at = NOW() WHERE id::text = $2 AND deleted_at IS NULL RETURNING id`,
      [is_active, req.params.id],
    );
    if (!u.rowCount) throw new HttpError(404, 'Software not found');
    // Paused = no live targets, so it stops even on RMS servers that ignore `isactive`.
    await tx((db) => syncLiveTargets(db, u.rows[0].id));
    await audit({ query }, u.rows[0].id, req.user.username, is_active ? 'activate' : 'pause', null);
    res.json({ data: await loadOne(u.rows[0].id) });
  }),
);

/** PUT /api/admin/softwares/:id/test-devices — canary serials */
r.put(
  '/:id/test-devices',
  ah(async (req, res) => {
    const { serials } = z
      .object({
        serials: z
          .array(z.string().trim().min(3).max(100).regex(SERIAL_RE, 'Invalid serial number'))
          .max(limits.canaryMaxDevices, `Use at most ${limits.canaryMaxDevices} canary devices`),
      })
      .parse(req.body);
    const out = await tx(async (db) => {
      const cur = await db.query(`SELECT id FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      const id = cur.rows[0].id;
      await replaceTestDevices(db, id, [...new Set(serials)]);
      await audit(db, id, req.user.username, 'pilot_devices', { serials });
      return loadOne(id, db);
    });
    res.json({ data: out });
  }),
);

/**
 * POST /api/admin/softwares/:id/retry
 * Body: { serial_numbers: [...] } or { all_failed: true }
 * Records retry requests that the notInstalled endpoint honours (see integration/server-patch).
 */
r.post(
  '/:id/retry',
  ah(async (req, res) => {
    const body = z
      .object({
        serial_numbers: z.array(z.string().trim().min(1).max(100)).max(5000).optional(),
        all_failed: z.boolean().optional(),
      })
      .refine((b) => b.all_failed || b.serial_numbers?.length, 'Give serial_numbers or all_failed: true')
      .parse(req.body);

    // Retry requests are only honoured by the server patch. The unmodified RMS server already
    // re-offers every failed install at the laptop's next start, so there is nothing to queue.
    const caps = await serverCapabilities();
    if (!caps.device_targeting)
      throw new HttpError(
        409,
        'Not needed on your RMS server: failed installs are retried automatically the next time each laptop starts RMS.',
        { code: 'retry_automatic' },
      );

    const result = await tx(async (db) => {
      const cur = await db.query(`SELECT id, software_name FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`, [
        req.params.id,
      ]);
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      const { id, software_name } = cur.rows[0];

      let serials = body.serial_numbers ?? [];
      if (body.all_failed) {
        if (!schema.devices) throw new HttpError(400, 'Device table not available; pass serial_numbers explicitly');
        const failed = await db.query(
          `SELECT dv.${q(t.deviceSerial)} AS serial FROM (
             SELECT DISTINCT ON (device_id) device_id, issuccessful FROM softwares_installed
             WHERE software_name = $1 ORDER BY device_id, created_at DESC, id DESC
           ) l JOIN ${q(t.devices)} dv ON dv.id = l.device_id WHERE l.issuccessful IS NOT TRUE`,
          [software_name],
        );
        serials = failed.rows.map((x) => x.serial);
      }
      serials = [...new Set(serials)];
      if (serials.length)
        await db.query(
          `INSERT INTO software_retry_requests (software_id, serial_number, requested_by)
           SELECT $1, x, $3 FROM unnest($2::text[]) x
           ON CONFLICT (software_id, serial_number) DO UPDATE SET requested_at = NOW(), requested_by = EXCLUDED.requested_by`,
          [id, serials, req.user.username],
        );
      await audit(db, id, req.user.username, 'retry', { count: serials.length });
      return { queued: serials.length, serial_numbers: serials };
    });
    res.json({ data: result });
  }),
);

/** POST /api/admin/softwares/:id/verify-checksum — recompute SHA-256 from storage */
r.post(
  '/:id/verify-checksum',
  ah(async (req, res) => {
    const row = await query(
      `SELECT id, storage_key, sha256_checksum, file_size_bytes FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!row.rowCount) throw new HttpError(404, 'Software not found');
    const s = row.rows[0];
    if (!s.storage_key) throw new HttpError(400, 'Only uploaded files can be verified');
    req.setTimeout(30 * 60 * 1000);
    const { sha256, size } = await sha256OfObject(s.storage_key);
    const ok = sha256 === s.sha256_checksum && Number(size) === Number(s.file_size_bytes);
    if (ok) await query(`UPDATE softwares SET checksum_verified_at = NOW() WHERE id = $1`, [s.id]);
    await audit({ query }, s.id, req.user.username, 'verify', { ok, sha256, size });
    res.status(ok ? 200 : 422).json({
      data: { ok, expected: s.sha256_checksum, actual: sha256, expected_size: s.file_size_bytes, actual_size: size },
    });
  }),
);

/** DELETE /api/admin/softwares/:id — soft delete (also deactivates, so legacy server stops serving it) */
r.delete(
  '/:id',
  ah(async (req, res) => {
    const u = await query(
      `UPDATE softwares SET isactive = FALSE, deleted_at = NOW(), updated_at = NOW()
       WHERE id::text = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id],
    );
    if (!u.rowCount) throw new HttpError(404, 'Software not found');
    await tx((db) => syncLiveTargets(db, u.rows[0].id)); // stop offering it everywhere
    await audit({ query }, u.rows[0].id, req.user.username, 'delete', null);
    // The object in storage is intentionally kept (rollback / audit). Use bucket lifecycle rules to purge.
    res.status(204).end();
  }),
);

/** GET /api/admin/softwares/:id/client-script — the generated install script (preview / download) */
r.get(
  '/:id/client-script',
  ah(async (req, res) => {
    const x = await query(`SELECT * FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!x.rowCount) throw new HttpError(404, 'Software not found');
    const row = x.rows[0];
    if (!needsWrapper(row))
      throw new HttpError(404, wrapper.enabled ? 'This source is delivered natively (no install script).' : 'Install scripts are disabled (CLIENT_COMPAT_WRAPPER=false).');
    const built = buildForRow(row);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Script-Url', row.client_script_url || '');
    res.setHeader('X-Script-Current', String(!!row.client_script_sha256 && row.client_script_sha256 === built.sha256));
    res.setHeader('Content-Disposition', `inline; filename="${built.fileName}"`);
    res.send(built.content);
  }),
);

/** POST /api/admin/softwares/:id/client-script — (re)publish the install script */
r.post(
  '/:id/client-script',
  ah(async (req, res) => {
    const out = await tx(async (db) => {
      const cur = await db.query(`SELECT id FROM softwares WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id]);
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      const script = await publishClientScript(db, cur.rows[0].id);
      await audit(db, cur.rows[0].id, req.user.username, 'publish_script', script ? { script: script.url } : null);
      return loadOne(cur.rows[0].id, db);
    });
    res.json({ data: out });
  }),
);

// ---------------------------------------------------------------------------
// Rollout: pilot → release
// ---------------------------------------------------------------------------

/** GET /api/admin/softwares/:id/rollout — pilot laptops, results and the release rule */
r.get(
  '/:id/rollout',
  ah(async (req, res) => {
    const st = await pilotStatus(req.params.id);
    if (!st) throw new HttpError(404, 'Software not found');
    res.json({ data: st });
  }),
);

/** POST /api/admin/softwares/:id/rollout/check — evaluate now (auto-releases if the rule passes) */
r.post(
  '/:id/rollout/check',
  ah(async (req, res) => {
    const cur = await query(`SELECT id FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!cur.rowCount) throw new HttpError(404, 'Software not found');
    const result = await checkPilot(cur.rows[0].id, req.user.username);
    res.json({ data: { result, software: await loadOne(cur.rows[0].id) } });
  }),
);

/** POST /api/admin/softwares/:id/rollout/release  { force?: boolean } — send it to the release targets */
r.post(
  '/:id/rollout/release',
  ah(async (req, res) => {
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    const out = await tx(async (db) => {
      const cur = await db.query(`SELECT id, rollout_stage, isactive FROM softwares WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id]);
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      const sw = cur.rows[0];
      if ((sw.rollout_stage || 'released') === 'released') throw new HttpError(409, 'Already released');
      if (sw.isactive === false) throw new HttpError(409, 'Software is paused. Activate it first.');
      const st = await pilotStatus(sw.id, db);
      if (st.gate.outcome !== 'passed') {
        if (!force) throw new HttpError(409, `The pilot has not passed yet (${st.gate.succeeded}/${st.gate.required} succeeded, ${st.gate.failed} failed).`, { gate: st.gate });
        if (!R.allowForceRelease) throw new HttpError(403, 'Releasing before the pilot passes is disabled (ALLOW_FORCE_RELEASE=false).');
      }
      await releaseNow(db, sw.id, req.user.username, st.gate.outcome === 'passed' ? 'passed' : null);
      await audit(db, sw.id, req.user.username, force && st.gate.outcome !== 'passed' ? 'release_forced' : 'release', { gate: st.gate });
      return loadOne(sw.id, db);
    });
    res.json({ data: out });
  }),
);

/** POST /api/admin/softwares/:id/rollout/restart-pilot — back to pilot-only targeting */
r.post(
  '/:id/rollout/restart-pilot',
  ah(async (req, res) => {
    const out = await tx(async (db) => {
      const cur = await db.query(`SELECT id FROM softwares WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id]);
      if (!cur.rowCount) throw new HttpError(404, 'Software not found');
      await startPilot(db, cur.rows[0].id);
      await audit(db, cur.rows[0].id, req.user.username, 'pilot_restart', null);
      return loadOne(cur.rows[0].id, db);
    });
    res.json({ data: out });
  }),
);

/** GET /api/admin/softwares/:id/audit */
r.get(
  '/:id/audit',
  ah(async (req, res) => {
    const a = await query(
      `SELECT actor, action, details, created_at FROM software_audit_log WHERE software_id::text = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, limits.auditLogLimit],
    );
    res.json({ data: a.rows });
  }),
);

export default r;
