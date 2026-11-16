// Generates + uploads the install script for every live uploaded/URL software and points
// winget_id at it, so deployed RMS 1.4.0 clients install it with the portal's parameters.
// Run after `npm run migrate` (and `npm run import-legacy` for files copied from EC2).
//
// Usage: npm run publish-scripts               (all eligible rows)
//        npm run publish-scripts -- --dry-run  (show what would change)
//        npm run publish-scripts -- --id 12    (one software)
import { pool, tx } from '../src/db.js';
import { introspect } from '../src/lib/schema.js';
import { publishClientScript, buildForRow } from '../src/lib/clientScripts.js';
import { wrapper } from '../src/settings.js';

const dry = process.argv.includes('--dry-run');
const idArg = process.argv.indexOf('--id');
const onlyId = idArg > -1 ? process.argv[idArg + 1] : null;

await introspect();
if (!wrapper.enabled) {
  console.log('CLIENT_COMPAT_WRAPPER=false: nothing to do.');
  process.exit(0);
}
const { rows } = await pool.query(
  `SELECT * FROM softwares WHERE deleted_at IS NULL AND source = ANY($1::text[]) ${onlyId ? 'AND id::text = $2' : ''} ORDER BY id`,
  onlyId ? [wrapper.sources, onlyId] : [wrapper.sources],
);
console.log(`${rows.length} software(s) eligible${dry ? ' (dry run)' : ''}`);
let failed = 0;
for (const row of rows) {
  try {
    if (dry) {
      const b = buildForRow(row);
      const same = row.client_script_sha256 === b.sha256;
      console.log(`  ${same ? '=' : '~'} ${row.software_name}: ${b.fileName}${row.installer_type ? '' : '  (no installer_type set: using the extension default)'}`);
      continue;
    }
    const out = await tx((db) => publishClientScript(db, row.id));
    console.log(`  ✓ ${row.software_name} -> ${out?.url ?? '(native)'}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${row.software_name}: ${e.message}`);
  }
}
await pool.end();
if (failed) process.exitCode = 1;
