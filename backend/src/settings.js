/**
 * Runtime tunables + presets, shared by the real API (src/index.js) and the
 * offline demo (demo-server.js). Nothing in here requires a database or cloud
 * credentials, so it is safe to import anywhere.
 *
 * Every value can be changed via environment variables; data such as installer
 * presets and exit-code diagnostics lives in config/portal-presets.json.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------
export const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

export const list = (name, fallback = []) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Limits & behaviour (all env-overridable)
// ---------------------------------------------------------------------------
const timeoutMin = int('TIMEOUT_MIN_MINUTES', 2, { min: 1, max: 240 });
const timeoutMax = int('TIMEOUT_MAX_MINUTES', 30, { min: timeoutMin, max: 240 });

export const limits = {
  // Uploads
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 2 * 1024 * MB, { min: 1 }),
  multipartThresholdBytes: int('MULTIPART_THRESHOLD_BYTES', 100 * MB, { min: 5 * MB }),
  multipartMinPartBytes: int('MULTIPART_PART_SIZE_BYTES', 8 * MB, { min: 5 * MB }), // S3 minimum is 5 MB
  multipartMaxParts: int('MULTIPART_MAX_PARTS', 10_000, { min: 1, max: 10_000 }),
  multipartSignBatch: int('MULTIPART_SIGN_BATCH', 50, { min: 1, max: 100 }),
  uploadConcurrency: int('UPLOAD_CONCURRENCY', 4, { min: 1, max: 16 }),
  uploadPartRetries: int('UPLOAD_PART_RETRIES', 3, { min: 1, max: 10 }),
  hashChunkBytes: int('HASH_CHUNK_BYTES', 8 * MB, { min: 1 * MB }),

  // Execution parameters
  timeoutMinMinutes: timeoutMin,
  timeoutMaxMinutes: timeoutMax,
  timeoutDefaultMinutes: Math.min(timeoutMax, Math.max(timeoutMin, int('TIMEOUT_DEFAULT_MINUTES', 10, { min: 1, max: 240 }))),

  // Targeting / rollout
  canaryMinDevices: int('CANARY_MIN_DEVICES', 1, { min: 0 }),
  canaryMaxDevices: int('CANARY_MAX_DEVICES', 5, { min: 1, max: 500 }),
  maxAutoRetryAttempts: int('MAX_AUTO_RETRY_ATTEMPTS', 3, { min: 1, max: 50 }),
  maxRetryAttemptsCeiling: int('MAX_RETRY_ATTEMPTS_CEILING', 20, { min: 1, max: 100 }),
  installPriorityDefault: int('INSTALL_PRIORITY_DEFAULT', 100, { min: 0, max: 1000 }),
  installPriorityMax: int('INSTALL_PRIORITY_MAX', 1000, { min: 1 }),

  // Read APIs
  historyPageSize: int('HISTORY_PAGE_SIZE', 50, { min: 1, max: 1000 }),
  historyMaxPageSize: int('HISTORY_MAX_PAGE_SIZE', 200, { min: 1, max: 5000 }),
  exportMaxRows: int('EXPORT_MAX_ROWS', 50_000, { min: 1 }),
  deviceSearchLimit: int('DEVICE_SEARCH_LIMIT', 20, { min: 1, max: 500 }),
  auditLogLimit: int('AUDIT_LOG_LIMIT', 100, { min: 1, max: 5000 }),

  // Analytics windows
  analyticsDailyDays: int('ANALYTICS_DAILY_DAYS', 14, { min: 1, max: 366 }),
  analyticsErrorWindowDays: int('ANALYTICS_ERROR_WINDOW_DAYS', 30, { min: 1, max: 366 }),
  analyticsTopErrors: int('ANALYTICS_TOP_ERRORS', 5, { min: 1, max: 50 }),
  analyticsRecentHours: int('ANALYTICS_RECENT_HOURS', 24, { min: 1, max: 24 * 30 }),

  // Telemetry stored per attempt (server patch)
  maxLogBytes: int('MAX_LOG_BYTES', 256 * 1024, { min: 1024 }),
  maxErrorChars: int('MAX_ERROR_CHARS', 2000, { min: 100 }),

  // Auth
  loginRateWindowMinutes: int('LOGIN_RATE_WINDOW_MINUTES', 15, { min: 1 }),
  loginRateMax: int('LOGIN_RATE_MAX', 20, { min: 1 }),
};

// ---------------------------------------------------------------------------
// Pilot → release rollouts
// ---------------------------------------------------------------------------
const deviceTargeting = String(process.env.RMS_SERVER_DEVICE_TARGETING || 'auto').toLowerCase();
export const rollout = {
  // Every new software must pass a pilot before reaching the fleet (admins can't skip it).
  requirePilot: bool(process.env.REQUIRE_PILOT, true),
  // Default rule: release automatically when the pilot passes.
  autoReleaseDefault: bool(process.env.AUTO_RELEASE_DEFAULT, true),
  // Pilot passes when this many pilot laptops succeed (empty = all pilot laptops)…
  defaultRequiredSuccesses: process.env.PILOT_DEFAULT_REQUIRED_SUCCESSES ? int('PILOT_DEFAULT_REQUIRED_SUCCESSES', 1, { min: 1 }) : null,
  // …and no more than this many fail.
  defaultMaxFailures: int('PILOT_DEFAULT_MAX_FAILURES', 0, { min: 0 }),
  // Admin may release a failed/incomplete pilot with an explicit "release anyway".
  allowForceRelease: bool(process.env.ALLOW_FORCE_RELEASE, true),
  // How often the API checks running pilots (0 = never; evaluate on demand only).
  checkIntervalSeconds: int('ROLLOUT_CHECK_INTERVAL_SECONDS', 120, { min: 0, max: 86_400 }),
  // Count the install script's own verdict when the 1.4.0 client's timer recorded a false failure.
  trustScriptResult: bool(process.env.PILOT_TRUST_SCRIPT_RESULT, true),
  // Single-laptop (serial) pilots need the optional server patch. auto = detect via heartbeat.
  deviceTargeting: ['true', 'false'].includes(deviceTargeting) ? deviceTargeting === 'true' : 'auto',
  heartbeatMaxAgeMinutes: int('RMS_SERVER_HEARTBEAT_MAX_AGE_MINUTES', 1440, { min: 1 }),
  maxPilotGroups: int('PILOT_MAX_GROUPS', 10, { min: 1, max: 500 }),
};

// ---------------------------------------------------------------------------
// Client-compatibility install script ("wrapper") for deployed RMS clients.
//
// The RMS 1.4.0 client runs any notInstalled item whose winget_id is an
// https://…/*.ps1 URL as an elevated script and treats exit code 0 as success.
// The portal therefore generates one PowerShell script per software that applies
// every portal parameter (silent args, type, context, checksum, timeout,
// detection, success codes) and points winget_id at it. No client change needed.
// ---------------------------------------------------------------------------
export const wrapper = {
  enabled: bool(process.env.CLIENT_COMPAT_WRAPPER, true),
  sources: list('WRAPPER_SOURCES', ['rms-repository', 'external_url']),
  filePrefix: (process.env.WRAPPER_FILE_PREFIX || 'rms-install-').replace(/[^A-Za-z0-9._-]/g, ''),
  mutexName: process.env.WRAPPER_MUTEX_NAME || 'Global\\RMSPortalInstall',
  mutexWaitMinutes: int('WRAPPER_MUTEX_WAIT_MINUTES', 20, { min: 1, max: 240 }),
  downloadRetries: int('WRAPPER_DOWNLOAD_RETRIES', 3, { min: 1, max: 10 }),
  // Where the 1.4.0 client caches the serial it reports (services/metricService.js DEVICE_INFO_FILE).
  deviceInfoFile: process.env.WRAPPER_DEVICE_INFO_FILE || 'C:\\System.ServiceData\\device_info.json',
  workDir: process.env.WRAPPER_WORK_DIR || '%ProgramData%\\RMSPortal\\work',
  logTailLines: int('WRAPPER_LOG_TAIL_LINES', 80, { min: 10, max: 2000 }),
  maxReportLogChars: int('WRAPPER_MAX_REPORT_LOG_CHARS', 200_000, { min: 1000 }),
  // Public URL of POST /api/client/install-report on this portal (empty = no detailed telemetry).
  telemetryUrl:
    process.env.WRAPPER_TELEMETRY_URL ||
    (process.env.PORTAL_PUBLIC_URL ? `${process.env.PORTAL_PUBLIC_URL.replace(/\/+$/, '')}/api/client/install-report` : ''),
  // Optional shared token embedded in scripts; deters drive-by posts (scripts are public, so it is not a secret).
  reportToken: process.env.WRAPPER_REPORT_TOKEN || '',
  reportRateWindowMinutes: int('WRAPPER_REPORT_RATE_WINDOW_MINUTES', 15, { min: 1 }),
  reportRateMax: int('WRAPPER_REPORT_RATE_MAX', 600, { min: 1 }),
  // How far before/after a client history row a wrapper report may be matched to it.
  reportMatchBeforeMinutes: int('WRAPPER_REPORT_MATCH_BEFORE_MINUTES', 180, { min: 1 }),
  reportMatchAfterMinutes: int('WRAPPER_REPORT_MATCH_AFTER_MINUTES', 30, { min: 0 }),
  cacheControl: process.env.WRAPPER_CACHE_CONTROL || 'public, max-age=31536000, immutable', // names are content-hashed
};

// ---------------------------------------------------------------------------
// Presets (data file, overridable)
// ---------------------------------------------------------------------------
function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read ${label} at ${file}: ${e.message}`);
  }
}

const DEFAULT_PRESETS_FILE = path.resolve(here, '../config/portal-presets.json');
const presetsFile = process.env.PORTAL_PRESETS_FILE ? path.resolve(process.env.PORTAL_PRESETS_FILE) : DEFAULT_PRESETS_FILE;

const base = readJson(DEFAULT_PRESETS_FILE, 'default presets');
const override = presetsFile !== DEFAULT_PRESETS_FILE ? readJson(presetsFile, 'PORTAL_PRESETS_FILE') : {};

// Shallow-merge each top-level map so a custom file can add or replace single entries.
const merged = { ...base };
for (const [k, v] of Object.entries(override)) {
  merged[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && !Array.isArray(base[k]) ? { ...base[k], ...v } : v;
}
if (process.env.EXIT_CODE_HINTS_FILE) {
  merged.exit_codes = { ...merged.exit_codes, ...readJson(path.resolve(process.env.EXIT_CODE_HINTS_FILE), 'EXIT_CODE_HINTS_FILE') };
}

export const presets = Object.freeze(merged);

const envSuccessCodes = list('DEFAULT_SUCCESS_EXIT_CODES', null);
export const defaultSuccessExitCodes = (envSuccessCodes ?? presets.default_success_exit_codes ?? [0]).map(Number);

// Allowed upload/URL extensions: env override, else the union of all preset extensions.
export const allowedExtensions = (() => {
  const fromEnv = list('ALLOWED_EXTENSIONS', null);
  const all = fromEnv ?? Object.values(presets.installer_types).flatMap((t) => t.extensions ?? []);
  return [...new Set(all.map((e) => e.toLowerCase().replace(/^\./, '')))].filter((e) => /^[a-z0-9]{1,10}$/.test(e));
})();

/** File name rule for /softwares/<file> (letters, digits, . _ - and an allowed extension). */
export const fileNameRegex = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\\.(${allowedExtensions.join('|')})$`, 'i');

/** Everything the UI needs to render forms/limits; served by GET /lookups/installer-defaults. */
export function uiSettings(extra = {}) {
  return {
    installer_types: presets.installer_types,
    default_type_by_extension: presets.default_type_by_extension,
    source_types: presets.source_types,
    execution_contexts: presets.execution_contexts,
    detection_types: presets.detection_types,
    exit_codes: presets.exit_codes,
    error_patterns: presets.error_patterns,
    installer_detection: presets.installer_detection ?? null,
    default_success_exit_codes: defaultSuccessExitCodes,
    allowed_extensions: allowedExtensions,
    max_upload_bytes: limits.maxUploadBytes,
    limits: {
      timeout_min_minutes: limits.timeoutMinMinutes,
      timeout_max_minutes: limits.timeoutMaxMinutes,
      timeout_default_minutes: limits.timeoutDefaultMinutes,
      canary_min_devices: limits.canaryMinDevices,
      canary_max_devices: limits.canaryMaxDevices,
      max_auto_retry_attempts: limits.maxAutoRetryAttempts,
      max_retry_attempts_ceiling: limits.maxRetryAttemptsCeiling,
      install_priority_default: limits.installPriorityDefault,
      install_priority_max: limits.installPriorityMax,
      history_page_size: limits.historyPageSize,
      upload_concurrency: limits.uploadConcurrency,
      upload_part_retries: limits.uploadPartRetries,
      multipart_sign_batch: limits.multipartSignBatch,
      hash_chunk_bytes: limits.hashChunkBytes,
      analytics_daily_days: limits.analyticsDailyDays,
      analytics_error_window_days: limits.analyticsErrorWindowDays,
    },
    rollout: {
      require_pilot: rollout.requirePilot,
      auto_release_default: rollout.autoReleaseDefault,
      default_required_successes: rollout.defaultRequiredSuccesses,
      default_max_failures: rollout.defaultMaxFailures,
      allow_force_release: rollout.allowForceRelease,
      max_pilot_groups: rollout.maxPilotGroups,
    },
    ...extra,
  };
}
