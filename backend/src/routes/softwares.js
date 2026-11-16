import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { softwareInput, SERIAL_RE } from '../lib/validation.js';
import { schema, q, assignedDonorsSql, assignedNgosSql, targetedDevicesSql } from '../lib/schema.js';
import { SOURCE_TYPES } from '../lib/installerDefaults.js';
import { limits, wrapper } from '../settings.js';
import { publishClientScript, buildForRow } from '../lib/clientScripts.js';
import { needsWrapper } from '../lib/wrapperScript.js';
import { headObject, keyFor, sha256OfObject, publicUrlFor } from '../storage/s3.js';

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
const SELECT_SOFTWARE = () => `
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
         ${assignedDonorsSql()} AS assigned_donors,
         ${assignedNgosSql()}   AS assigned_ngos,
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
    silent_args: row.silent_args,
    execution_context: row.execution_context || 'SYSTEM',
    is_portable: !!row.is_portable,
    target_install_path: row.target_install_path,
    create_desktop_shortcut: row.create_desktop_shortcut !== false,
    timeout_minutes: row.timeout_minutes ?? limits.timeoutDefaultMinutes,
    success_exit_codes: row.success_exit_codes,
    install_priority: row.install_priority ?? limits.installPriorityDefault,
    max_retry_attempts: row.max_retry_attempts,
    effective_max_retry_attempts: row.max_retry_attempts ?? limits.maxAutoRetryAttempts,
    min_rms_version: row.min_rms_version,
    is_global: !!row.is_global,
    detection_type: row.detection_type || 'exit_code_zero',
    detection_path: row.detection_path,
    assigned_donors: row.assigned_donors ?? [],
    assigned_ngos: row.assigned_ngos ?? [],
    test_device_serials: row.test_device_serials ?? [],
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
  const res = await db.query(`${SELECT_SOFTWARE()} AND s.id::text = $1`, [String(id)]);
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

  if (schema.donors) await assertIdsExist(db, t.donors, d.assigned_donors, 'donor');
  if (schema.ngos) await assertIdsExist(db, t.ngos, d.assigned_ngos, 'NGO');
}

const COLUMNS = [
  'software_name', 'version', 'description', 'isactive', 'source', 'winget_id', 'file_name', 'storage_key',
  'file_url', 'file_size_bytes', 'sha256_checksum', 'installer_type', 'silent_args', 'execution_context',
  'is_portable', 'target_install_path', 'create_desktop_shortcut', 'timeout_minutes', 'is_global',
  'detection_type', 'detection_path', 'success_exit_codes', 'install_priority', 'max_retry_attempts', 'min_rms_version',
];

const values = (d) => [
  d.software_name, d.version, d.description, d.is_active, d.source_type, d.winget_id, d.file_name, d.storage_key,
  d.file_url, d.file_size_bytes, d.sha256_checksum, d.installer_type ?? null, d.silent_args, d.execution_context,
  d.is_portable, d.target_install_path, d.create_desktop_shortcut, d.timeout_minutes, d.is_global,
  d.detection_type, d.detection_path, d.success_exit_codes, d.install_priority, d.max_retry_attempts, d.min_rms_version,
];

async function replaceAssignments(db, softwareId, d) {
  await db.query(`DELETE FROM donor_softwares WHERE software_id = $1`, [softwareId]);
  await db.query(`DELETE FROM ngo_softwares   WHERE software_id = $1`, [softwareId]);
  for (const donorId of d.assigned_donors)
    await db.query(`INSERT INTO donor_softwares (donor_id, software_id) VALUES ($1, $2)`, [donorId, softwareId]);
  for (const ngoId of d.assigned_ngos)
    await db.query(`INSERT INTO ngo_softwares (ngo_id, software_id) VALUES ($1, $2)`, [ngoId, softwareId]);
  await replaceTestDevices(db, softwareId, d.test_device_serials);
}

async function replaceTestDevices(db, softwareId, serials) {
  await db.query(`DELETE FROM software_test_devices WHERE software_id = $1`, [softwareId]);
  if (serials.length)
    await db.query(
      `INSERT INTO software_test_devices (software_id, serial_number)
       SELECT $1, x FROM unnest($2::text[]) AS x ON CONFLICT DO NOTHING`,
      [softwareId, serials],
    );
}

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
    const has = (tbl) => `EXISTS (SELECT 1 FROM ${tbl} x WHERE x.software_id = s.id)`;
    if (f.target === 'global') where.push(`s.is_global = TRUE`);
    if (f.target === 'donor') where.push(has('donor_softwares'));
    if (f.target === 'ngo') where.push(has('ngo_softwares'));
    if (f.target === 'canary') where.push(has('software_test_devices'));
    if (f.target === 'unassigned')
      where.push(`s.is_global IS NOT TRUE AND NOT ${has('donor_softwares')} AND NOT ${has('ngo_softwares')} AND NOT ${has('software_test_devices')}`);

    const order = {
      newest: 's.created_at DESC NULLS LAST, s.id DESC',
      priority: 's.install_priority ASC NULLS LAST, s.id',
      name: 'lower(s.software_name)',
      failures: 'COALESCE(agg.devices_failed, 0) DESC, s.id DESC',
    }[f.sort];
    const sql = `${SELECT_SOFTWARE()} ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY ${order}`;
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
    const created = await tx(async (db) => {
      await validateAgainstDb(db, d);
      const cols = [...COLUMNS, 'created_by', 'created_at', 'updated_at'];
      const vals = [...values(d), req.user.username];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      const ins = await db.query(
        `INSERT INTO softwares (${cols.join(', ')}) VALUES (${placeholders}, NOW(), NOW()) RETURNING id`,
        vals,
      );
      const id = ins.rows[0].id;
      await replaceAssignments(db, id, d);
      const script = await publishClientScript(db, id);
      await audit(db, id, req.user.username, 'create', { source: d.source_type, file: d.file_name ?? d.winget_id, script: script?.url });
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
        `SELECT id, software_name FROM softwares WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`,
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
      const sets = COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const vals = values(d);
      vals.push(id);
      // Changing the binary invalidates any previous server-side verification.
      await db.query(
        `UPDATE softwares SET ${sets},
           checksum_verified_at = CASE WHEN sha256_checksum IS DISTINCT FROM $${COLUMNS.indexOf('sha256_checksum') + 1}::varchar
                                       THEN NULL ELSE checksum_verified_at END,
           updated_at = NOW()
         WHERE id = $${vals.length}`,
        vals,
      );
      await replaceAssignments(db, id, d);
      const script = await publishClientScript(db, id);
      await audit(db, id, req.user.username, 'update', script ? { script: script.url } : null);
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
      await audit(db, id, req.user.username, 'canary', { serials });
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
