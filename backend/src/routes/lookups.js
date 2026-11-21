import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { ah } from '../lib/errors.js';
import { schema, q, deviceColumnsSql } from '../lib/schema.js';
import { limits, uiSettings, presets } from '../settings.js';
import { serverCapabilities } from '../lib/rollout.js';

const r = Router();
const t = config.tables;

r.get(
  '/donors',
  ah(async (_req, res) => {
    if (!schema.donors) return res.json({ data: [] });
    const x = await query(`SELECT id, ${q(t.donorName)} AS name FROM ${q(t.donors)} ORDER BY lower(${q(t.donorName)})`);
    res.json({ data: x.rows });
  }),
);

r.get(
  '/ngos',
  ah(async (_req, res) => {
    if (!schema.ngos) return res.json({ data: [] });
    const x = await query(`SELECT id, ${q(t.ngoName)} AS name FROM ${q(t.ngos)} ORDER BY lower(${q(t.ngoName)})`);
    res.json({ data: x.rows });
  }),
);

/** Serial-number autocomplete for canary targeting. */
r.get(
  '/devices',
  ah(async (req, res) => {
    if (!schema.devices) return res.json({ data: [] });
    const s = String(req.query.search || '').trim().slice(0, 100);
    const c = deviceColumnsSql();
    const x = await query(
      `SELECT ${c.serial} AS serial_number, ${c.model} AS model, ${c.username} AS username,
              ${c.location} AS location, ${c.ngo} AS ngo_name, ${c.donor} AS donor_name
       FROM ${q(t.devices)} dv ${c.joins}
       WHERE ${c.serial} ILIKE $1 ORDER BY 1 LIMIT $2`,
      [`%${s}%`, limits.deviceSearchLimit],
    );
    res.json({ data: x.rows });
  }),
);

/** Presets, limits and labels that drive the UI. All values come from env / config/portal-presets.json. */
r.get('/installer-defaults', (_req, res) =>
  res.json({
    data: uiSettings({
      public_download_base_url: config.publicDownloadBaseUrl || null,
      features: {
        devices: schema.devices,
        donors: schema.donors,
        ngos: schema.ngos,
        device_model: schema.deviceModel,
      },
    }),
  }),
);

/** What the connected RMS server can do (single-laptop pilots need the server patch). */
r.get('/rms-server', ah(async (_req, res) => res.json({ data: await serverCapabilities() })));

/** Exit-code catalog for the log viewer (also included in /installer-defaults). */
r.get('/exit-codes', (_req, res) => res.json({ data: presets.exit_codes }));

export default r;
