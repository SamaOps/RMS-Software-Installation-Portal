/**
 * End-to-end API test. Requires a running API (see README "Testing") pointed at a
 * database seeded with db/fixtures/legacy_schema_for_testing.sql + migrations 001 and 002 (npm run migrate),
 * and an S3-compatible endpoint (MinIO / moto).
 *
 *   API_URL=http://localhost:4100 ADMIN_USER=admin ADMIN_PASS=... node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:4100';
let token;

// Every new software must be piloted first (REQUIRE_PILOT): default the pilot to NGO 1 in tests.
const withPilot = (method, path, body) =>
  body && ['POST', 'PUT'].includes(method) && /^\/api\/admin\/softwares(\/[^/]+)?$/.test(path) &&
  !body.pilot_ngos && !body.pilot_donors && !body.release_now
    ? { pilot_ngos: [1], ...body }
    : body;

async function api(method, path, body, expect) {
  body = withPilot(method, path, body);
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (expect !== undefined) assert.equal(res.status, expect, `${method} ${path} -> ${res.status} ${text}`);
  return { status: res.status, json };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const suffix = Date.now().toString(36);

test('rejects unauthenticated + bad login', async () => {
  await api('GET', '/api/admin/softwares', null, 401);
  await api('POST', '/api/admin/auth/login', { username: 'admin', password: 'nope' }, 401);
});

test('login', async () => {
  const r = await api('POST', '/api/admin/auth/login', { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS }, 200);
  token = r.json.data.token;
  assert.ok(token);
});

test('lists legacy softwares with stats', async () => {
  const r = await api('GET', '/api/admin/softwares', null, 200);
  const chrome = r.json.data.find((s) => s.software_name === 'Google Chrome');
  assert.ok(chrome);
  assert.equal(chrome.stats.devices_attempted, 3);
  assert.equal(chrome.stats.devices_succeeded, 2);
  const f = await api('GET', '/api/admin/softwares?source=winget&status=active&target=global', null, 200);
  assert.ok(f.json.data.every((s) => s.source_type === 'winget' && s.is_global));
});

let small;
test('single-part upload -> create -> download proxy serves identical bytes', async () => {
  const buf = randomBytes(256 * 1024);
  const fileName = `AITutor-Setup-${suffix}.exe`;
  const u = await api('POST', '/api/admin/softwares/upload-url', { file_name: fileName, file_size_bytes: buf.length }, 200);
  assert.equal(u.json.data.mode, 'single');
  const put = await fetch(u.json.data.url, { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(put.status, 200);

  const donors = (await api('GET', '/api/admin/lookups/donors', null, 200)).json.data;
  const c = await api(
    'POST',
    '/api/admin/softwares',
    {
      software_name: `AI Tutor ${suffix}`,
      version: '2.1.0',
      source_type: 'rms-repository',
      file_name: fileName,
      storage_key: u.json.data.storage_key,
      file_size_bytes: buf.length,
      sha256_checksum: sha(buf),
      installer_type: 'InnoSetup',
      execution_context: 'SYSTEM',
      assigned_donors: [donors[0].id],
      test_device_serials: ['PF2X91AB'],
      detection_type: 'file_exists',
      detection_path: 'C:\\Program Files\\AI Tutor\\app.exe',
    },
    201,
  );
  small = c.json.data;
  assert.equal(small.winget_id, fileName, 'legacy client downloads /softwares/<winget_id>');
  assert.equal(small.silent_args, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-');
  assert.deepEqual(small.test_device_serials, ['PF2X91AB']);
  assert.equal(small.assigned_donors[0].name, donors[0].name);

  const dl = await fetch(`${API}/softwares/${fileName}`);
  assert.equal(dl.status, 200);
  assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(buf));
  const ranged = await fetch(`${API}/softwares/${fileName}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);

  const v = await api('POST', `/api/admin/softwares/${small.id}/verify-checksum`, null, 200);
  assert.equal(v.json.data.ok, true);
});

test('multipart upload (>100MB path) completes and matches', async () => {
  const size = 101 * 1024 * 1024;
  const buf = randomBytes(size);
  const fileName = `BigApp-${suffix}.msi`;
  const u = await api('POST', '/api/admin/softwares/upload-url', { file_name: fileName, file_size_bytes: size }, 200);
  const d = u.json.data;
  assert.equal(d.mode, 'multipart');
  const nums = Array.from({ length: d.part_count }, (_, i) => i + 1);
  const signed = (await api('POST', '/api/admin/softwares/multipart/sign-parts', { storage_key: d.storage_key, upload_id: d.upload_id, part_numbers: nums }, 200)).json.data.parts;
  const parts = [];
  for (const p of signed) {
    const chunk = buf.subarray((p.part_number - 1) * d.part_size, p.part_number * d.part_size);
    const res = await fetch(p.url, { method: 'PUT', body: chunk });
    assert.equal(res.status, 200);
    parts.push({ PartNumber: p.part_number, ETag: res.headers.get('etag') });
  }
  const done = await api('POST', '/api/admin/softwares/multipart/complete', { storage_key: d.storage_key, upload_id: d.upload_id, parts }, 200);
  assert.equal(done.json.data.size, size);
  const c = await api('POST', '/api/admin/softwares', {
    software_name: `Big App ${suffix}`, source_type: 'rms-repository', file_name: fileName, storage_key: d.storage_key,
    file_size_bytes: size, sha256_checksum: sha(buf), installer_type: 'MSI', is_global: true,
  }, 201);
  assert.equal(c.json.data.silent_args, '/qn /norestart');
});

test('validation + conflict rules', async () => {
  // duplicate name
  await api('POST', '/api/admin/softwares', { software_name: 'Google Chrome', source_type: 'winget', winget_id: 'Google.Chrome' }, 409);
  // filename already used by live software
  await api('POST', '/api/admin/softwares/upload-url', { file_name: small.file_name, file_size_bytes: 10 }, 409);
  // bad file name
  await api('POST', '/api/admin/softwares/upload-url', { file_name: '../evil.exe', file_size_bytes: 10 }, 400);
  // file_exists without path
  const r = await api('POST', '/api/admin/softwares', { software_name: `X ${suffix}`, source_type: 'winget', winget_id: 'VideoLAN.VLC', detection_type: 'file_exists' }, 400);
  assert.ok(r.json.fields.some((f) => f.path === 'detection_path'));
  // storage key traversal
  await api('POST', '/api/admin/softwares/multipart/abort', { storage_key: 'other/../x', upload_id: 'y' }, 400);
  // rename of software with history is blocked
  const list = (await api('GET', '/api/admin/softwares?search=Chrome', null, 200)).json.data[0];
  await api('PUT', `/api/admin/softwares/${list.id}`, { software_name: 'Chrome Renamed', source_type: 'winget', winget_id: 'Google.Chrome' }, 409);
});

test('winget + external_url + portable', async () => {
  const w = await api('POST', '/api/admin/softwares', {
    software_name: `Brave ${suffix}`, source_type: 'winget', winget_id: 'Brave.Brave', execution_context: 'LOGGED_IN_USER',
    assigned_ngos: [1], timeout_minutes: 20,
  }, 201);
  assert.equal(w.json.data.execution_context, 'LOGGED_IN_USER');
  const e = await api('POST', '/api/admin/softwares', {
    software_name: `Setup Script ${suffix}`, source_type: 'external_url', file_url: `https://scripts.example.org/setup-${suffix}.ps1`,
    installer_type: 'Custom',
  }, 201);
  assert.equal(e.json.data.winget_id, `setup-${suffix}.ps1`);
  const buf = randomBytes(1024);
  const fn = `Scratch-${suffix}.exe`;
  const u = (await api('POST', '/api/admin/softwares/upload-url', { file_name: fn, file_size_bytes: buf.length }, 200)).json.data;
  await fetch(u.url, { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
  const p = await api('POST', '/api/admin/softwares', {
    software_name: `Scratch ${suffix}`, source_type: 'rms-repository', file_name: fn, storage_key: u.storage_key,
    file_size_bytes: buf.length, sha256_checksum: sha(buf), installer_type: 'Portable',
  }, 201);
  assert.equal(p.json.data.is_portable, true);
  assert.equal(p.json.data.target_install_path, `C:\\Program Files\\Scratch ${suffix}`);
});

test('edit, pause, canary, retry, delete', async () => {
  const body = {
    software_name: small.software_name, version: '2.1.1', source_type: 'rms-repository', file_name: small.file_name,
    storage_key: small.storage_key, file_size_bytes: small.file_size_bytes, sha256_checksum: small.sha256_checksum,
    installer_type: 'InnoSetup', silent_args: '/VERYSILENT /DIR="C:\\AFE"', assigned_ngos: [1, 2],
  };
  const e = await api('PUT', `/api/admin/softwares/${small.id}`, body, 200);
  assert.equal(e.json.data.version, '2.1.1');
  assert.equal(e.json.data.silent_args, '/VERYSILENT /DIR="C:\\AFE"');
  assert.equal(e.json.data.assigned_ngos.length, 2);
  assert.equal(e.json.data.assigned_donors.length, 0);

  const p = await api('PATCH', `/api/admin/softwares/${small.id}/status`, { is_active: false }, 200);
  assert.equal(p.json.data.is_active, false);

  const c = await api('PUT', `/api/admin/softwares/${small.id}/test-devices`, { serials: ['PF2X91AC', '5CD1234XYZ'] }, 200);
  assert.equal(c.json.data.test_device_serials.length, 2);

  const chrome = (await api('GET', '/api/admin/softwares?search=Google Chrome', null, 200)).json.data[0];
  const rr = await api('POST', `/api/admin/softwares/${chrome.id}/retry`, { all_failed: true }, 200);
  assert.deepEqual(rr.json.data.serial_numbers, ['5CD1234XYZ']);

  await api('DELETE', `/api/admin/softwares/${small.id}`, null, 204);
  await api('GET', `/api/admin/softwares/${small.id}`, null, 404);
  const audit = await api('GET', `/api/admin/softwares/${small.id}/audit`, null, 200);
  assert.ok(audit.json.data.length >= 4);
});

test('analytics + history', async () => {
  const a = await api('GET', '/api/admin/analytics/status', null, 200);
  assert.equal(a.json.data.daily.length, a.json.data.windows.daily_days);
  assert.ok(a.json.data.fleet.success_rate > 0);
  const h = await api('GET', '/api/admin/history?status=failed&page_size=10', null, 200);
  assert.ok(h.json.data.length >= 1);
  const row = h.json.data.find((x) => x.serial_number === '5CD1234XYZ');
  assert.equal(row.ngo_name, 'NGO Dharamshala');
  assert.equal(row.location, 'Dharamshala');
  assert.ok('diagnosis' in row);
  assert.ok(row.retry_requested_at, 'retry shown as pending');
  const one = await api('GET', `/api/admin/history/${row.id}`, null, 200);
  assert.equal(one.json.data.serial_number, '5CD1234XYZ');
  const s = await api('GET', '/api/admin/history?search=PF2X91AB&latest_only=true', null, 200);
  assert.ok(s.json.data.every((x) => x.serial_number === 'PF2X91AB' && x.is_latest));
  const csv = await fetch(`${API}/api/admin/history/export.csv?status=failed`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /serial_number/);
});

test('installer defaults expose dynamic limits + exit codes', async () => {
  const d = (await api('GET', '/api/admin/lookups/installer-defaults', null, 200)).json.data;
  assert.ok(d.limits.canary_max_devices >= 1);
  assert.ok(d.limits.timeout_max_minutes >= d.limits.timeout_min_minutes);
  assert.ok(d.exit_codes['1603']);
});

test('pilot -> release rollout', async () => {
  const c = await api('POST', '/api/admin/softwares', {
    software_name: `Pilot ${suffix}`, source_type: 'winget', winget_id: 'Mozilla.Firefox', pilot_ngos: [1], is_global: true,
  }, 201);
  assert.equal(c.json.data.rollout.stage, 'pilot');
  assert.equal(c.json.data.live_is_global, false, 'not live for the fleet during the pilot');
  const st = await api('GET', `/api/admin/softwares/${c.json.data.id}/rollout`, null, 200);
  assert.ok(st.json.data.gate.total >= 1);
  await api('POST', `/api/admin/softwares/${c.json.data.id}/rollout/release`, {}, 409); // not passed yet
  const forced = await api('POST', `/api/admin/softwares/${c.json.data.id}/rollout/release`, { force: true }, 200);
  assert.equal(forced.json.data.rollout.stage, 'released');
  assert.equal(forced.json.data.live_is_global, true);
  const back = await api('POST', `/api/admin/softwares/${c.json.data.id}/rollout/restart-pilot`, null, 200);
  assert.equal(back.json.data.rollout.stage, 'pilot');
  await api('POST', '/api/admin/softwares', { software_name: `NoPilot ${suffix}`, source_type: 'winget', winget_id: 'X.Y', pilot_ngos: [], release_now: false, test_device_serials: [] }, 400);
});
