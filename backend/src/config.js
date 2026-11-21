import 'dotenv/config';
import { bool, limits } from './settings.js';

// Postgres identifiers. Mixed case (e.g. the RMS "NGOs" table) is fine: every
// identifier is double-quoted when interpolated (see lib/schema.js `q`).
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/** SQL identifiers that come from env are interpolated into queries, so they must be strict identifiers. */
function ident(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === '' || v === undefined || v === null) return null;
  if (!IDENT.test(v)) throw new Error(`${name} must be a plain SQL identifier, got "${v}"`);
  return v;
}

// Public URL of this portal (what laptops can reach). Downloads and install reports derive from it.
const portalPublicUrl = (process.env.PORTAL_PUBLIC_URL || '').replace(/\/+$/, '');
// Storage: S3/R2 when S3_BUCKET is set, otherwise this server's own disk (no cloud setup needed).
const storageDriver = (process.env.STORAGE_DRIVER || (process.env.S3_BUCKET ? 's3' : 'local')).toLowerCase();
if (!['local', 's3'].includes(storageDriver)) throw new Error(`STORAGE_DRIVER must be "local" or "s3", got "${storageDriver}"`);

export const config = {
  portalPublicUrl,
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Not needed when the API serves the built UI itself (same origin).
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),

  databaseUrl: required('DATABASE_URL'),
  databaseSsl: bool(process.env.DATABASE_SSL),
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 10),

  auth: {
    jwtSecret: required('JWT_SECRET'),
    tokenTtl: process.env.JWT_TTL || '8h',
    bcryptCost: Number(process.env.BCRYPT_COST || 12),
    // Comma-separated "username:bcryptHash" pairs. Generate with: npm run hash-password
    admins: (process.env.ADMIN_USERS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf(':');
        return { username: pair.slice(0, i), hash: pair.slice(i + 1) };
      }),
  },

  storage: {
    driver: storageDriver,
    // local driver: where files are kept (mount a persistent volume here in Docker).
    localDir: process.env.STORAGE_DIR || 'data/storage',
    // s3 driver: works for AWS S3 (leave endpoint empty) and Cloudflare R2 / MinIO (set endpoint).
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    bucket: storageDriver === 's3' ? required('S3_BUCKET') : null,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE),
    // Objects live under this prefix. Nginx maps /softwares/<file> -> <bucket>/<prefix><file>
    keyPrefix: (process.env.S3_KEY_PREFIX ?? 'softwares/').replace(/^\/+/, ''),
    presignTtlSeconds: Number(process.env.PRESIGN_TTL_SECONDS || 3600),
    maxUploadBytes: limits.maxUploadBytes,
  },

  // Public URL prefix the Windows clients use, i.e. ${BACKEND_BASE_URL}/softwares
  // Defaults to <PORTAL_PUBLIC_URL>/softwares (served by this portal); set it to a bucket/CDN URL to offload downloads.
  publicDownloadBaseUrl: (process.env.PUBLIC_DOWNLOAD_BASE_URL || (portalPublicUrl ? `${portalPublicUrl}/softwares` : '')).replace(/\/+$/, ''),

  // Optional: serve GET /softwares/:file from this service (streams from S3) as an
  // alternative to the Nginx -> S3 proxy. See integration guide.
  // Serve files from this portal: always with local storage; optional with S3 (private bucket).
  enableDownloadProxy: storageDriver === 'local' || bool(process.env.ENABLE_DOWNLOAD_PROXY),
  downloadProxyPath: '/' + (process.env.DOWNLOAD_PROXY_PATH || 'softwares').replace(/^\/+|\/+$/g, ''),

  // Existing RMS tables used for lookups. Defaults match navgurukul/windows-rms-server
  // (db/schema.js): donors.donor_name, "NGOs"."NGO_name", devices.serial_number/ngo_id/donor_id.
  tables: {
    donors: ident('DONORS_TABLE', 'donors'),
    donorName: ident('DONORS_NAME_COLUMN', 'donor_name'),
    ngos: ident('NGOS_TABLE', 'NGOs'),
    ngoName: ident('NGOS_NAME_COLUMN', 'NGO_name'),
    devices: ident('DEVICES_TABLE', 'devices'),
    deviceSerial: ident('DEVICES_SERIAL_COLUMN', 'serial_number'),
    // Optional columns on the devices table (empty = not available). RMS has no model column.
    deviceModel: ident('DEVICES_MODEL_COLUMN', ''),
    deviceUser: ident('DEVICES_USERNAME_COLUMN', 'username'),
    deviceLocation: ident('DEVICES_LOCATION_COLUMN', 'location'),
    deviceActive: ident('DEVICES_ACTIVE_COLUMN', 'isactive'),
    deviceVersion: ident('DEVICES_RMS_VERSION_COLUMN', 'rms_version'),
    // "Last seen" = latest activity row the RMS client sends (windows-rms-server laptop_tracking).
    lastSeenTable: ident('LAST_SEEN_TABLE', 'laptop_tracking'),
    lastSeenDeviceFk: ident('LAST_SEEN_DEVICE_COLUMN', 'device_id'),
    lastSeenTime: ident('LAST_SEEN_TIME_COLUMN', 'timestamp'),
    deviceNgoFk: ident('DEVICES_NGO_FK_COLUMN', 'ngo_id'),
    deviceDonorFk: ident('DEVICES_DONOR_FK_COLUMN', 'donor_id'),
  },
  allowHttpExternalUrls: bool(process.env.ALLOW_HTTP_EXTERNAL_URLS, true),
  limits,
};

if (config.auth.admins.length === 0) {
  throw new Error('ADMIN_USERS is empty. Add at least one "username:bcryptHash" (npm run hash-password).');
}
if (config.auth.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters.');
}
