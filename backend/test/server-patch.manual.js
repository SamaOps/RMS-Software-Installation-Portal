/**
 * Manual test for integration/server-patch/softwareClientRoutes.js against a database
 * seeded with db/fixtures + migration 001 + the e2e test run.
 *   cp ../integration/server-patch/softwareClientRoutes.js scr_tmp.cjs && DATABASE_URL=... node test/server-patch.manual.js
 * The patch is CommonJS (like windows-rms-server), hence the .cjs copy inside this ESM package.
 */
import express from 'express';
import pg from 'pg';
import assert from 'node:assert/strict';
import patch from '../scr_tmp.cjs';

const { createSoftwareClientRouter } = patch;
const PORT = Number(process.env.PATCH_TEST_PORT || 4300);
const BASE = process.env.PATCH_TEST_PUBLIC_BASE || 'https://rms.example.org/softwares';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use('/api/softwares', createSoftwareClientRouter({ pool, publicBaseUrl: BASE, maxAutoAttempts: 3, priorityWingetIds: ['Google.Chrome'] }));
const srv = app.listen(PORT);
const get = (q) => fetch(`http://localhost:${PORT}/api/softwares/notInstalled?${q}`).then((r) => r.json());
const names = (l) => l.map((x) => x.software_name);
const post = (b) => fetch(`http://localhost:${PORT}/api/softwares/addHistory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const NAME = 'Amazon Future Engineer';

await pool.query(`DELETE FROM software_retry_requests`);
await pool.query(`UPDATE softwares SET isactive = TRUE WHERE software_name = $1`, [NAME]);
const afeId = (await pool.query(`SELECT id FROM softwares WHERE software_name = $1`, [NAME])).rows[0].id;

// Legacy client view
let l = await get('serial_number=PF2X91AB');
assert.ok(names(l).includes(NAME));
assert.ok(!names(l).includes('Google Chrome'), 'already installed successfully -> not offered');
assert.ok(
  l.filter((x) => x.source === 'external_url').every((x) => /^https?:\/\/.+\.ps1$/i.test(x.winget_id)),
  'old clients never get a raw external_url (only portal install scripts)',
);
const afe = l.find((x) => x.software_name === NAME);
assert.equal(afe.isPortable, false);
assert.equal(afe.source, 'rms-repository');
// winget_id is either the installer file (legacy) or the portal install script that 1.4.0 clients run
assert.ok(afe.winget_id === 'Amazon-Future-Engineer-Setup-v3.exe' || /\/rms-install-[a-z0-9-]+\.ps1$/.test(afe.winget_id), afe.winget_id);
assert.ok(!('file_url' in afe), 'file_url must not hide the install script from 1.4.0 clients');
assert.equal(afe.silent_args, '/S');
assert.equal(afe.execution_context, 'LOGGED_IN_USER');
assert.equal(afe.download_url, `${BASE}/Amazon-Future-Engineer-Setup-v3.exe`);
assert.ok(Array.isArray(afe.success_exit_codes));
console.log('✓ legacy fields intact, new fields additive');

// Unknown laptop -> [] exactly like the legacy endpoint
assert.deepEqual(await get('serial_number=NOT-REGISTERED'), []);
console.log('✓ unregistered serial gets []');

// Priority ordering
await pool.query(`UPDATE softwares SET install_priority = 0 WHERE id = $1`, [afeId]);
assert.equal((await get('serial_number=PF2X91AB'))[0].software_name, NAME);
await pool.query(`UPDATE softwares SET install_priority = 100 WHERE id = $1`, [afeId]);
console.log('✓ install_priority controls order');

// Kill switch
await pool.query(`UPDATE softwares SET isactive = FALSE WHERE id = $1`, [afeId]);
assert.ok(!names(await get('serial_number=PF2X91AB')).includes(NAME));
await pool.query(`UPDATE softwares SET isactive = TRUE WHERE id = $1`, [afeId]);
console.log('✓ pause hides software immediately');

// Canary
assert.ok(!names(await get('serial_number=5CD9999QQQ')).includes(NAME));
await pool.query(`INSERT INTO software_test_devices (software_id, serial_number) VALUES ($1,'5CD9999QQQ') ON CONFLICT DO NOTHING`, [afeId]);
assert.ok(names(await get('serial_number=5CD9999QQQ')).includes(NAME));
console.log('✓ canary device receives untargeted software');

// Capability gating
await pool.query(`UPDATE softwares SET is_global = TRUE WHERE source = 'external_url' AND deleted_at IS NULL`);
assert.ok((await get('serial_number=PF2X91AB&caps=v2')).some((x) => x.source === 'external_url'));
// Old (1.4.0) clients: raw URL items are hidden, but items wrapped in a portal install script are offered.
const wrappedExt = (await pool.query(`SELECT 1 FROM softwares WHERE source = 'external_url' AND deleted_at IS NULL AND winget_id ~* '^https?://.+[.]ps1$'`)).rowCount > 0;
const oldView = (await get('serial_number=PF2X91AB')).filter((x) => x.source === 'external_url');
assert.ok(oldView.every((x) => /^https?:\/\/.+\.ps1$/i.test(x.winget_id)), 'old clients only get wrapped external_url items');
assert.equal(oldView.length > 0, wrappedExt);
await pool.query(`UPDATE softwares SET is_global = FALSE WHERE source = 'external_url'`);
console.log('✓ external_url: v2 clients get it; 1.4.0 clients only when wrapped in an install script');

// Bounded auto-retry + admin retry
for (let i = 0; i < 3; i++) {
  assert.ok(names(await get('serial_number=PF2X91AC')).includes(NAME), `attempt ${i + 1} offered`);
  const r = await post({ serial_number: 'PF2X91AC', software_name: NAME, isSuccessful: false, error_message: 'Admin rights required', exit_code: 740, log_output: 'ERROR: elevation required' });
  assert.equal(r.status, 200);
}
assert.ok(!names(await get('serial_number=PF2X91AC')).includes(NAME), 'stops after 3 failures');
await new Promise((r) => setTimeout(r, 20));
await pool.query(`INSERT INTO software_retry_requests (software_id, serial_number) VALUES ($1,'PF2X91AC')`, [afeId]);
assert.ok(names(await get('serial_number=PF2X91AC')).includes(NAME), 'admin Retry re-offers it');
assert.equal((await post({ serial_number: 'PF2X91AC', software_name: NAME, isSuccessful: 'true' })).status, 200); // legacy body
assert.ok(!names(await get('serial_number=PF2X91AC')).includes(NAME), 'installed -> no longer offered');
console.log('✓ auto-retry capped at 3, Retry button grants one more attempt, success stops it');

// Per-software retry cap overrides the default
await pool.query(`UPDATE softwares SET max_retry_attempts = 0 WHERE id = $1`, [afeId]);
await post({ serial_number: '5CD9999QQQ', software_name: NAME, isSuccessful: false });
assert.ok(!names(await get('serial_number=5CD9999QQQ')).includes(NAME), 'max_retry_attempts=0 disables auto-retry');
await pool.query(`UPDATE softwares SET max_retry_attempts = NULL WHERE id = $1`, [afeId]);
console.log('✓ per-software max_retry_attempts honoured');

// addHistory legacy shape + unknown device (legacy returned 200 + null); soft delete
const unknown = await post({ serial_number: 'NOPE', software_name: NAME, isSuccessful: true });
assert.equal(unknown.status, 200);
assert.equal(await unknown.json(), null);
const deleted = (await pool.query(`SELECT software_name FROM softwares WHERE deleted_at IS NOT NULL`)).rows.map((r) => r.software_name);
assert.ok(deleted.length > 0);
assert.ok(!(await get('serial_number=PF2X91AB&caps=v2')).some((x) => deleted.includes(x.software_name)));
console.log('✓ soft-deleted softwares never offered');
console.log('SERVER PATCH TESTS PASSED');
srv.close();
await pool.end();
