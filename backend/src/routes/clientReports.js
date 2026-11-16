/**
 * POST /api/client/install-report — detailed result posted by the generated install
 * scripts (wrapperScript.js). Public by necessity (laptops have no portal login), so it is:
 *   - rate-limited per IP, size-limited, and only accepts known devices + softwares;
 *   - optionally gated by WRAPPER_REPORT_TOKEN (embedded in scripts; deters drive-by posts);
 *   - write-only: it never returns stored data.
 * The 1.4.0 client still records the authoritative success/failure via addHistory;
 * these reports only enrich the history view (exit code, error, transcript).
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { schema, q } from '../lib/schema.js';
import { wrapper, limits } from '../settings.js';

const r = Router();
const t = config.tables;

const body = z.object({
  serial_number: z.string().trim().min(1).max(100),
  software_id: z.union([z.string(), z.number()]).optional().nullable(),
  software_name: z.string().trim().min(1).max(255),
  software_version: z.string().max(50).optional().nullable(),
  is_successful: z.boolean().optional().nullable(),
  exit_code: z.number().int().optional().nullable(),
  error_message: z.string().optional().nullable(),
  log_output: z.string().optional().nullable(),
  wrapper_version: z.string().max(20).optional().nullable(),
  token: z.string().max(200).optional().nullable(),
});

r.post(
  '/install-report',
  rateLimit({
    windowMs: wrapper.reportRateWindowMinutes * 60 * 1000,
    limit: wrapper.reportRateMax,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  express.json({ limit: Math.ceil(wrapper.maxReportLogChars * 1.5) + 8192 }),
  ah(async (req, res) => {
    const b = body.parse(req.body);
    if (wrapper.reportToken && b.token !== wrapper.reportToken) throw new HttpError(403, 'Invalid report token');

    const sw = await query(
      `SELECT id, software_name FROM softwares
       WHERE ($1::text IS NOT NULL AND id::text = $1::text) OR (lower(software_name) = lower($2))
       ORDER BY (id::text = COALESCE($1::text, '')) DESC LIMIT 1`,
      [b.software_id != null && b.software_id !== '' ? String(b.software_id) : null, b.software_name],
    );
    if (!sw.rowCount) throw new HttpError(404, 'Unknown software');

    let deviceId = null;
    if (schema.devices) {
      const dv = await query(`SELECT id FROM ${q(t.devices)} WHERE ${q(t.deviceSerial)} = $1 LIMIT 1`, [b.serial_number]);
      if (!dv.rowCount) throw new HttpError(404, 'Unknown device');
      deviceId = dv.rows[0].id;
    }

    const log = b.log_output ? b.log_output.slice(-wrapper.maxReportLogChars) : null;
    await query(
      `INSERT INTO software_install_reports
         (software_id, software_name, serial_number, device_id, is_successful, exit_code, error_message, log_output,
          software_version, wrapper_version, remote_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        sw.rows[0].id,
        sw.rows[0].software_name, // canonical name, so it matches softwares_installed rows
        b.serial_number,
        deviceId,
        b.is_successful ?? null,
        b.exit_code ?? null,
        b.error_message ? b.error_message.slice(0, limits.maxErrorChars) : null,
        log,
        b.software_version || null,
        b.wrapper_version || null,
        String(req.ip || '').slice(0, 64),
      ],
    );
    res.status(204).end();
  }),
);

export default r;
