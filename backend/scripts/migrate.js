// Applies db/migrations/*_up.sql in order, skipping ones already recorded.
// Usage: npm run migrate            (uses DATABASE_URL from .env)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: ['1', 'true'].includes(String(process.env.DATABASE_SSL)) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
const applied = new Set();
try {
  const r = await client.query('SELECT version FROM software_portal_migrations');
  r.rows.forEach((x) => applied.add(x.version));
} catch { /* table not created yet */ }

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('_up.sql')).sort()) {
  const version = file.split('_')[0];
  if (applied.has(version)) { console.log(`skip  ${file} (already applied)`); continue; }
  console.log(`apply ${file}`);
  await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
}
await client.end();
console.log('done');
