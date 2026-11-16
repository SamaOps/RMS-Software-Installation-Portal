import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { schema, q, deviceColumnsSql } from '../lib/schema.js';
import { diagnose } from '../lib/diagnostics.js';
import { limits, wrapper } from '../settings.js';
import { reportJoinSql } from '../lib/schema.js';

const REP = () => reportJoinSql(wrapper.reportMatchBeforeMinutes, wrapper.reportMatchAfterMinutes);
// Client row wins; the install-script report fills what the 1.4.0 client can't send.
const ERR = `COALESCE(si.error_message, rep.error_message)`;
const EXIT = `COALESCE(si.exit_code, rep.exit_code)`;
const LOG = `COALESCE(NULLIF(si.log_output, ''), rep.log_output)`;

const r = Router();
const t = config.tables;

function deviceJoins() {
  const c = deviceColumnsSql();
  const serial = schema.devices ? c.serial : `si.device_id::text`;
  const joins = `${schema.devices ? `LEFT JOIN ${q(t.devices)} dv ON dv.id = si.device_id` : ''} ${schema.devices ? c.joins : ''}`;
  return { ...c, serial, joins };
}

const filterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['success', 'failed']).optional(),
  software_id: z.string().max(64).optional(),
  ngo_id: z.string().max(64).optional(),
  donor_id: z.string().max(64).optional(),
  exit_code: z.coerce.number().int().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  latest_only: z.enum(['true', 'false']).optional(),
});

/** Build the shared FROM/WHERE for list + count + export. */
function buildQuery(f) {
  const d = deviceJoins();
  const where = [];
  const p = [];
  const add = (sql, v) => {
    p.push(v);
    where.push(sql.replaceAll('?', `$${p.length}`));
  };
  if (f.search)
    add(
      `(${d.serial} ILIKE ? OR si.software_name ILIKE ? OR ${ERR} ILIKE ? OR COALESCE(${d.ngo}, '') ILIKE ? OR COALESCE(${d.location}, '') ILIKE ?)`,
      `%${f.search}%`,
    );
  if (f.status === 'success') where.push(`si.issuccessful = TRUE`);
  if (f.status === 'failed') where.push(`si.issuccessful IS NOT TRUE`);
  if (f.software_id) add(`s.id::text = ?`, f.software_id);
  if (f.ngo_id && schema.deviceNgoFk) add(`dv.${q(t.deviceNgoFk)}::text = ?`, f.ngo_id);
  if (f.donor_id && schema.deviceDonorFk) add(`dv.${q(t.deviceDonorFk)}::text = ?`, f.donor_id);
  if (f.exit_code !== undefined) add(`${EXIT} = ?`, f.exit_code);
  if (f.from) add(`si.created_at >= ?::date`, f.from);
  if (f.to) add(`si.created_at < (?::date + 1)`, f.to);
  if (f.latest_only === 'true')
    where.push(`NOT EXISTS (SELECT 1 FROM softwares_installed n2 WHERE n2.device_id = si.device_id
                  AND n2.software_name = si.software_name AND (n2.created_at, n2.id) > (si.created_at, si.id))`);

  const base = `
    FROM softwares_installed si
    ${d.joins}
    ${REP()}
    LEFT JOIN softwares s ON s.software_name = si.software_name AND s.deleted_at IS NULL
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const select = `si.id, si.device_id, ${d.serial} AS serial_number, ${d.model} AS model, ${d.username} AS username,
      ${d.location} AS location, ${d.ngo} AS ngo_name, ${d.donor} AS donor_name,
      si.software_name, s.id AS software_id, s.version AS current_version, COALESCE(si.software_version, rep.software_version) AS software_version,
      si.issuccessful AS is_successful, si.created_at, ${ERR} AS error_message, ${EXIT} AS exit_code,
      (${LOG} IS NOT NULL AND ${LOG} <> '') AS has_log,
      rep.is_successful AS script_reported_success, rep.created_at AS script_reported_at,
      NOT EXISTS (SELECT 1 FROM softwares_installed n2 WHERE n2.device_id = si.device_id
          AND n2.software_name = si.software_name AND (n2.created_at, n2.id) > (si.created_at, si.id)) AS is_latest,
      (SELECT rr.requested_at FROM software_retry_requests rr
        WHERE rr.software_id = s.id AND rr.serial_number = ${d.serial} AND rr.requested_at > si.created_at) AS retry_requested_at`;

  return { base, select, params: p };
}

const withDiagnosis = (row) => ({ ...row, diagnosis: row.is_successful ? null : diagnose(row.exit_code, row.error_message) });

/**
 * GET /api/admin/history?search=&status=success|failed&software_id=&ngo_id=&donor_id=&exit_code=&from=&to=&latest_only=&page=&page_size=
 */
r.get(
  '/',
  ah(async (req, res) => {
    const f = filterSchema
      .extend({
        page: z.coerce.number().int().min(1).default(1),
        page_size: z.coerce.number().int().min(1).max(limits.historyMaxPageSize).default(limits.historyPageSize),
      })
      .parse(req.query);
    const { base, select, params } = buildQuery(f);
    const offset = (f.page - 1) * f.page_size;
    const [rows, count] = await Promise.all([
      query(
        `SELECT ${select} ${base} ORDER BY si.created_at DESC, si.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, f.page_size, offset],
      ),
      query(`SELECT COUNT(*) AS total ${base}`, params),
    ]);
    res.json({ data: rows.rows.map(withDiagnosis), page: f.page, page_size: f.page_size, total: count.rows[0].total });
  }),
);

/** GET /api/admin/history/export.csv?<same filters> — downloadable audit report */
r.get(
  '/export.csv',
  ah(async (req, res) => {
    const f = filterSchema.parse(req.query);
    const { base, select, params } = buildQuery(f);
    const x = await query(`SELECT ${select} ${base} ORDER BY si.created_at DESC, si.id DESC LIMIT $${params.length + 1}`, [
      ...params,
      limits.exportMaxRows,
    ]);
    const cols = [
      'created_at', 'serial_number', 'username', 'location', 'ngo_name', 'donor_name', 'software_name',
      'software_version', 'is_successful', 'exit_code', 'error_message', 'diagnosis', 'is_latest',
    ];
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const sv = v instanceof Date ? v.toISOString() : String(v);
      // Neutralise spreadsheet formula injection and quote.
      const safe = /^[=+\-@\t\r]/.test(sv) ? `'${sv}` : sv;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const lines = [cols.join(',')];
    for (const row of x.rows) {
      const dx = withDiagnosis(row).diagnosis;
      lines.push(cols.map((c) => cell(c === 'diagnosis' ? (dx ? `${dx.title}: ${dx.hint}` : '') : row[c])).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rms-install-history-${stamp}.csv"`);
    if (x.rowCount >= limits.exportMaxRows) res.setHeader('X-Export-Truncated', String(limits.exportMaxRows));
    res.send('﻿' + lines.join('\r\n'));
  }),
);

/** GET /api/admin/history/:id — full record including the raw transcript log */
r.get(
  '/:id',
  ah(async (req, res) => {
    const d = deviceJoins();
    const x = await query(
      `SELECT si.*, ${ERR} AS error_message, ${EXIT} AS exit_code, ${LOG} AS log_output,
              COALESCE(si.software_version, rep.software_version) AS software_version,
              rep.is_successful AS script_reported_success, rep.created_at AS script_reported_at,
              si.issuccessful AS is_successful, ${d.serial} AS serial_number, ${d.model} AS model,
              ${d.username} AS username, ${d.location} AS location, ${d.ngo} AS ngo_name, ${d.donor} AS donor_name,
              s.id AS software_id, s.installer_type, s.silent_args, s.execution_context, s.timeout_minutes, s.source,
              s.success_exit_codes, s.detection_type, s.detection_path, s.client_script_url
       FROM softwares_installed si ${d.joins} ${REP()}
       LEFT JOIN softwares s ON s.software_name = si.software_name AND s.deleted_at IS NULL
       WHERE si.id::text = $1`,
      [req.params.id],
    );
    if (!x.rowCount) throw new HttpError(404, 'History record not found');
    const row = x.rows[0];
    res.json({ data: { ...row, diagnosis: row.is_successful ? null : diagnose(row.exit_code, row.error_message, row.log_output) } });
  }),
);

export default r;
