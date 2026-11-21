/**
 * The portal reads a few EXISTING RMS tables whose exact shape may differ between
 * deployments. At startup we introspect them once and only reference columns
 * that actually exist, so a missing optional column degrades a feature instead
 * of crashing a query.
 */
import { query } from '../db.js';
import { config } from '../config.js';

const t = config.tables;
export const q = (ident) => `"${ident}"`; // identifiers are pre-validated in config.js

export const schema = {
  donors: false,
  ngos: false,
  devices: false,
  deviceModel: false,
  deviceUser: false,
  deviceLocation: false,
  deviceActive: false,
  deviceVersion: false,
  lastSeen: false,
  deviceNgoFk: false,
  deviceDonorFk: false,
  migrated: false,
  migrated002: false,
  migrated003: false,
  migrated004: false,
  isSilentArgsJsonb: false,
  hasRunAs: false,
  hasTimeoutSeconds: false,
  hasScripts: false,
};

async function columns(table) {
  if (!table) return null;
  const r = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return r.rowCount ? new Set(r.rows.map((x) => x.column_name)) : null;
}

export async function introspect() {
  const [donors, ngos, devices, softwares, seen] = await Promise.all([
    columns(t.donors),
    columns(t.ngos),
    columns(t.devices),
    columns('softwares'),
    columns(t.lastSeenTable),
  ]);

  if (!softwares) throw new Error('Table "softwares" not found. Is DATABASE_URL pointing at the RMS database?');
  schema.migrated = softwares.has('installer_type') && softwares.has('deleted_at');
  if (!schema.migrated) throw new Error('Migration 001 has not been applied. Run: npm run migrate');
  schema.migrated002 = softwares.has('install_priority') && softwares.has('success_exit_codes');
  if (!schema.migrated002) throw new Error('Migration 002 has not been applied. Run: npm run migrate');
  schema.migrated003 = softwares.has('client_script_url');
  if (!schema.migrated003) throw new Error('Migration 003 has not been applied. Run: npm run migrate');
  schema.migrated004 = softwares.has('rollout_stage');
  if (!schema.migrated004) throw new Error('Migration 004 has not been applied. Run: npm run migrate');

  const softwareColInfo = await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'softwares'`
  );
  const typesMap = new Map(softwareColInfo.rows.map((r) => [r.column_name, r.data_type]));
  schema.isSilentArgsJsonb = typesMap.get('silent_args') === 'jsonb';
  schema.hasRunAs = softwares.has('run_as');
  schema.hasTimeoutSeconds = softwares.has('timeout_seconds');
  schema.hasScripts = softwares.has('pre_install_script');

  const has = (set, col) => !!col && !!set?.has(col);
  schema.donors = !!donors?.has('id') && has(donors, t.donorName);
  schema.ngos = !!ngos?.has('id') && has(ngos, t.ngoName);
  schema.devices = !!devices?.has('id') && has(devices, t.deviceSerial);
  schema.deviceModel = schema.devices && has(devices, t.deviceModel);
  schema.deviceUser = schema.devices && has(devices, t.deviceUser);
  schema.deviceLocation = schema.devices && has(devices, t.deviceLocation);
  schema.deviceActive = schema.devices && has(devices, t.deviceActive);
  schema.deviceVersion = schema.devices && has(devices, t.deviceVersion);
  schema.lastSeen = schema.devices && has(seen, t.lastSeenDeviceFk) && has(seen, t.lastSeenTime);
  schema.deviceNgoFk = schema.devices && schema.ngos && has(devices, t.deviceNgoFk);
  schema.deviceDonorFk = schema.devices && schema.donors && has(devices, t.deviceDonorFk);

  for (const [k, v] of Object.entries(schema)) if (!v) console.warn(`[schema] optional feature disabled: ${k}`);
  return schema;
}

/** SQL fragments describing a device row aliased `dv` (+ NGO `n`, donor `d`), safe when columns are missing. */
export function deviceColumnsSql() {
  const col = (flag, c) => (flag ? `dv.${q(c)}` : 'NULL');
  return {
    serial: schema.devices ? `dv.${q(t.deviceSerial)}` : 'NULL',
    model: col(schema.deviceModel, t.deviceModel),
    username: col(schema.deviceUser, t.deviceUser),
    location: col(schema.deviceLocation, t.deviceLocation),
    ngo: schema.deviceNgoFk ? `n.${q(t.ngoName)}` : 'NULL',
    donor: schema.deviceDonorFk ? `dn.${q(t.donorName)}` : 'NULL',
    joins: [
      schema.deviceNgoFk ? `LEFT JOIN ${q(t.ngos)} n ON n.id = dv.${q(t.deviceNgoFk)}` : '',
      schema.deviceDonorFk ? `LEFT JOIN ${q(t.donors)} dn ON dn.id = dv.${q(t.deviceDonorFk)}` : '',
    ].join(' '),
  };
}

/**
 * LATERAL join attaching the closest install-script report (software_install_reports) to a
 * softwares_installed row aliased `si`, as `rep`. The 1.4.0 client only reports true/false;
 * the generated script posts exit code, error and transcript shortly before that.
 * Window is env-driven (WRAPPER_REPORT_MATCH_BEFORE/AFTER_MINUTES).
 */
export function reportJoinSql(before, after) {
  return `LEFT JOIN LATERAL (
      SELECT r.exit_code, r.error_message, r.log_output, r.is_successful, r.created_at, r.software_version
      FROM software_install_reports r
      WHERE r.device_id = si.device_id AND r.software_name = si.software_name
        AND r.created_at BETWEEN si.created_at - make_interval(mins => ${Number(before)})
                             AND si.created_at + make_interval(mins => ${Number(after)})
      ORDER BY abs(extract(epoch FROM (r.created_at - si.created_at))) LIMIT 1
    ) rep ON TRUE`;
}

/** SQL fragment: JSON array of {id,name} portal targets (stage 'pilot'|'release') for softwares alias `s`. */
export function targetNamesSql(kind, stage) {
  const ok = kind === 'donor' ? schema.donors : schema.ngos;
  const table = kind === 'donor' ? t.donors : t.ngos;
  const name = kind === 'donor' ? t.donorName : t.ngoName;
  const nameExpr = ok ? `COALESCE((SELECT x.${q(name)} FROM ${q(table)} x WHERE x.id::text = st.ref_id LIMIT 1), st.ref_id)` : 'st.ref_id';
  return `(SELECT COALESCE(json_agg(json_build_object('id', st.ref_id, 'name', ${nameExpr}) ORDER BY st.ref_id), '[]'::json)
           FROM software_targets st WHERE st.software_id = s.id AND st.stage = '${stage}' AND st.kind = '${kind}')`;
}

/** SQL fragment: JSON array of {id,name} donors/ngos assigned to softwares row alias `s`. */
export function assignedDonorsSql() {
  if (!schema.donors)
    return `(SELECT COALESCE(json_agg(json_build_object('id', ds.donor_id, 'name', ds.donor_id::text)), '[]'::json)
             FROM donor_softwares ds WHERE ds.software_id = s.id)`;
  return `(SELECT COALESCE(json_agg(json_build_object('id', d.id, 'name', d.${q(t.donorName)}) ORDER BY d.${q(t.donorName)}), '[]'::json)
           FROM donor_softwares ds JOIN ${q(t.donors)} d ON d.id = ds.donor_id WHERE ds.software_id = s.id)`;
}

export function assignedNgosSql() {
  if (!schema.ngos)
    return `(SELECT COALESCE(json_agg(json_build_object('id', ns.ngo_id, 'name', ns.ngo_id::text)), '[]'::json)
             FROM ngo_softwares ns WHERE ns.software_id = s.id)`;
  return `(SELECT COALESCE(json_agg(json_build_object('id', n.id, 'name', n.${q(t.ngoName)}) ORDER BY n.${q(t.ngoName)}), '[]'::json)
           FROM ngo_softwares ns JOIN ${q(t.ngos)} n ON n.id = ns.ngo_id WHERE ns.software_id = s.id)`;
}

/**
 * SQL fragment: number of registered devices this software targets (global / donor / NGO / canary).
 * Used for "X / Y installed" rollout progress. NULL when the devices table is unavailable.
 */
export function targetedDevicesSql() {
  if (!schema.devices) return 'NULL::bigint';
  const active = schema.deviceActive ? `AND dv.${q(t.deviceActive)} IS NOT FALSE` : '';
  const donor = schema.deviceDonorFk
    ? `OR EXISTS (SELECT 1 FROM donor_softwares ds WHERE ds.software_id = s.id AND ds.donor_id = dv.${q(t.deviceDonorFk)})`
    : '';
  const ngo = schema.deviceNgoFk
    ? `OR EXISTS (SELECT 1 FROM ngo_softwares ns WHERE ns.software_id = s.id AND ns.ngo_id = dv.${q(t.deviceNgoFk)})`
    : '';
  return `(SELECT COUNT(*) FROM ${q(t.devices)} dv
           WHERE (s.is_global = TRUE ${donor} ${ngo}
                  OR EXISTS (SELECT 1 FROM software_test_devices td WHERE td.software_id = s.id AND td.serial_number = dv.${q(t.deviceSerial)}))
           ${active})`;
}
