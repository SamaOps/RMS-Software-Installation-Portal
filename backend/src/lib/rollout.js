/**
 * Pilot → release rollouts.
 *
 * The portal owns two target sets per software (software_targets + software_test_devices +
 * softwares.release_is_global) and DERIVES the live RMS targeting that windows-rms-server reads
 * (softwares.is_global, donor_softwares, ngo_softwares) from the rollout stage:
 *
 *   pilot     -> pilot NGO/donor groups (+ pilot serials, honoured by the server patch)
 *   released  -> release targets + pilot groups
 *   paused / deleted -> nothing (works even on RMS servers that ignore `isactive`)
 *
 * A pilot passes when `required` pilot laptops succeed with at most `maxFailures` failures;
 * with auto_release the background check then releases it to the fleet.
 */
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { schema, q, reportJoinSql, deviceColumnsSql } from './schema.js';
import { rollout as R, wrapper } from '../settings.js';

const t = config.tables;

import { evaluateGate } from './rolloutRules.js';
export { evaluateGate, effectiveRequired, effectiveMaxFailures } from './rolloutRules.js';

// ---------------------------------------------------------------------------
// RMS server capabilities
// ---------------------------------------------------------------------------
/** Can the RMS server target single laptops (software_test_devices)? Env override, else heartbeat. */
export async function serverCapabilities(db = { query }) {
  const hb = await db
    .query(`SELECT source, version, capabilities, last_seen_at FROM rms_server_heartbeat ORDER BY last_seen_at DESC LIMIT 1`)
    .then((r) => r.rows[0] ?? null)
    .catch(() => null);
  const fresh = !!hb && Date.now() - new Date(hb.last_seen_at).getTime() < R.heartbeatMaxAgeMinutes * 60_000;
  const detected = fresh && hb.capabilities?.device_targeting === true;
  return {
    device_targeting: R.deviceTargeting === 'auto' ? detected : R.deviceTargeting,
    mode: R.deviceTargeting === 'auto' ? 'auto' : 'env',
    server_patch: hb ? { version: hb.version, last_seen_at: hb.last_seen_at, fresh } : null,
  };
}

// ---------------------------------------------------------------------------
// Pilot device results
// ---------------------------------------------------------------------------
/**
 * FROM/WHERE fragment yielding one row per pilot device of software alias `s`.
 * @param dt           SQL boolean literal: whether serial pilots are reachable (server patch present)
 * @param withSoftware include `softwares s` in FROM (detail query) instead of correlating to an outer `s`
 * @param extraJoins   additional joins on `dv` (e.g. NGO name)
 */
function pilotDevicesFrom(dt, { withSoftware = false, extraJoins = '' } = {}) {
  if (!schema.devices) return null;
  const serial = `dv.${q(t.deviceSerial)}`;
  const inSerials = `${serial} IN (SELECT td.serial_number FROM software_test_devices td WHERE td.software_id = s.id)`;
  const inGroup = (kind, fk, flag) =>
    flag ? `OR dv.${q(fk)}::text IN (SELECT pt.ref_id FROM software_targets pt WHERE pt.software_id = s.id AND pt.stage = 'pilot' AND pt.kind = '${kind}')` : '';
  const ok = R.trustScriptResult ? `COALESCE(rep.is_successful, si.issuccessful)` : `si.issuccessful`;
  return `
    FROM ${withSoftware ? 'softwares s CROSS JOIN ' : ''}${q(t.devices)} dv
    ${extraJoins}
    LEFT JOIN LATERAL (
      SELECT ${ok} AS ok, si.created_at, COALESCE(si.exit_code, rep.exit_code) AS exit_code,
             COALESCE(si.error_message, rep.error_message) AS error_message
      FROM softwares_installed si
      ${reportJoinSql(wrapper.reportMatchBeforeMinutes, wrapper.reportMatchAfterMinutes)}
      WHERE si.device_id = dv.id AND si.software_name = s.software_name
      ORDER BY si.created_at DESC, si.id DESC LIMIT 1
    ) l ON TRUE
    WHERE ((${dt} AND ${inSerials}) ${inGroup('ngo', t.deviceNgoFk, schema.deviceNgoFk)} ${inGroup('donor', t.deviceDonorFk, schema.deviceDonorFk)})`;
}

/** SQL expression: JSON {total, succeeded, failed} for software alias `s` (used in list queries). */
export function pilotSummarySql(deviceTargeting) {
  const from = pilotDevicesFrom(deviceTargeting ? 'TRUE' : 'FALSE');
  if (!from) return `json_build_object('total', 0, 'succeeded', 0, 'failed', 0)`;
  return `(SELECT json_build_object(
             'total', COUNT(*),
             'succeeded', COUNT(*) FILTER (WHERE l.ok IS TRUE),
             'failed', COUNT(*) FILTER (WHERE l.created_at IS NOT NULL AND l.ok IS NOT TRUE))
           ${from})`;
}

/** Full pilot status for one software: per-device rows + gate. */
export async function pilotStatus(softwareId, db = { query }) {
  const caps = await serverCapabilities(db);
  const sw = (
    await db.query(
      `SELECT id, software_name, rollout_stage, pilot_outcome, pilot_required_successes, pilot_max_failures, auto_release,
              isactive, pilot_started_at, pilot_decided_at, released_at, released_by
       FROM softwares WHERE id::text = $1 AND deleted_at IS NULL`,
      [String(softwareId)],
    )
  ).rows[0];
  if (!sw) return null;

  let devices = [];
  const c = deviceColumnsSql();
  const from = pilotDevicesFrom(caps.device_targeting ? 'TRUE' : 'FALSE', { withSoftware: true, extraJoins: c.joins });
  if (from) {
    const r = await db.query(
      `SELECT dv.id AS device_id, ${c.serial} AS serial_number, ${c.username} AS username, ${c.location} AS location,
              ${c.ngo} AS ngo_name, l.ok, l.created_at AS last_attempt_at, l.exit_code, l.error_message
       ${from}
         AND s.id::text = $1
       ORDER BY 2`,
      [String(softwareId)],
    );
    devices = r.rows.map((d) => ({
      ...d,
      status: d.last_attempt_at == null ? 'pending' : d.ok ? 'succeeded' : 'failed',
    }));
  }

  // Pilot serials that are not registered in RMS, or not reachable without the server patch.
  const serials = (await db.query(`SELECT serial_number FROM software_test_devices WHERE software_id::text = $1 ORDER BY 1`, [String(softwareId)])).rows.map((x) => x.serial_number);
  const counted = new Set(devices.map((d) => String(d.serial_number).toLowerCase()));
  const notCounted = serials.filter((s) => !counted.has(s.toLowerCase()));
  const registered = notCounted.length && schema.devices
    ? new Set((await db.query(`SELECT ${q(t.deviceSerial)} AS s FROM ${q(t.devices)} WHERE ${q(t.deviceSerial)} = ANY($1::text[])`, [notCounted])).rows.map((x) => String(x.s).toLowerCase()))
    : new Set();

  const counts = {
    total: devices.length,
    succeeded: devices.filter((d) => d.status === 'succeeded').length,
    failed: devices.filter((d) => d.status === 'failed').length,
  };
  return {
    stage: sw.rollout_stage || 'released',
    pilot_outcome: sw.pilot_outcome,
    auto_release: sw.auto_release !== false,
    is_active: sw.isactive !== false,
    pilot_started_at: sw.pilot_started_at,
    pilot_decided_at: sw.pilot_decided_at,
    released_at: sw.released_at,
    released_by: sw.released_by,
    gate: evaluateGate(sw, counts),
    devices,
    unregistered_serials: notCounted.filter((s) => !registered.has(s.toLowerCase())),
    unreachable_serials: notCounted.filter((s) => registered.has(s.toLowerCase())), // need the server patch
    server: caps,
  };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
async function replaceTargetSet(db, softwareId, stage, kind, ids) {
  await db.query(`DELETE FROM software_targets WHERE software_id = $1 AND stage = $2 AND kind = $3`, [softwareId, stage, kind]);
  if (ids.length)
    await db.query(
      `INSERT INTO software_targets (software_id, stage, kind, ref_id) SELECT $1, $2, $3, x FROM unnest($4::text[]) x ON CONFLICT DO NOTHING`,
      [softwareId, stage, kind, ids.map(String)],
    );
}

export async function replaceTestDevices(db, softwareId, serials) {
  await db.query(`DELETE FROM software_test_devices WHERE software_id = $1`, [softwareId]);
  if (serials.length)
    await db.query(
      `INSERT INTO software_test_devices (software_id, serial_number) SELECT $1, x FROM unnest($2::text[]) AS x ON CONFLICT DO NOTHING`,
      [softwareId, serials],
    );
}

/** Save pilot + release targets from a validated payload (does not touch live tables). */
export async function saveTargets(db, softwareId, d) {
  await replaceTargetSet(db, softwareId, 'release', 'donor', d.is_global ? [] : d.assigned_donors);
  await replaceTargetSet(db, softwareId, 'release', 'ngo', d.is_global ? [] : d.assigned_ngos);
  await replaceTargetSet(db, softwareId, 'pilot', 'donor', d.pilot_donors);
  await replaceTargetSet(db, softwareId, 'pilot', 'ngo', d.pilot_ngos);
  await replaceTestDevices(db, softwareId, d.test_device_serials);
  await db.query(`UPDATE softwares SET release_is_global = $2 WHERE id = $1`, [softwareId, !!d.is_global]);
}

/** Rewrite the live targeting windows-rms-server reads, from the rollout stage. */
export async function syncLiveTargets(db, softwareId) {
  const sw = (await db.query(`SELECT id, rollout_stage, release_is_global, isactive, deleted_at FROM softwares WHERE id = $1`, [softwareId])).rows[0];
  if (!sw) return;
  const live = !sw.deleted_at && sw.isactive !== false;
  const released = live && (sw.rollout_stage || 'released') === 'released';
  const stages = !live ? [] : released ? ['pilot', 'release'] : ['pilot'];

  const targets = stages.length
    ? (await db.query(`SELECT DISTINCT kind, ref_id FROM software_targets WHERE software_id = $1 AND stage = ANY($2::text[])`, [softwareId, stages])).rows
    : [];
  await db.query(`UPDATE softwares SET is_global = $2 WHERE id = $1`, [softwareId, released && !!sw.release_is_global]);
  await db.query(`DELETE FROM donor_softwares WHERE software_id = $1`, [softwareId]);
  await db.query(`DELETE FROM ngo_softwares   WHERE software_id = $1`, [softwareId]);
  // One row at a time with an untyped parameter: Postgres casts to whatever type donor_id / ngo_id has.
  for (const x of targets) {
    const table = x.kind === 'donor' ? 'donor_softwares' : 'ngo_softwares';
    const col = x.kind === 'donor' ? 'donor_id' : 'ngo_id';
    await db.query(`INSERT INTO ${table} (${col}, software_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [x.ref_id, softwareId]);
  }
}

// ---------------------------------------------------------------------------
// Stage changes
// ---------------------------------------------------------------------------
export async function startPilot(db, softwareId) {
  await db.query(
    `UPDATE softwares SET rollout_stage = 'pilot', pilot_outcome = 'running', pilot_started_at = NOW(),
            pilot_decided_at = NULL, released_at = NULL, released_by = NULL WHERE id = $1`,
    [softwareId],
  );
  await syncLiveTargets(db, softwareId);
}

export async function releaseNow(db, softwareId, actor, outcome = null) {
  await db.query(
    `UPDATE softwares SET rollout_stage = 'released', released_at = NOW(), released_by = $2::text,
            pilot_outcome = COALESCE($3::text, pilot_outcome), pilot_decided_at = COALESCE(pilot_decided_at, NOW())
     WHERE id = $1`,
    [softwareId, actor, outcome],
  );
  await syncLiveTargets(db, softwareId);

  // New version released -> pause the version it replaces (stops it on laptops that don't have it yet).
  const prev = await db.query(
    `UPDATE softwares o SET isactive = FALSE, updated_at = NOW()
     FROM softwares n WHERE n.id = $1 AND n.replaces_software_id IS NOT NULL AND o.id::text = n.replaces_software_id
       AND o.deleted_at IS NULL AND o.isactive IS NOT FALSE
     RETURNING o.id`,
    [softwareId],
  );
  for (const { id } of prev.rows) {
    await syncLiveTargets(db, id);
    await audit(db, id, actor, 'pause', { reason: 'replaced by a new version', by_software_id: String(softwareId) });
  }
}

const audit = (db, softwareId, actor, action, details) =>
  db.query(`INSERT INTO software_audit_log (software_id, actor, action, details) VALUES ($1, $2, $3, $4)`, [
    softwareId,
    actor,
    action,
    details ? JSON.stringify(details) : null,
  ]);

/**
 * Evaluate one pilot and act: record pass/fail, auto-release when allowed.
 * Idempotent and safe to run from several API instances (row lock + stage re-check).
 */
export async function checkPilot(softwareId, actor = 'auto-rollout') {
  return tx(async (db) => {
    const locked = await db.query(
      `SELECT id, rollout_stage, pilot_outcome, auto_release, isactive FROM softwares
       WHERE id = $1 AND deleted_at IS NULL FOR UPDATE SKIP LOCKED`,
      [softwareId],
    );
    const sw = locked.rows[0];
    if (!sw || sw.rollout_stage !== 'pilot' || sw.isactive === false) return null;
    const st = await pilotStatus(sw.id, db);
    const outcome = st.gate.outcome === 'passed' ? 'passed' : st.gate.outcome === 'failed' ? 'failed' : 'running';
    if (outcome !== sw.pilot_outcome) {
      await db.query(
        `UPDATE softwares SET pilot_outcome = $2::text, pilot_decided_at = CASE WHEN $2::text = 'running' THEN NULL ELSE NOW() END WHERE id = $1`,
        [sw.id, outcome],
      );
      if (outcome !== 'running') await audit(db, sw.id, actor, `pilot_${outcome}`, st.gate);
    }
    if (outcome === 'passed' && sw.auto_release !== false) {
      await releaseNow(db, sw.id, actor, 'passed');
      await audit(db, sw.id, actor, 'release', { reason: 'pilot passed', gate: st.gate });
      return 'released';
    }
    return outcome;
  });
}

export async function checkAllPilots() {
  const r = await query(`SELECT id FROM softwares WHERE rollout_stage = 'pilot' AND deleted_at IS NULL AND isactive IS NOT FALSE`);
  const results = {};
  for (const { id } of r.rows) {
    try {
      results[id] = await checkPilot(id);
    } catch (e) {
      console.error(`[rollout] check failed for software ${id}:`, e.message);
    }
  }
  return results;
}

export function startRolloutJob() {
  if (!R.checkIntervalSeconds) return null;
  const run = () => checkAllPilots().catch((e) => console.error('[rollout] job error:', e.message));
  setTimeout(run, 5_000);
  const timer = setInterval(run, R.checkIntervalSeconds * 1000);
  timer.unref?.();
  console.log(`[rollout] pilot checks every ${R.checkIntervalSeconds}s`);
  return timer;
}
