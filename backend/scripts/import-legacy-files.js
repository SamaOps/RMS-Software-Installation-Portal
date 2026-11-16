// One-time backfill after `aws s3 sync ./softwares s3://<bucket>/softwares/`:
// for every legacy rms-repository row without storage metadata, record the object's
// storage_key, size and server-computed SHA-256 so clients can verify downloads.
// Usage: npm run import-legacy            (add --dry-run to only report)
import { pool } from '../src/db.js';
import { headObject, keyFor, sha256OfObject } from '../src/storage/s3.js';

const dry = process.argv.includes('--dry-run');
const { rows } = await pool.query(
  `SELECT id, software_name, COALESCE(file_name, winget_id) AS winget_id FROM softwares
   WHERE source = 'rms-repository' AND deleted_at IS NULL AND (storage_key IS NULL OR sha256_checksum IS NULL)`,
);
console.log(`${rows.length} legacy row(s) to backfill${dry ? ' (dry run)' : ''}`);
let missing = 0;
for (const r of rows) {
  const key = keyFor(r.winget_id);
  const head = await headObject(key);
  if (!head) {
    missing++;
    console.warn(`  MISSING in bucket: ${key}  (${r.software_name}); still served from EC2 disk via the Nginx fallback`);
    continue;
  }
  if (dry) {
    console.log(`  would backfill ${r.software_name} <- ${key} (${head.size} bytes)`);
    continue;
  }
  const { sha256, size } = await sha256OfObject(key);
  await pool.query(
    `UPDATE softwares SET storage_key = $1, file_name = COALESCE(file_name, $2), file_size_bytes = $3,
            sha256_checksum = $4, checksum_verified_at = NOW(), updated_at = NOW() WHERE id = $5`,
    [key, r.winget_id, size, sha256, r.id],
  );
  console.log(`  ✓ ${r.software_name}: ${size} bytes, sha256 ${sha256.slice(0, 16)}…`);
}
console.log(missing ? `${missing} file(s) not yet in the bucket.` : 'All done.');
await pool.end();
