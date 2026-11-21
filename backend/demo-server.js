/**
 * Offline demo server: `npm run demo`.
 *
 * Same /api/admin/* contract as src/index.js, but all in memory: no database, no
 * S3, no credentials. Presets, limits and exit-code diagnostics come from the SAME
 * src/settings.js + config/portal-presets.json the real API uses, so the demo can
 * never drift from production behaviour. Data comes from demo/seed.json
 * (override with DEMO_SEED_FILE).
 *
 * Env: DEMO_PORT (or PORT), DEMO_USER, DEMO_SEED_FILE, DEMO_PUBLIC_DOWNLOAD_BASE_URL,
 *      plus every tunable from .env.example (limits are shared).
 */
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { limits, uiSettings, fileNameRegex, defaultSuccessExitCodes } from './src/settings.js';
import { diagnose } from './src/lib/diagnostics.js';
import { generateWrapper, needsWrapper } from './src/lib/wrapperScript.js';
import { evaluateGate } from './src/lib/rolloutRules.js';
import { rollout as R, bool } from './src/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || process.env.PORT || 4000);
const DEMO_USER = process.env.DEMO_USER || 'demo-admin';
const SEED_FILE = path.resolve(process.env.DEMO_SEED_FILE || path.join(here, 'demo/seed.json'));
const PUBLIC_BASE = (process.env.DEMO_PUBLIC_DOWNLOAD_BASE_URL || process.env.PUBLIC_DOWNLOAD_BASE_URL || `http://localhost:${PORT}/softwares`).replace(/\/+$/, '');
const KEY_PREFIX = (process.env.S3_KEY_PREFIX ?? 'softwares/').replace(/^\/+/, '');
const DAY = 86_400_000;
// Mimic the RMS server: the unmodified server can only target groups (NGO/donor), not single laptops.
const DEVICE_TARGETING = bool(process.env.DEMO_DEVICE_TARGETING, false);

const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const ago = (days) => (days == null ? null : new Date(Date.now() - days * DAY).toISOString());

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const donors = seed.donors ?? [];
const ngos = seed.ngos ?? [];
const devices = seed.devices ?? [];
const deviceById = new Map(devices.map((d) => [String(d.id), d]));
const nameOf = (list, id) => list.find((x) => String(x.id) === String(id))?.name ?? `#${id}`;
const objects = new Map(); // storage_key -> size (mock bucket)
const retries = []; // { software_id, serial_number, requested_at, requested_by }
const audit = []; // { software_id, actor, action, details, created_at }
let nextHistoryId = Math.max(0, ...(seed.history ?? []).map((h) => h.id)) + 1;

let softwares = (seed.softwares ?? []).map((s) => ({
  ...s,
  created_at: ago(s.created_days_ago ?? 0),
  updated_at: ago(s.updated_days_ago ?? 0),
  deleted_at: null,
}));
const history = (seed.history ?? []).map((h) => ({ ...h, created_at: ago(h.created_days_ago ?? 0) }));

// Generated install scripts (what deployed 1.4.0 clients run), served at /softwares/<name>.ps1
const scripts = new Map(); // fileName -> content
function publishScript(s) {
  if (!needsWrapper(s)) {
    s.client_script_url = null;
    if (s.source_type !== 'winget' && s.file_name) s.winget_id = s.file_name;
    return;
  }
  const b = generateWrapper(s, { publicDownloadBaseUrl: PUBLIC_BASE });
  scripts.set(b.fileName, b.content);
  if (s.client_script_url !== `${PUBLIC_BASE}/${b.fileName}`) s.client_script_generated_at = new Date().toISOString();
  s.client_script_url = `${PUBLIC_BASE}/${b.fileName}`;
  s.client_script_sha256 = b.sha256;
  s.winget_id = s.client_script_url;
}
for (const s of softwares) {
  if (s.source_type !== 'winget' && !s.file_name) s.file_name = s.winget_id;
  try {
    publishScript(s);
  } catch (e) {
    console.warn(`[demo] no install script for ${s.software_name}: ${e.message}`);
  }
}

const log = (software_id, action, details = null) =>
  audit.unshift({ software_id, actor: DEMO_USER, action, details, created_at: new Date().toISOString() });

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------
function latestPerDevice(name) {
  const m = new Map();
  for (const h of history) {
    if (h.software_name !== name) continue;
    const cur = m.get(h.device_id);
    if (!cur || h.created_at > cur.created_at) m.set(h.device_id, h);
  }
  return [...m.values()];
}

function statsFor(s) {
  const base = s.demo_stats ?? {};
  const latest = latestPerDevice(s.software_name);
  const succeeded = (base.devices_succeeded ?? 0) + latest.filter((h) => h.is_successful).length;
  const failed = (base.devices_failed ?? 0) + latest.filter((h) => !h.is_successful).length;
  const attempted = succeeded + failed;
  const targeted = base.devices_targeted ?? null;
  const lastLocal = history.filter((h) => h.software_name === s.software_name).map((h) => h.created_at).sort().pop() ?? null;
  return {
    devices_targeted: targeted,
    devices_pending: targeted != null ? Math.max(0, targeted - attempted) : null,
    devices_attempted: attempted,
    devices_succeeded: succeeded,
    devices_failed: failed,
    total_attempts: (base.total_attempts ?? 0) + history.filter((h) => h.software_name === s.software_name).length,
    last_attempt_at: lastLocal ?? ago(base.last_attempt_days_ago),
    success_rate: attempted ? +((succeeded / attempted) * 100).toFixed(1) : null,
  };
}

// --- Rollout (same rules as the real API: src/lib/rolloutRules.js) ---------------------------
const ids = (list) => (list ?? []).map((x) => String(x.id ?? x));
function pilotDevices(s) {
  const serials = new Set((s.test_device_serials ?? []).map((x) => x.toLowerCase()));
  const pn = new Set(ids(s.pilot_ngos));
  const pd = new Set(ids(s.pilot_donors));
  return devices
    .filter((d) => (DEVICE_TARGETING && serials.has(d.serial_number.toLowerCase())) || pn.has(String(d.ngo_id)) || pd.has(String(d.donor_id)))
    .map((d) => {
      const h = history
        .filter((x) => x.device_id === d.id && x.software_name === s.software_name)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return {
        device_id: d.id,
        serial_number: d.serial_number,
        username: d.username ?? null,
        location: d.location ?? null,
        ngo_name: d.ngo_id != null ? nameOf(ngos, d.ngo_id) : null,
        status: !h ? 'pending' : h.is_successful ? 'succeeded' : 'failed',
        last_attempt_at: h?.created_at ?? null,
        exit_code: h?.exit_code ?? null,
        error_message: h?.error_message ?? null,
      };
    });
}
function gateOf(s) {
  const p = pilotDevices(s);
  return evaluateGate(s, { total: p.length, succeeded: p.filter((x) => x.status === 'succeeded').length, failed: p.filter((x) => x.status === 'failed').length });
}
function release(s, actor, outcome = null) {
  s.rollout_stage = 'released';
  s.released_at = new Date().toISOString();
  s.released_by = actor;
  if (outcome) s.pilot_outcome = outcome;
  // New version released -> pause the version it replaces
  const prev = s.replaces_software_id && find(s.replaces_software_id);
  if (prev && prev.is_active) {
    prev.is_active = false;
    log(prev.id, 'pause', { reason: 'replaced by a new version', by_software_id: String(s.id) });
  }
}
function startPilot(s) {
  Object.assign(s, { rollout_stage: 'pilot', pilot_outcome: 'running', pilot_started_at: new Date().toISOString(), released_at: null, released_by: null });
}
/** Evaluate pilots like the API's background job. */
function checkPilots() {
  for (const s of live()) {
    if (s.rollout_stage !== 'pilot' || !s.is_active) continue;
    const g = gateOf(s);
    const outcome = g.outcome === 'passed' ? 'passed' : g.outcome === 'failed' ? 'failed' : 'running';
    if (outcome !== s.pilot_outcome) {
      s.pilot_outcome = outcome;
      if (outcome !== 'running') log(s.id, `pilot_${outcome}`, g);
    }
    if (outcome === 'passed' && s.auto_release !== false) {
      release(s, 'auto-rollout', 'passed');
      log(s.id, 'release', { reason: 'pilot passed' });
    }
  }
}

function toApi(s) {
  const { demo_stats, created_days_ago, updated_days_ago, deleted_at, ...rest } = s;
  const fileName = s.file_name || (s.source_type === 'rms-repository' ? s.winget_id : null);
  return {
    ...rest,
    delivery: s.source_type === 'winget' ? 'winget' : s.client_script_url ? 'install_script' : 'direct',
    client_script_url: s.client_script_url ?? null,
    client_script_generated_at: s.client_script_generated_at ?? null,
    file_name: fileName,
    download_url: s.source_type === 'rms-repository' && fileName ? `${PUBLIC_BASE}/${encodeURIComponent(fileName)}` : s.file_url,
    install_priority: s.install_priority ?? limits.installPriorityDefault,
    pilot_ngos: s.pilot_ngos ?? [],
    pilot_donors: s.pilot_donors ?? [],
    pilot_required_successes: s.pilot_required_successes ?? null,
    pilot_max_failures: s.pilot_max_failures ?? null,
    auto_release: s.auto_release !== false,
    rollout: {
      stage: s.rollout_stage || 'released',
      pilot_outcome: s.pilot_outcome ?? null,
      pilot_started_at: s.pilot_started_at ?? null,
      released_at: s.released_at ?? null,
      released_by: s.released_by ?? null,
      gate: gateOf(s),
    },
    effective_max_retry_attempts: s.max_retry_attempts ?? limits.maxAutoRetryAttempts,
    created_by: s.created_by ?? DEMO_USER,
    stats: statsFor(s),
  };
}

function historyRow(h) {
  const dv = deviceById.get(String(h.device_id)) ?? {};
  const sw = softwares.find((s) => s.software_name === h.software_name && !s.deleted_at);
  const newer = history.some((o) => o.device_id === h.device_id && o.software_name === h.software_name && o.created_at > h.created_at);
  const rr = retries.find((r) => sw && String(r.software_id) === String(sw.id) && r.serial_number === dv.serial_number && r.requested_at > h.created_at);
  const { log_output, created_days_ago, ...rest } = h;
  return {
    ...rest,
    serial_number: dv.serial_number ?? String(h.device_id),
    model: dv.model ?? null,
    username: dv.username ?? null,
    location: dv.location ?? null,
    ngo_name: dv.ngo_id != null ? nameOf(ngos, dv.ngo_id) : null,
    donor_name: dv.donor_id != null ? nameOf(donors, dv.donor_id) : null,
    software_id: sw?.id ?? null,
    current_version: sw?.version ?? null,
    has_log: !!log_output,
    is_latest: !newer,
    retry_requested_at: rr?.requested_at ?? null,
    diagnosis: h.is_successful ? null : diagnose(h.exit_code, h.error_message, log_output),
  };
}

const live = () => softwares.filter((s) => !s.deleted_at);
const find = (id) => live().find((s) => String(s.id) === String(id));
const notFound = (res) => res.status(404).json({ error: 'Software not found' });

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, demo: true }));

// --- Auth (any credentials work in demo mode) ---
app.post('/api/admin/auth/login', (req, res) =>
  res.json({ data: { token: `demo.${crypto.randomBytes(12).toString('hex')}`, username: req.body?.username || DEMO_USER } }),
);
app.get('/api/admin/auth/me', (_req, res) => res.json({ data: { username: DEMO_USER } }));

// --- Analytics ---
app.get('/api/admin/analytics/status', (_req, res) => {
  const list = live();
  const all = list.map(statsFor);
  const succeeded = all.reduce((a, s) => a + s.devices_succeeded, 0);
  const failed = all.reduce((a, s) => a + s.devices_failed, 0);
  const pairs = succeeded + failed;

  const days = limits.analyticsDailyDays;
  const baseline = seed.daily_baseline ?? [];
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.now() - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    const b = baseline[baseline.length - days + i] ?? [0, 0];
    const today = history.filter((h) => h.created_at.slice(0, 10) === date);
    return { date, success: b[0] + today.filter((h) => h.is_successful).length, failed: b[1] + today.filter((h) => !h.is_successful).length };
  });

  const errMap = new Map((seed.top_errors_baseline ?? []).map((e) => [e.error, { ...e }]));
  const since = Date.now() - limits.analyticsErrorWindowDays * DAY;
  for (const h of history.filter((x) => !x.is_successful && new Date(x.created_at).getTime() > since)) {
    const key = (h.error_message || (h.exit_code != null ? `Exit code ${h.exit_code}` : 'No error message reported')).slice(0, 120);
    const e = errMap.get(key) ?? { error: key, exit_code: h.exit_code ?? null, count: 0 };
    e.count++;
    errMap.set(key, e);
  }

  res.json({
    data: {
      inventory: {
        total_softwares: list.length,
        active_deployments: list.filter((s) => s.is_active).length,
        paused: list.filter((s) => !s.is_active).length,
        global_count: list.filter((s) => s.is_global).length,
        repository_count: list.filter((s) => s.source_type === 'rms-repository').length,
        winget_count: list.filter((s) => s.source_type === 'winget').length,
        external_count: list.filter((s) => s.source_type === 'external_url').length,
      },
      fleet: {
        device_software_pairs: pairs,
        succeeded,
        failed_needing_attention: failed,
        success_rate: pairs ? +((succeeded / pairs) * 100).toFixed(1) : null,
        attempts_24h: history.filter((h) => Date.now() - new Date(h.created_at).getTime() < limits.analyticsRecentHours * 3_600_000).length,
        devices_reporting: devices.length,
      },
      daily,
      top_errors: [...errMap.values()].sort((a, b) => b.count - a.count).slice(0, limits.analyticsTopErrors),
      windows: {
        recent_hours: limits.analyticsRecentHours,
        daily_days: limits.analyticsDailyDays,
        error_window_days: limits.analyticsErrorWindowDays,
      },
    },
  });
});

// --- Lookups ---
app.get('/api/admin/lookups/donors', (_req, res) => res.json({ data: donors }));
app.get('/api/admin/lookups/ngos', (_req, res) => res.json({ data: ngos }));
app.get('/api/admin/lookups/devices', (req, res) => {
  const s = String(req.query.search || '').toLowerCase();
  res.json({
    data: devices
      .filter((d) => d.serial_number.toLowerCase().includes(s))
      .slice(0, limits.deviceSearchLimit)
      .map((d) => ({
        serial_number: d.serial_number,
        model: d.model ?? null,
        username: d.username ?? null,
        location: d.location ?? null,
        ngo_name: d.ngo_id != null ? nameOf(ngos, d.ngo_id) : null,
        donor_name: d.donor_id != null ? nameOf(donors, d.donor_id) : null,
      })),
  });
});
app.get('/api/admin/lookups/installer-defaults', (_req, res) =>
  res.json({
    data: uiSettings({
      public_download_base_url: PUBLIC_BASE,
      features: { devices: true, donors: true, ngos: true, device_model: true },
      demo: true,
    }),
  }),
);
app.get('/api/admin/lookups/exit-codes', (_req, res) => res.json({ data: uiSettings().exit_codes }));

// --- Softwares ---
app.get('/api/admin/softwares', (req, res) => {
  checkPilots();
  const { search, status, source, target, sort = 'newest' } = req.query;
  let list = live();
  if (search) {
    const s = String(search).toLowerCase();
    list = list.filter((i) => i.software_name.toLowerCase().includes(s) || (i.winget_id ?? '').toLowerCase().includes(s));
  }
  if (status === 'active') list = list.filter((i) => i.is_active);
  if (status === 'paused') list = list.filter((i) => !i.is_active);
  if (source) list = list.filter((i) => i.source_type === source);
  if (target === 'global') list = list.filter((i) => i.is_global);
  if (target === 'donor') list = list.filter((i) => i.assigned_donors?.length);
  if (target === 'ngo') list = list.filter((i) => i.assigned_ngos?.length);
  if (target === 'canary') list = list.filter((i) => i.test_device_serials?.length);
  if (target === 'unassigned')
    list = list.filter((i) => !i.is_global && !i.assigned_donors?.length && !i.assigned_ngos?.length && !i.test_device_serials?.length);
  const out = list.map(toApi);
  const sorters = {
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    priority: (a, b) => a.install_priority - b.install_priority,
    name: (a, b) => a.software_name.localeCompare(b.software_name),
    failures: (a, b) => b.stats.devices_failed - a.stats.devices_failed,
  };
  res.json({ data: out.sort(sorters[sort] ?? sorters.newest) });
});

app.get('/api/admin/softwares/:id', (req, res) => {
  const s = find(req.params.id);
  return s ? res.json({ data: toApi(s) }) : notFound(res);
});

function fromPayload(p, existing = {}) {
  const fileName = p.source_type === 'rms-repository' ? p.file_name : p.source_type === 'external_url' && p.file_url ? decodeURIComponent(new URL(p.file_url).pathname.split('/').pop()) : null;
  return {
    ...existing,
    ...p,
    winget_id: p.source_type === 'winget' ? p.winget_id : fileName,
    file_name: fileName,
    is_active: p.is_active ?? existing.is_active ?? true,
    is_portable: p.installer_type === 'Portable' || !!p.is_portable,
    timeout_minutes: p.timeout_minutes ?? limits.timeoutDefaultMinutes,
    install_priority: p.install_priority ?? existing.install_priority ?? limits.installPriorityDefault,
    success_exit_codes: p.success_exit_codes || null,
    max_retry_attempts: p.max_retry_attempts ?? null,
    min_rms_version: p.min_rms_version || null,
    assigned_donors: (p.assigned_donors ?? []).map((id) => ({ id, name: nameOf(donors, id) })),
    assigned_ngos: (p.assigned_ngos ?? []).map((id) => ({ id, name: nameOf(ngos, id) })),
    test_device_serials: [...new Set(p.test_device_serials ?? [])],
    pilot_ngos: (p.pilot_ngos ?? []).map((id) => ({ id, name: nameOf(ngos, id) })),
    pilot_donors: (p.pilot_donors ?? []).map((id) => ({ id, name: nameOf(donors, id) })),
    pilot_required_successes: p.pilot_required_successes ?? null,
    pilot_max_failures: p.pilot_max_failures ?? null,
    auto_release: p.auto_release ?? R.autoReleaseDefault,
    replaces_software_id: p.replaces_software_id != null ? String(p.replaces_software_id) : existing.replaces_software_id ?? null,
    updated_at: new Date().toISOString(),
  };
}
const INSTALL_FIELDS = ['source_type', 'file_name', 'file_url', 'winget_id', 'sha256_checksum', 'installer_type', 'silent_args', 'execution_context', 'target_install_path', 'detection_type', 'detection_path', 'success_exit_codes', 'timeout_minutes'];

function validate(p, selfId) {
  const fields = [];
  if (!p.software_name || p.software_name.trim().length < 2) fields.push({ path: 'software_name', message: 'Name is required' });
  if (live().some((s) => s.software_name.toLowerCase() === String(p.software_name).toLowerCase() && String(s.id) !== String(selfId)))
    return { status: 409, body: { error: `A software named "${p.software_name}" already exists` } };
  if (p.timeout_minutes != null && (p.timeout_minutes < limits.timeoutMinMinutes || p.timeout_minutes > limits.timeoutMaxMinutes))
    fields.push({ path: 'timeout_minutes', message: `Use ${limits.timeoutMinMinutes}–${limits.timeoutMaxMinutes} minutes` });
  if ((p.test_device_serials ?? []).length > limits.canaryMaxDevices)
    fields.push({ path: 'test_device_serials', message: `Use at most ${limits.canaryMaxDevices} pilot laptops` });
  if (p.release_now && R.requirePilot) fields.push({ path: 'release_now', message: 'A pilot is required before release (REQUIRE_PILOT=true)' });
  const groups = (p.pilot_ngos ?? []).length + (p.pilot_donors ?? []).length;
  if (!selfId && !p.release_now && !groups && !(p.test_device_serials ?? []).length)
    fields.push({ path: 'test_device_serials', message: 'Choose pilot laptops (serials) or a pilot NGO/donor group to test on first' });
  else if (!p.release_now && !groups && (p.test_device_serials ?? []).length && !DEVICE_TARGETING)
    return { status: 400, body: { error: 'Your RMS server cannot target single laptops yet. Add a pilot NGO or donor group, or deploy the server patch.' } };
  if (p.source_type === 'winget' && !p.winget_id) fields.push({ path: 'winget_id', message: 'Winget package ID is required' });
  if (p.source_type === 'rms-repository' && !p.file_name) fields.push({ path: 'file_name', message: 'Upload a file first' });
  return fields.length ? { status: 400, body: { error: 'Validation failed', fields } } : null;
}

app.post('/api/admin/softwares', (req, res) => {
  const bad = validate(req.body);
  if (bad) return res.status(bad.status).json(bad.body);
  const created = { ...fromPayload(req.body), id: Date.now(), created_at: new Date().toISOString(), created_by: DEMO_USER, deleted_at: null };
  publishScript(created);
  if (req.body.release_now) release(created, DEMO_USER);
  else startPilot(created);
  softwares.unshift(created);
  log(created.id, 'create', { source: created.source_type, file: created.winget_id });
  res.status(201).json({ data: toApi(created) });
});

app.put('/api/admin/softwares/:id', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  const bad = validate(req.body, s.id);
  if (bad) return res.status(bad.status).json(bad.body);
  const before = Object.fromEntries(INSTALL_FIELDS.map((f) => [f, String(s[f] ?? '')]));
  const next = fromPayload(req.body, { ...s });
  if (next.source_type === 'winget') next.winget_id = req.body.winget_id;
  else next.winget_id = s.winget_id; // script URL is regenerated below
  const changed = INSTALL_FIELDS.filter((f) => f !== 'winget_id' || next.source_type === 'winget').filter((f) => before[f] !== String(next[f] ?? ''));
  // Same rule as the API: RMS never re-offers a name that succeeded, so updates are a New version.
  const installedOn = new Set(history.filter((h) => h.software_name === s.software_name && h.is_successful).map((h) => h.device_id)).size + (s.demo_stats?.devices_succeeded ?? 0);
  if (changed.length && installedOn > 0)
    return res.status(409).json({
      error: `"${s.software_name}" is already installed on ${installedOn} laptop(s). Laptops never reinstall the same name, so use "New version" instead.`,
      details: { code: 'new_version_required', changed },
    });
  Object.assign(s, next);
  publishScript(s);
  if (req.body.release_now && !R.requirePilot) release(s, DEMO_USER);
  else if (changed.length) startPilot(s);
  log(s.id, 'update', { changed });
  res.json({ data: toApi(s) });
});

app.patch('/api/admin/softwares/:id/status', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  s.is_active = !!req.body.is_active;
  s.updated_at = new Date().toISOString();
  log(s.id, s.is_active ? 'activate' : 'pause');
  res.json({ data: toApi(s) });
});

app.put('/api/admin/softwares/:id/test-devices', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  const serials = [...new Set(req.body.serials ?? [])];
  if (serials.length > limits.canaryMaxDevices) return res.status(400).json({ error: `Use at most ${limits.canaryMaxDevices} canary devices` });
  s.test_device_serials = serials;
  log(s.id, 'canary', { serials });
  res.json({ data: toApi(s) });
});

app.post('/api/admin/softwares/:id/retry', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  if (!DEVICE_TARGETING)
    return res.status(409).json({
      error: 'Not needed on your RMS server: failed installs are retried automatically the next time each laptop starts RMS.',
      details: { code: 'retry_automatic' },
    });
  let serials = req.body.serial_numbers ?? [];
  if (req.body.all_failed)
    serials = latestPerDevice(s.software_name)
      .filter((h) => !h.is_successful)
      .map((h) => deviceById.get(String(h.device_id))?.serial_number)
      .filter(Boolean);
  serials = [...new Set(serials)];
  const now = new Date().toISOString();
  for (const serial of serials) {
    const ex = retries.find((r) => String(r.software_id) === String(s.id) && r.serial_number === serial);
    if (ex) ex.requested_at = now;
    else retries.push({ software_id: s.id, serial_number: serial, requested_at: now, requested_by: DEMO_USER });
  }
  log(s.id, 'retry', { count: serials.length });
  res.json({ data: { queued: serials.length, serial_numbers: serials } });
});

app.post('/api/admin/softwares/:id/verify-checksum', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  if (!s.storage_key) return res.status(400).json({ error: 'Only uploaded files can be verified' });
  s.checksum_verified_at = new Date().toISOString();
  log(s.id, 'verify', { ok: true });
  res.json({ data: { ok: true, expected: s.sha256_checksum, actual: s.sha256_checksum, expected_size: s.file_size_bytes, actual_size: s.file_size_bytes } });
});

app.delete('/api/admin/softwares/:id', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  s.deleted_at = new Date().toISOString();
  s.is_active = false;
  log(s.id, 'delete');
  res.status(204).end();
});

app.get('/api/admin/softwares/:id/client-script', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  if (!needsWrapper(s)) return res.status(404).json({ error: 'This source is delivered natively (no install script).' });
  const b = generateWrapper(s, { publicDownloadBaseUrl: PUBLIC_BASE });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Script-Url', s.client_script_url || '');
  res.setHeader('X-Script-Current', String(s.client_script_sha256 === b.sha256));
  res.send(b.content);
});
app.post('/api/admin/softwares/:id/client-script', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  publishScript(s);
  log(s.id, 'publish_script', { script: s.client_script_url });
  res.json({ data: toApi(s) });
});
app.get('/softwares/:file', (req, res) => {
  const c = scripts.get(req.params.file);
  if (!c) return res.status(404).end();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(c);
});

app.get('/api/admin/softwares/:id/rollout', (req, res) => {
  checkPilots();
  const s = find(req.params.id);
  if (!s) return notFound(res);
  const devs = pilotDevices(s);
  const listed = new Set(devs.map((d) => d.serial_number.toLowerCase()));
  const rest = (s.test_device_serials ?? []).filter((x) => !listed.has(x.toLowerCase()));
  const known = new Set(devices.map((d) => d.serial_number.toLowerCase()));
  res.json({
    data: {
      stage: s.rollout_stage || 'released',
      pilot_outcome: s.pilot_outcome ?? null,
      auto_release: s.auto_release !== false,
      is_active: !!s.is_active,
      pilot_started_at: s.pilot_started_at ?? null,
      pilot_decided_at: null,
      released_at: s.released_at ?? null,
      released_by: s.released_by ?? null,
      gate: gateOf(s),
      devices: devs,
      unregistered_serials: rest.filter((x) => !known.has(x.toLowerCase())),
      unreachable_serials: rest.filter((x) => known.has(x.toLowerCase())),
      server: { device_targeting: DEVICE_TARGETING, mode: 'env', server_patch: null },
    },
  });
});
app.post('/api/admin/softwares/:id/rollout/check', (req, res) => {
  checkPilots();
  const s = find(req.params.id);
  return s ? res.json({ data: { result: s.rollout_stage === 'released' ? 'released' : s.pilot_outcome, software: toApi(s) } }) : notFound(res);
});
app.post('/api/admin/softwares/:id/rollout/release', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  if (s.rollout_stage === 'released') return res.status(409).json({ error: 'Already released' });
  const g = gateOf(s);
  if (g.outcome !== 'passed' && !(req.body?.force && R.allowForceRelease))
    return res.status(409).json({ error: `The pilot has not passed yet (${g.succeeded}/${g.required} succeeded, ${g.failed} failed).` });
  release(s, DEMO_USER, g.outcome === 'passed' ? 'passed' : null);
  log(s.id, g.outcome === 'passed' ? 'release' : 'release_forced', { gate: g });
  res.json({ data: toApi(s) });
});
app.post('/api/admin/softwares/:id/rollout/restart-pilot', (req, res) => {
  const s = find(req.params.id);
  if (!s) return notFound(res);
  startPilot(s);
  log(s.id, 'pilot_restart');
  res.json({ data: toApi(s) });
});
// --- Laptops (same rules as src/routes/devices.js) ----------------------------
/** Live targeting for a demo software, derived from its stage (like lib/rollout.js syncLiveTargets). */
function isTargeted(sw, d) {
  if (!sw.is_active || sw.deleted_at) return false;
  const released = (sw.rollout_stage || 'released') === 'released';
  const inPilot =
    ids(sw.pilot_ngos).includes(String(d.ngo_id)) ||
    ids(sw.pilot_donors).includes(String(d.donor_id)) ||
    (DEVICE_TARGETING && (sw.test_device_serials ?? []).some((x) => x.toLowerCase() === d.serial_number.toLowerCase()));
  if (!released) return inPilot;
  return inPilot || !!sw.is_global || ids(sw.assigned_ngos).includes(String(d.ngo_id)) || ids(sw.assigned_donors).includes(String(d.donor_id));
}
function laptopSoftwares(d, onlyId) {
  return live()
    .filter((sw) => (!onlyId || String(sw.id) === String(onlyId)))
    .map((sw) => {
      const hs = history.filter((h) => h.device_id === d.id && h.software_name === sw.software_name).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const targeted = isTargeted(sw, d);
      if (!targeted && !hs.length) return null;
      return {
        software_id: String(sw.id), software_name: sw.software_name, version: sw.version ?? null, source: sw.source_type, stage: sw.rollout_stage || 'released',
        targeted, status: hs.some((h) => h.is_successful) ? 'installed' : hs.length ? 'failed' : 'waiting',
        attempts: hs.length, last_attempt_at: hs[0]?.created_at ?? null, last_history_id: hs[0]?.id ?? null,
        exit_code: hs[0]?.exit_code ?? null, error_message: hs[0]?.error_message ?? null, not_in_portal: false,
      };
    })
    .filter(Boolean);
}
function laptopRow(d, onlyId) {
  const t = laptopSoftwares(d, onlyId).filter((x) => x.targeted);
  return {
    device_id: d.id, serial_number: d.serial_number, username: d.username ?? null, location: d.location ?? null,
    ngo_name: d.ngo_id != null ? nameOf(ngos, d.ngo_id) : null, donor_name: d.donor_id != null ? nameOf(donors, d.donor_id) : null,
    rms_version: d.rms_version ?? '1.4.0', is_active: d.is_active !== false, last_seen_at: ago(d.last_seen_days_ago ?? 0.1),
    targeted: t.length, installed: t.filter((x) => x.status === 'installed').length, failed: t.filter((x) => x.status === 'failed').length,
    waiting: t.filter((x) => x.status === 'waiting').length,
    last_install_at: t.map((x) => x.last_attempt_at).filter(Boolean).sort().pop() ?? null,
  };
}
function laptopList(q) {
  let rows = devices.map((d) => laptopRow(d, q.software_id));
  if (q.search) {
    const s = String(q.search).toLowerCase();
    rows = rows.filter((r) => [r.serial_number, r.username, r.location].some((v) => (v ?? '').toLowerCase().includes(s)));
  }
  if (q.ngo_id) rows = rows.filter((r) => String(devices.find((d) => d.id === r.device_id)?.ngo_id) === String(q.ngo_id));
  if (q.donor_id) rows = rows.filter((r) => String(devices.find((d) => d.id === r.device_id)?.donor_id) === String(q.donor_id));
  const st = q.status || 'all';
  rows = rows.filter((r) => ({ all: true, complete: !r.failed && !r.waiting, waiting: r.waiting > 0, failed: r.failed > 0, not_installed: r.failed + r.waiting > 0 })[st]);
  const sort = q.sort || 'attention';
  rows.sort(
    sort === 'serial' ? (a, b) => a.serial_number.localeCompare(b.serial_number)
      : sort === 'location' ? (a, b) => String(a.location).localeCompare(String(b.location))
      : sort === 'last_seen' ? (a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at))
      : (a, b) => b.failed - a.failed || b.waiting - a.waiting || a.serial_number.localeCompare(b.serial_number),
  );
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    rows,
    summary: {
      laptops: rows.length, complete: rows.filter((r) => !r.failed && !r.waiting).length, with_waiting: rows.filter((r) => r.waiting).length,
      with_failures: rows.filter((r) => r.failed).length, installs: sum('installed'), failed_installs: sum('failed'), waiting_installs: sum('waiting'),
    },
  };
}
app.get('/api/admin/devices', (req, res) => {
  const { rows, summary } = laptopList(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(limits.historyMaxPageSize, Number(req.query.page_size) || limits.historyPageSize);
  res.json({ data: rows.slice((page - 1) * size, page * size), summary, total: rows.length, page, page_size: size });
});
app.get('/api/admin/devices/export.csv', (req, res) => {
  const cols = ['serial_number', 'username', 'location', 'ngo_name', 'donor_name', 'rms_version', 'last_seen_at', 'targeted', 'installed', 'failed', 'waiting'];
  const lines = [cols.join(','), ...laptopList(req.query).rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rms-laptops-demo.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
});
app.get('/api/admin/devices/:serial', (req, res) => {
  const d = devices.find((x) => x.serial_number === req.params.serial);
  if (!d) return res.status(404).json({ error: 'Laptop not found in RMS' });
  const softwares = laptopSoftwares(d).sort((a, b) => ({ failed: 0, waiting: 1, installed: 2 })[a.status] - ({ failed: 0, waiting: 1, installed: 2 })[b.status]);
  res.json({ data: { device: laptopRow(d), softwares, server: { device_targeting: DEVICE_TARGETING, mode: 'env', server_patch: null } } });
});

app.get('/api/admin/lookups/rms-server', (_req, res) => res.json({ data: { device_targeting: DEVICE_TARGETING, mode: 'env', server_patch: null } }));

app.get('/api/admin/softwares/:id/audit', (req, res) =>
  res.json({ data: audit.filter((a) => String(a.software_id) === String(req.params.id)).slice(0, limits.auditLogLimit) }),
);

// --- Uploads (mock bucket that mirrors the real single + multipart flow) ---
const keyFor = (f) => `${KEY_PREFIX}${f}`;
const base = (req) => `${req.protocol}://${req.get('host')}`;

app.post('/api/admin/softwares/upload-url', (req, res) => {
  const { file_name, file_size_bytes, software_id } = req.body ?? {};
  if (!fileNameRegex.test(file_name || '')) return res.status(400).json({ error: 'Rename the file: only letters, digits, . _ - are allowed' });
  if (file_size_bytes > limits.maxUploadBytes) return res.status(413).json({ error: 'File is larger than the upload limit' });
  const inUse = live().find((s) => s.source_type !== 'winget' && (s.file_name ?? s.winget_id) === file_name && String(s.id) !== String(software_id));
  if (inUse) return res.status(409).json({ error: `"${file_name}" is already used by "${inUse.software_name}".` });
  const key = keyFor(file_name);
  if (file_size_bytes < limits.multipartThresholdBytes)
    return res.json({ data: { mode: 'single', storage_key: key, url: `${base(req)}/mock-storage/${encodeURIComponent(key)}`, replaces_existing_object: objects.has(key) } });
  const partSize = Math.max(limits.multipartMinPartBytes, Math.ceil(file_size_bytes / limits.multipartMaxParts));
  res.json({
    data: {
      mode: 'multipart',
      storage_key: key,
      upload_id: crypto.randomUUID(),
      part_size: partSize,
      part_count: Math.ceil(file_size_bytes / partSize),
      replaces_existing_object: objects.has(key),
    },
  });
});

app.post('/api/admin/softwares/multipart/sign-parts', (req, res) => {
  const { storage_key, upload_id, part_numbers = [] } = req.body ?? {};
  res.json({
    data: {
      parts: part_numbers.map((n) => ({
        part_number: n,
        url: `${base(req)}/mock-storage/${encodeURIComponent(storage_key)}?uploadId=${upload_id}&partNumber=${n}`,
      })),
    },
  });
});
app.post('/api/admin/softwares/multipart/complete', (req, res) => res.json({ data: { storage_key: req.body?.storage_key, size: objects.get(req.body?.storage_key) ?? null } }));
app.post('/api/admin/softwares/multipart/abort', (_req, res) => res.status(204).end());

app.put('/mock-storage/:key', (req, res) => {
  let size = 0;
  req.on('data', (c) => (size += c.length));
  req.on('end', () => {
    const key = req.params.key;
    objects.set(key, (req.query.partNumber ? objects.get(key) ?? 0 : 0) + size);
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    res.setHeader('ETag', `"${crypto.createHash('md5').update(`${key}:${req.query.partNumber ?? 0}:${size}`).digest('hex')}"`);
    res.status(200).end();
  });
});

// --- History ---
function filteredHistory(q) {
  let rows = history.map((h) => ({ raw: h, row: historyRow(h) }));
  if (q.search) {
    const s = String(q.search).toLowerCase();
    rows = rows.filter(({ row }) =>
      [row.serial_number, row.software_name, row.error_message, row.ngo_name, row.location].some((v) => (v ?? '').toLowerCase().includes(s)),
    );
  }
  if (q.status === 'success') rows = rows.filter(({ row }) => row.is_successful);
  if (q.status === 'failed') rows = rows.filter(({ row }) => !row.is_successful);
  if (q.software_id) rows = rows.filter(({ row }) => String(row.software_id) === String(q.software_id));
  if (q.exit_code !== undefined && q.exit_code !== '') rows = rows.filter(({ row }) => String(row.exit_code) === String(q.exit_code));
  if (q.from) rows = rows.filter(({ row }) => row.created_at >= q.from);
  if (q.to) rows = rows.filter(({ row }) => row.created_at.slice(0, 10) <= q.to);
  if (q.latest_only === 'true') rows = rows.filter(({ row }) => row.is_latest);
  return rows.sort((a, b) => b.row.created_at.localeCompare(a.row.created_at));
}

app.get('/api/admin/history', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(limits.historyMaxPageSize, Number(req.query.page_size) || limits.historyPageSize);
  const rows = filteredHistory(req.query);
  res.json({ data: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => r.row), total: rows.length, page, page_size: pageSize });
});

app.get('/api/admin/history/export.csv', (req, res) => {
  const cols = ['created_at', 'serial_number', 'username', 'location', 'ngo_name', 'donor_name', 'software_name', 'is_successful', 'exit_code', 'error_message', 'diagnosis'];
  const cell = (v) => (v == null ? '' : `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`);
  const lines = [cols.join(',')];
  for (const { row } of filteredHistory(req.query).slice(0, limits.exportMaxRows))
    lines.push(cols.map((c) => cell(c === 'diagnosis' ? (row.diagnosis ? `${row.diagnosis.title}: ${row.diagnosis.hint}` : '') : row[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rms-install-history-demo.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

app.get('/api/admin/history/:id', (req, res) => {
  const h = history.find((x) => String(x.id) === String(req.params.id));
  if (!h) return res.status(404).json({ error: 'History record not found' });
  const sw = softwares.find((s) => s.software_name === h.software_name && !s.deleted_at);
  res.json({
    data: {
      ...historyRow(h),
      log_output: h.log_output ?? null,
      software_version: h.software_version ?? sw?.version ?? null,
      installer_type: sw?.installer_type ?? null,
      silent_args: sw?.silent_args ?? null,
      execution_context: sw?.execution_context ?? null,
      timeout_minutes: sw?.timeout_minutes ?? null,
      source: sw?.source_type ?? null,
      success_exit_codes: sw?.success_exit_codes ?? defaultSuccessExitCodes.join(','),
      diagnosis: h.is_successful ? null : diagnose(h.exit_code, h.error_message, h.log_output),
    },
  });
});

// Simulate a laptop reporting an attempt (handy for demos): POST /api/demo/report {serial_number, software_name, isSuccessful, exit_code, error_message, log_output}
app.post('/api/demo/report', (req, res) => {
  const b = req.body ?? {};
  const dv = devices.find((d) => d.serial_number === b.serial_number);
  if (!dv) return res.json(null);
  const row = {
    id: nextHistoryId++,
    device_id: dv.id,
    software_name: b.software_name,
    is_successful: b.isSuccessful === true || b.isSuccessful === 'true',
    created_at: new Date().toISOString(),
    error_message: b.error_message ?? null,
    exit_code: Number.isInteger(b.exit_code) ? b.exit_code : null,
    log_output: b.log_output ?? null,
  };
  history.push(row);
  res.json(row);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log('\n======================================================');
  console.log('RMS Software Portal [DEMO MODE] — in-memory, no DB/S3');
  console.log(`Seed:      ${SEED_FILE}`);
  console.log(`Listening: http://localhost:${PORT}`);
  console.log('======================================================\n');
});
