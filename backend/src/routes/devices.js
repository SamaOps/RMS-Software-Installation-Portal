/**
 * Laptops view: what every RMS laptop has, is missing, or failed.
 *
 * Status per (laptop, software) follows the SAME rules windows-rms-server uses to decide what to
 * offer (models/softwareModel.js), so "waiting" here is exactly what the laptop will try next:
 *   targeted  = software active + not deleted AND (is_global OR laptop's donor/NGO assigned
 *               OR laptop is a pilot serial when the server patch is present)
 *   installed = any successful attempt under that software name (RMS never re-offers it)
 *   failed    = attempted, never succeeded (RMS re-offers it at the next start)
 *   waiting   = targeted, never attempted
 *
 * GET /api/admin/devices?search=&ngo_id=&donor_id=&software_id=&status=&sort=&page=&page_size=
 * GET /api/admin/devices/export.csv?<same filters>
 * GET /api/admin/devices/:serial
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { schema, q, deviceColumnsSql } from '../lib/schema.js';
import { serverCapabilities } from '../lib/rollout.js';
import { limits } from '../settings.js';

const r = Router();
const t = config.tables;

const filterSchema = z.object({
  serial: z.string().trim().max(100).optional(), // exact match (detail view)
  search: z.string().trim().max(200).optional(),
  ngo_id: z.string().max(64).optional(),
  donor_id: z.string().max(64).optional(),
  software_id: z.string().max(64).optional(),
  status: z.enum(['all', 'complete', 'waiting', 'failed', 'not_installed']).default('all'),
  active: z.enum(['all', 'active', 'inactive']).default('all'),
  sort: z.enum(['attention', 'serial', 'last_seen', 'location']).default('attention'),
});

function requireDevices() {
  if (!schema.devices) throw new HttpError(501, 'The RMS devices table is not available (check DEVICES_* settings).');
}

/** Shared CTEs: filtered laptops (dv0), targeted softwares (tg), per-pair status (st), per-laptop counts (agg). */
function buildCtes(f, caps) {
  const p = [];
  const add = (v) => {
    p.push(v);
    return `$${p.length}`;
  };
  const serial = `d.${q(t.deviceSerial)}`;
  const where = [];
  if (f.serial) where.push(`${serial} = ${add(f.serial)}`);
  if (f.search) {
    const s = add(`%${f.search}%`);
    const cols = [serial, schema.deviceUser && `d.${q(t.deviceUser)}`, schema.deviceLocation && `d.${q(t.deviceLocation)}`].filter(Boolean);
    where.push(`(${cols.map((c) => `${c}::text ILIKE ${s}`).join(' OR ')})`);
  }
  if (f.ngo_id && schema.deviceNgoFk) where.push(`d.${q(t.deviceNgoFk)}::text = ${add(f.ngo_id)}`);
  if (f.donor_id && schema.deviceDonorFk) where.push(`d.${q(t.deviceDonorFk)}::text = ${add(f.donor_id)}`);
  if (f.active !== 'all' && schema.deviceActive)
    where.push(f.active === 'active' ? `d.${q(t.deviceActive)} IS NOT FALSE` : `d.${q(t.deviceActive)} = FALSE`);

  const ngoFk = schema.deviceNgoFk ? `d.${q(t.deviceNgoFk)}` : 'NULL::int';
  const donorFk = schema.deviceDonorFk ? `d.${q(t.deviceDonorFk)}` : 'NULL::int';
  const swFilter = f.software_id ? `AND s.id::text = ${add(f.software_id)}` : '';

  const ctes = `
    dv0 AS (
      SELECT d.id, ${serial} AS serial, ${ngoFk} AS ngo_id, ${donorFk} AS donor_id
      FROM ${q(t.devices)} d ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ),
    sw AS (
      SELECT s.id, s.software_name, s.is_global FROM softwares s
      WHERE s.deleted_at IS NULL AND s.isactive IS NOT FALSE ${swFilter}
    ),
    tg AS (
      SELECT dv0.id AS device_id, sw.id AS software_id, sw.software_name FROM dv0 JOIN sw ON sw.is_global = TRUE
      UNION
      SELECT dv0.id, sw.id, sw.software_name FROM dv0 JOIN donor_softwares ds ON ds.donor_id = dv0.donor_id JOIN sw ON sw.id = ds.software_id
      UNION
      SELECT dv0.id, sw.id, sw.software_name FROM dv0 JOIN ngo_softwares ns ON ns.ngo_id = dv0.ngo_id JOIN sw ON sw.id = ns.software_id
      ${caps.device_targeting ? `UNION SELECT dv0.id, sw.id, sw.software_name FROM dv0 JOIN software_test_devices td ON td.serial_number = dv0.serial JOIN sw ON sw.id = td.software_id` : ''}
    ),
    h AS (
      SELECT si.device_id, si.software_name, BOOL_OR(si.issuccessful IS TRUE) AS ok, COUNT(*) AS attempts, MAX(si.created_at) AS last_at
      FROM softwares_installed si WHERE si.device_id IN (SELECT id FROM dv0) GROUP BY 1, 2
    ),
    st AS (
      SELECT tg.device_id, tg.software_id,
             CASE WHEN h.ok THEN 'installed' WHEN h.device_id IS NULL THEN 'waiting' ELSE 'failed' END AS status,
             h.last_at
      FROM tg LEFT JOIN h ON h.device_id = tg.device_id AND h.software_name = tg.software_name
    ),
    agg AS (
      SELECT device_id, COUNT(*) AS targeted,
             COUNT(*) FILTER (WHERE status = 'installed') AS installed,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed,
             COUNT(*) FILTER (WHERE status = 'waiting') AS waiting,
             MAX(last_at) AS last_install_at
      FROM st GROUP BY device_id
    ),
    dv AS (
      SELECT dv0.*, COALESCE(agg.targeted, 0) AS targeted, COALESCE(agg.installed, 0) AS installed,
             COALESCE(agg.failed, 0) AS failed, COALESCE(agg.waiting, 0) AS waiting, agg.last_install_at
      FROM dv0 LEFT JOIN agg ON agg.device_id = dv0.id
    )`;

  const statusWhere = {
    all: '',
    complete: 'WHERE dv.failed = 0 AND dv.waiting = 0',
    waiting: 'WHERE dv.waiting > 0',
    failed: 'WHERE dv.failed > 0',
    not_installed: 'WHERE dv.failed > 0 OR dv.waiting > 0',
  }[f.status];
  return { ctes, params: p, statusWhere };
}

function displaySql() {
  const raw = deviceColumnsSql();
  const c = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replaceAll('dv.', 'd2.')]));
  const lastSeen = schema.lastSeen
    ? `(SELECT MAX(lt.${q(t.lastSeenTime)}) FROM ${q(t.lastSeenTable)} lt WHERE lt.${q(t.lastSeenDeviceFk)} = dv.id)`
    : 'NULL';
  return {
    cols: `dv.id AS device_id, dv.serial AS serial_number, ${c.username} AS username, ${c.location} AS location,
           ${c.ngo} AS ngo_name, ${c.donor} AS donor_name,
           ${schema.deviceVersion ? `d2.${q(t.deviceVersion)}` : 'NULL'} AS rms_version,
           ${schema.deviceActive ? `d2.${q(t.deviceActive)} IS NOT FALSE` : 'TRUE'} AS is_active,
           ${lastSeen} AS last_seen_at,
           dv.targeted, dv.installed, dv.failed, dv.waiting, dv.last_install_at`,
    joins: `JOIN ${q(t.devices)} d2 ON d2.id = dv.id ${c.joins}`,
  };
}

const ORDER = {
  attention: 'dv.failed DESC, dv.waiting DESC, dv.serial',
  serial: 'dv.serial',
  last_seen: 'last_seen_at DESC NULLS LAST, dv.serial',
  location: 'location NULLS LAST, dv.serial',
};

async function listDevices(f, { page, pageSize }) {
  const caps = await serverCapabilities();
  const { ctes, params, statusWhere } = buildCtes(f, caps);
  const d = displaySql();
  const base = `WITH ${ctes} SELECT ${d.cols} FROM dv ${d.joins} ${statusWhere}`;
  const [rows, summary] = await Promise.all([
    query(`${base} ORDER BY ${ORDER[f.sort]} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ]),
    query(
      `WITH ${ctes}
       SELECT COUNT(*) AS laptops,
              COUNT(*) FILTER (WHERE dv.failed = 0 AND dv.waiting = 0) AS complete,
              COUNT(*) FILTER (WHERE dv.waiting > 0) AS with_waiting,
              COUNT(*) FILTER (WHERE dv.failed > 0) AS with_failures,
              COALESCE(SUM(dv.installed), 0) AS installs,
              COALESCE(SUM(dv.failed), 0) AS failed_installs,
              COALESCE(SUM(dv.waiting), 0) AS waiting_installs
       FROM dv ${statusWhere}`,
      params,
    ),
  ]);
  return { rows: rows.rows, summary: summary.rows[0] };
}

r.get(
  '/',
  ah(async (req, res) => {
    requireDevices();
    const f = filterSchema
      .extend({
        page: z.coerce.number().int().min(1).default(1),
        page_size: z.coerce.number().int().min(1).max(limits.historyMaxPageSize).default(limits.historyPageSize),
      })
      .parse(req.query);
    const { rows, summary } = await listDevices(f, { page: f.page, pageSize: f.page_size });
    res.json({ data: rows, summary, page: f.page, page_size: f.page_size, total: Number(summary.laptops) });
  }),
);

r.get(
  '/export.csv',
  ah(async (req, res) => {
    requireDevices();
    const f = filterSchema.parse(req.query);
    const { rows } = await listDevices(f, { page: 1, pageSize: limits.exportMaxRows });
    const cols = ['serial_number', 'username', 'location', 'ngo_name', 'donor_name', 'rms_version', 'is_active', 'last_seen_at',
      'targeted', 'installed', 'failed', 'waiting', 'last_install_at'];
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const sv = v instanceof Date ? v.toISOString() : String(v);
      return `"${(/^[=+\-@\t\r]/.test(sv) ? `'${sv}` : sv).replace(/"/g, '""')}"`;
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rms-laptops-${stamp}.csv"`);
    res.send('﻿' + [cols.join(','), ...rows.map((x) => cols.map((c) => cell(x[c])).join(','))].join('\r\n'));
  }),
);

/** One laptop: every targeted software (+ anything it ever attempted) with its status. */
r.get(
  '/:serial',
  ah(async (req, res) => {
    requireDevices();
    const caps = await serverCapabilities();
    const { ctes, params } = buildCtes(filterSchema.parse({ serial: req.params.serial }), caps);
    const d = displaySql();
    const one = await query(`WITH ${ctes} SELECT ${d.cols} FROM dv ${d.joins}`, params);
    if (!one.rowCount) throw new HttpError(404, 'Laptop not found in RMS');
    const device = one.rows[0];

    const ids = await query(
      `SELECT ${schema.deviceNgoFk ? `${q(t.deviceNgoFk)}::text` : 'NULL'} AS ngo,
              ${schema.deviceDonorFk ? `${q(t.deviceDonorFk)}::text` : 'NULL'} AS donor
       FROM ${q(t.devices)} WHERE id = $1`,
      [device.device_id],
    );
    const softwares = await query(
      `WITH me AS (SELECT $1::text AS serial, $2::text AS ngo, $3::text AS donor, $4::int AS id),
       live AS (
         SELECT s.id, s.software_name, s.version, s.source, COALESCE(s.rollout_stage, 'released') AS stage,
                (s.is_global = TRUE
                 OR EXISTS (SELECT 1 FROM ngo_softwares ns, me WHERE ns.software_id = s.id AND ns.ngo_id::text = me.ngo)
                 OR EXISTS (SELECT 1 FROM donor_softwares ds, me WHERE ds.software_id = s.id AND ds.donor_id::text = me.donor)
                 ${caps.device_targeting ? `OR EXISTS (SELECT 1 FROM software_test_devices td, me WHERE td.software_id = s.id AND td.serial_number = me.serial)` : ''}
                ) AS targeted
         FROM softwares s WHERE s.deleted_at IS NULL AND s.isactive IS NOT FALSE
       ),
       hist AS (
         SELECT si.software_name, BOOL_OR(si.issuccessful IS TRUE) AS ok, COUNT(*) AS attempts, MAX(si.created_at) AS last_at,
                (ARRAY_AGG(si.id ORDER BY si.created_at DESC, si.id DESC))[1] AS last_history_id,
                (ARRAY_AGG(si.exit_code ORDER BY si.created_at DESC, si.id DESC))[1] AS exit_code,
                (ARRAY_AGG(si.error_message ORDER BY si.created_at DESC, si.id DESC))[1] AS error_message
         FROM softwares_installed si, me WHERE si.device_id = me.id GROUP BY si.software_name
       )
       SELECT live.id::text AS software_id, COALESCE(live.software_name, hist.software_name) AS software_name,
              live.version, live.source, live.stage, COALESCE(live.targeted, FALSE) AS targeted,
              CASE WHEN hist.ok THEN 'installed' WHEN hist.software_name IS NULL THEN 'waiting' ELSE 'failed' END AS status,
              COALESCE(hist.attempts, 0) AS attempts, hist.last_at AS last_attempt_at, hist.last_history_id,
              hist.exit_code, hist.error_message,
              live.id IS NULL AS not_in_portal
       FROM live FULL OUTER JOIN hist ON hist.software_name = live.software_name
       WHERE COALESCE(live.targeted, FALSE) OR hist.software_name IS NOT NULL
       ORDER BY CASE WHEN hist.software_name IS NOT NULL AND NOT hist.ok THEN 0 WHEN hist.software_name IS NULL THEN 1 ELSE 2 END,
                lower(COALESCE(live.software_name, hist.software_name))`,
      [device.serial_number, ids.rows[0]?.ngo ?? null, ids.rows[0]?.donor ?? null, device.device_id],
    );
    res.json({ data: { device, softwares: softwares.rows, server: caps } });
  }),
);

export default r;
