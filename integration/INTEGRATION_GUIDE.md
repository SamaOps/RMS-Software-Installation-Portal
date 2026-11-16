# Integration Guide: RMS Software Portal

This guide covers how to put the portal into production next to the existing `windows-rms-server`. Laptops keep downloading from the same URL as today, and nothing has to change on them.

---

## 1. What changes and what doesn't

| Piece | Change required? | Notes |
|---|---|---|
| **Windows client (`windows-rms`)** | **None** | It still calls `/api/softwares/notInstalled`, downloads `${BACKEND_BASE_URL}/softwares/<winget_id>`, and posts to `/api/softwares/addHistory`. |
| **Download URL** | **None** | Nginx now answers `/softwares/<file>` from S3/R2 instead of the EC2 disk. The path is the same. |
| **PostgreSQL** | Additive migration | New nullable columns and 3 new tables. Nothing is renamed or dropped. |
| **`windows-rms-server`** | **Optional** 1-line mount | Needed only for canary devices, the Retry button, and bounded auto-retry (§5). Pause and Delete work without it. |
| **EC2 disk / FTP / SSH** | No longer used for software | Files go browser → bucket. Old files keep working through a fallback (§4.3). |

### How compatibility is preserved

The legacy client builds its download URL from `winget_id`. For uploaded files the portal stores the **stored file name** in `winget_id`, which is exactly what the old manual SQL inserts did:

```
softwares.winget_id      = 'Amazon-Future-Engineer-Setup-v3.exe'
bucket object key        = 'softwares/Amazon-Future-Engineer-Setup-v3.exe'
client downloads         = https://rms.example.org/softwares/Amazon-Future-Engineer-Setup-v3.exe
nginx proxies to         = https://<bucket-host>/softwares/Amazon-Future-Engineer-Setup-v3.exe
```

Other rules that keep old clients safe:

- **Pause / Delete** set `isactive = false`. The existing `notInstalled` query already filters on `isactive`, so the kill switch works with **no server change**. Delete is a soft delete: `deleted_at` is set and the row is kept.
- **File names** are limited to `[A-Za-z0-9._-]` with an installer extension, so URLs never need escaping.
- **Names are unique and locked once installs exist.** Install history is keyed by `software_name`, so renaming would make every laptop reinstall.
- **A live file is never overwritten.** Uploading a name that a live software already uses is rejected, so binaries can't change underneath laptops mid-rollout. Ship a new version under a new file name (`AITutor-Setup-v2.2.exe`).
- **`external_url` items are only sent to clients that announce `caps=v2`** (§5). An old client therefore never receives a source type it doesn't understand.

### What old clients do NOT get

An unmodified client still installs uploaded files and winget packages the way it does today. These portal parameters are **stored and shown in the UI**, but laptops only act on them once they run the optional client patch (§6):

`silent_args`, `installer_type`, `execution_context` (user context), `sha256_checksum` verification, `timeout_minutes`, `detection_type`/`detection_path`, `target_install_path`, and log/exit-code reporting.

This is the trade-off for zero-touch clients: the portal fixes upload, configuration and targeting today. The silent-install failure fixes take effect laptop by laptop as the client patch rolls out.

---

## 2. Bucket setup

### AWS S3

```bash
BUCKET=rms-softwares REGION=ap-south-1
aws s3api create-bucket --bucket $BUCKET --region $REGION \
  --create-bucket-configuration LocationConstraint=$REGION

# Browser uploads need CORS, and ETag must be exposed for multipart
aws s3api put-bucket-cors --bucket $BUCKET --cors-configuration file://aws/s3-cors.json

# Clean up abandoned multipart uploads after 2 days
aws s3api put-bucket-lifecycle-configuration --bucket $BUCKET --lifecycle-configuration file://aws/lifecycle.json

# Keep previous binaries recoverable
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
```

**Read access for downloads. Pick one:**

| Option | Policy file | When to use it |
|---|---|---|
| A. Public read on `softwares/*` only | `aws/bucket-policy-public-read-prefix.json` | Same exposure as today: `/softwares/*` on EC2 is already public. Simplest. You must turn off "Block Public Access" for **bucket policies** on this bucket. |
| B. Only via your VPC endpoint | `aws/bucket-policy-ec2-only.json` | Bucket stays private. Create an S3 **Gateway VPC endpoint** for the EC2's VPC and put its `vpce-…` id in the policy. Nginx traffic then never touches the internet, and S3→EC2 transfer in the same region is free. |
| C. CloudFront + Origin Access Control | (CloudFront console) | Laptops are spread geographically, or you want to move bandwidth off EC2 completely. Point the Nginx map at the CloudFront domain. |

**Portal credentials:** attach `aws/iam-policy-portal.json` to the EC2 **instance role** and leave `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` empty. Use an IAM user with this policy only if the portal runs off AWS. The policy is limited to `softwares/*`.

### Cloudflare R2

1. Create bucket `rms-softwares`. Under **Settings → CORS policy**, paste the JSON array from `aws/s3-cors.json` (the `CORSRules` contents).
2. Create an R2 API token with **Object Read & Write** on this bucket.
3. Portal `.env`:
   ```
   S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=rms-softwares
   S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
   ```
4. For downloads, connect a custom domain to the bucket (e.g. `files.rms.example.org`) and use that host in the Nginx map. R2 has **no egress fees**, which is a good fit for fleets pulling large installers.

---

## 3. Deploy the portal

```bash
# 1. Migrate the existing database. Additive, idempotent, transactional.
pg_dump "$DATABASE_URL" -t softwares -t softwares_installed > pre-portal-backup.sql
cd backend && cp .env.example .env    # fill in the values
npm ci && npm run migrate

# 2. Create an admin login
npm run hash-password -- ganesh 'a-long-strong-password'
#    -> paste the output into ADMIN_USERS in .env (comma-separate several admins)

# 3. Build the UI (the API serves it from frontend/dist)
cd ../frontend && npm ci && npm run build

# 4. Run the API (pm2 shown; systemd or Docker also work)
cd ../backend && pm2 start src/index.js --name rms-software-portal && pm2 save
```

Use a **dedicated DB role** for the portal:

```sql
CREATE ROLE rms_portal LOGIN PASSWORD '…';
GRANT SELECT, INSERT, UPDATE ON softwares TO rms_portal;
GRANT SELECT, INSERT, DELETE ON donor_softwares, ngo_softwares, software_test_devices TO rms_portal;
GRANT SELECT, INSERT, UPDATE ON software_retry_requests, software_audit_log TO rms_portal;
GRANT SELECT ON softwares_installed, devices, donors, ngos, software_portal_migrations TO rms_portal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rms_portal;
```

If your donor, NGO or device tables have different names or columns, set `DONORS_TABLE`, `NGOS_NAME_COLUMN`, `DEVICES_MODEL_COLUMN` and the related settings in `.env`. At startup the API checks which tables and columns exist and logs any optional feature it had to switch off. It doesn't crash.

---

## 4. Nginx: keep `/softwares/<file>` working

Install `integration/nginx/rms.conf`, after replacing the domains, ports, bucket host and cert paths:

```bash
sudo cp integration/nginx/rms.conf /etc/nginx/sites-available/rms.conf
sudo ln -sf /etc/nginx/sites-available/rms.conf /etc/nginx/sites-enabled/
sudo mkdir -p /var/cache/nginx/rms-softwares
sudo nginx -t && sudo systemctl reload nginx
```

### 4.1 What the `/softwares/` block does

- Allows only `GET`/`HEAD` and installer-like names (`.exe .msi .zip .bat .cmd .ps1`). Everything else returns 404.
- Proxies to the bucket with `$uri` unchanged, so `/softwares/X` maps to key `softwares/X`.
- Strips client cookies and `Authorization`, and hides S3 headers.
- Passes `Range` through, so interrupted downloads can resume (206).
- **Caches on the EC2 disk** (`proxy_cache_lock`): when 300 laptops pull the same 800 MB installer, the bucket is read once.
- Uses 600 s timeouts for slow school connections.

### 4.2 Alternative without Nginx changes

Set `ENABLE_DOWNLOAD_PROXY=true` and route `/softwares/` to the portal (port 4000). The portal then streams from the bucket with its own credentials, supports Range, and works with a fully private bucket. It uses more Node CPU than Nginx does.

### 4.3 Migrating files already on the EC2 disk

Nginx falls back to the old `express.static('softwares')` for anything not yet in the bucket (`error_page 403 404 = @legacy_softwares_disk`), so you can migrate gradually:

```bash
aws s3 sync /path/to/windows-rms-server/softwares s3://rms-softwares/softwares/
cd backend && npm run import-legacy -- --dry-run && npm run import-legacy
```

`import-legacy` fills in `storage_key`, size and a server-computed SHA-256 for every legacy `rms-repository` row whose file is now in the bucket. After that, those rows can be checksum-verified by patched clients. When nothing is left on disk, you can remove the fallback.

---

## 4b. Install scripts for the deployed 1.4.0 client (no client update)

The portal makes every uploaded / URL software installable by the RMS 1.4.0 client already on the laptops. It does this by repointing `winget_id` at a generated PowerShell script (see the README, "Works with the RMS client already on the laptops"). Requirements:

1. `PUBLIC_DOWNLOAD_BASE_URL` = the URL laptops already use for `/softwares/` (e.g. `https://rms-api.thesama.in/softwares`). Scripts are stored in the bucket next to the installers, so the Nginx mapping above serves them unchanged.
2. Optional detailed telemetry: set `PORTAL_PUBLIC_URL` to the portal's public https URL (laptops POST to `/api/client/install-report`) and `WRAPPER_REPORT_TOKEN`. Expose only that path publicly if the admin UI is internal.
3. After `npm run migrate`, run `npm run publish-scripts -- --dry-run`, then without the flag, to convert existing rows. Rows without an `installer_type` use the extension default from the presets file (`.exe` → InnoSetup), which matches what 1.4.0 did for AI Tutor.
4. Canary first: add a test software targeted to 1–2 lab laptops, reboot them, and check Device History shows the script's exit code and transcript.

Works with the **unmodified** `windows-rms-server` (it returns `winget_id`) and with the server patch below. Rollback: `003_client_scripts_down.sql` points `winget_id` back at the installer file.

> The generated script has been reviewed for Windows PowerShell 5.1 pitfalls and its generation, publishing, serving and reporting were tested end to end. It has **not yet run on a Windows laptop** in this build, so canary it before fleet rollout.

## 5. Optional server patch: canary, Retry, bounded auto-retry

`integration/server-patch/softwareClientRoutes.js` replaces the two client-facing endpoints with versions that understand the new tables. It is **CommonJS**, like `windows-rms-server`. Copy it to `routes/softwareClientRoutes.js` and, in `server.js`, mount it **after** `app.use('/api', verifyApiKey)` (so HMAC auth still applies) and **before** the old software routes:

```js
const { createSoftwareClientRouter } = require('./routes/softwareClientRoutes');
app.use('/api/softwares', createSoftwareClientRouter({ pool }));   // pool from ./config/database
app.use('/api/softwares', softwareRoutes);                          // GET /, /assignments, /history keep working
```

Requires migrations **001 and 002**. Everything is configured with the same env vars as the portal (put them in the RMS server's `.env`), or the matching option:

| Env var | Option | Default | Purpose |
|---|---|---|---|
| `DEVICES_TABLE`, `DEVICES_SERIAL_COLUMN` | `devicesTable`, `serialColumn` | `devices`, `serial_number` | Where serials live |
| `DEVICES_DONOR_FK_COLUMN`, `DEVICES_NGO_FK_COLUMN` | `donorFkColumn`, `ngoFkColumn` | `donor_id`, `ngo_id` | Targeting join |
| `DEVICES_RMS_VERSION_COLUMN` | `rmsVersionColumn` | `rms_version` | For `min_rms_version` gating (empty = off) |
| `MAX_AUTO_RETRY_ATTEMPTS` | `maxAutoAttempts` | `3` | Fleet default; per-software `max_retry_attempts` wins |
| `INSTALL_PRIORITY_DEFAULT` | `defaultPriority` | `100` | Order of items in the response |
| `PRIORITY_WINGET_IDS` | `priorityWingetIds` | *(empty)* | Tie-breaker for equal priority. Set `Google.Chrome` to keep the legacy "Chrome first" order exactly |
| `DEFAULT_SUCCESS_EXIT_CODES` | `defaultSuccessExitCodes` | `0,3010,1641` | Sent when a software has no own list |
| `PUBLIC_DOWNLOAD_BASE_URL` | `publicBaseUrl` | *(empty)* | Builds `download_url` for uploaded files |
| `TIMEOUT_DEFAULT_MINUTES`, `MAX_LOG_BYTES`, `MAX_ERROR_CHARS` | same names in camelCase | `10`, `262144`, `2000` | Defaults and telemetry caps |

With the patch, `notInstalled` behaves like this:

| Rule | Behaviour |
|---|---|
| Legacy response fields | Identical: `software_name`, `winget_id`, `source`, `isPortable`, … New fields are only **added**. |
| Paused / deleted | Never offered. |
| Targeting | Global, OR the device's donor, OR the device's NGO, OR a **canary serial**. |
| Unregistered serial | `[]`, same as the legacy endpoint. |
| Client older than `min_rms_version` | Not offered (compares `devices.rms_version`). |
| Order | `install_priority` ascending (lower first), then `PRIORITY_WINGET_IDS`, then oldest first. Replaces the hard-coded Google.Chrome sort. |
| Never attempted | Offered. |
| Any attempt succeeded | Not offered (legacy rule). |
| Latest attempt failed | Re-offered automatically until the software's `max_retry_attempts` (or `MAX_AUTO_RETRY_ATTEMPTS`) failures, then it stops so a broken installer doesn't loop forever. |
| Admin clicked **Retry** | One more attempt for that device, even past the cap. |
| `external_url` items | Only sent to clients that pass `caps=v2`. |

`addHistory` still accepts the legacy body `{ serial_number, software_name, isSuccessful }` and returns the inserted row (or `null` for an unknown serial, as before). It also stores the optional `error_message`, `exit_code`, `log_output` (tail, `MAX_LOG_BYTES`) and `software_version`.

If you'd rather not swap the route, add these conditions to your current query instead:

```sql
AND s.deleted_at IS NULL
AND ( <your existing targeting>
      OR EXISTS (SELECT 1 FROM software_test_devices td WHERE td.software_id = s.id AND td.serial_number = $serial) )
```

---

## 6. Optional client patch: make the new parameters take effect

`integration/client-patch/installSoftware.js` is a self-contained module for the Node.js client. It:

- Calls `notInstalled` with `caps=v2`, signing requests with the server's HMAC scheme (`X-Timestamp` + `X-API-Signature`) when `RMS_API_KEY` is set. That's needed once `windows-rms-server` runs with `AUTH_ENABLED=true`.
- Downloads from `download_url`, or the legacy `/softwares/<winget_id>`, then **verifies size and SHA-256**. A mismatch is reported as "Checksum mismatch" and the file is never run.
- Builds the command from `installer_type` + `silent_args`: `msiexec /i … /L*v` for MSI, `powershell -ExecutionPolicy Bypass -File` for `.ps1`, `cmd /c` for `.bat`, and Inno `/LOG` capture.
- **SYSTEM** context: runs directly from the service. **LOGGED_IN_USER**: runs through a one-off scheduled task with an *Interactive* principal for the signed-in user (no password needed). If nobody is signed in, the install is deferred, not failed.
- Enforces `timeout_minutes` by killing the whole process tree.
- **Portable**: copies the file or expands the `.zip` to `target_install_path`, and creates a Public Desktop `.lnk`.
- **Detection**: exit code against the software's `success_exit_codes` (default `RMS_SUCCESS_EXIT_CODES`, else 0/3010/1641), `file_exists` (with `%ENV%` expansion), or `registry_key` via `reg query`.
- Laptop-side defaults are env-overridable: `RMS_DEFAULT_TIMEOUT_MINUTES`, `RMS_MAX_LOG_CHARS`, `RMS_SHARED_DIR`, `RMS_PORTABLE_ROOT`, `RMS_PRESET_ARGS_JSON`, `RMS_USER_TASK_POLL_MS`, `RMS_INSTALLER_LOG_TAIL_LINES`. Values sent by the server always win.
- Reports `exit_code`, `error_message` and the full transcript tail, which is what the portal's log viewer shows.

Roll it out like any software change: build the new client, add it in the portal as a canary to 2–3 laptops, then widen.

> This module is syntax-checked but has **not been run on Windows** in this build. Test it on canary laptops first, especially the user-context path on your Windows SKU and the winget path under SYSTEM.

---

## 7. Verification performed

All of the following were run against PostgreSQL 16 with a copy of the legacy schema, an S3-compatible mock (with real presigned URLs, multipart uploads, CORS and a bucket policy), and Nginx 1.24:

| Check | Result |
|---|---|
| Migration applies on the legacy schema, re-applies cleanly (idempotent), rolls back, re-applies | ✅ |
| Legacy query `SELECT … FROM softwares WHERE isactive = true` unchanged after migration | ✅ |
| Browser upload (3 MB, single PUT) through the UI wizard → SHA-256 computed in the browser | ✅ |
| 101 MB multipart upload via presigned part URLs → completed object size matches | ✅ |
| **Unmodified-client download**: `GET /softwares/<winget_id>` via Nginx → HTTP 200, **SHA-256 identical** to the one recorded at upload | ✅ |
| Range request → 206; second download served from the Nginx cache (`X-Cache-Status: HIT`) | ✅ |
| File only on the old EC2 disk → served through the Nginx fallback | ✅ |
| Private bucket without a policy → refused (403); with `bucket-policy-public-read-prefix.json` → allowed | ✅ |
| Path traversal / non-installer names / `PUT` on `/softwares/` → rejected | ✅ |
| Server patch: legacy fields intact, pause hides immediately, canary targeting, `external_url` only for v2 clients, auto-retry capped at 3, Retry grants one more attempt, success stops re-offers, soft-deleted never offered, legacy `addHistory` body accepted | ✅ |
| API e2e suite (auth, CRUD, conflicts, validation, canary, retry, verify-checksum, analytics, history) | 9/9 ✅ |
| UI e2e (Playwright): login, wizard upload → save, presets, user context, donor multiselect, canary warning, filters, pause toggle, validation errors, dark mode, failed-devices drill-down, log modal, Retry | ✅, 0 console errors |

**Re-verified after the dynamic-configuration update** (PostgreSQL 18, schema mirroring `windows-rms-server`'s `db/schema.js`, including the mixed-case `"NGOs"."NGO_name"`):

| Check | Result |
|---|---|
| Migrations 001 + 002 apply via `npm run migrate`; re-run skips; 002 re-applied by hand is a no-op | ✅ |
| API introspection with the default (RMS) mapping: donors, NGOs and devices enabled; `deviceModel` correctly disabled | ✅ |
| Env limits enforced end to end (`CANARY_MAX_DEVICES=3`, `TIMEOUT_MAX_MINUTES=45` reject 4 serials / 50 min) | ✅ |
| New parameters round-trip (`install_priority`, `success_exit_codes`, `max_retry_attempts`, `min_rms_version`); targeted-device count (NGO + canary) | ✅ |
| History with username/location/NGO/donor, server diagnosis, CSV export; analytics windows | ✅ |
| Server patch (CommonJS): previous checks + unknown serial → `[]`, priority order, per-software retry cap, `min_rms_version` gate, legacy `null` for unknown device | ✅ |
| Demo server + UI: login, inventory progress vs targeted devices, wizard advanced parameters and server-side limits, log viewer diagnosis, CSV export, 0 console errors | ✅ |
| Install scripts: migration 003; bulk publish (idempotent); create/edit → script uploaded (content-hashed, immutable cache) and `winget_id` repointed; duplicate-file checks still work; the 1.4.0 client's own `getScriptInfo()` picks the script from a legacy-server item; install-report endpoint (token, unknown device rejected); history/analytics merge exit code + transcript; server patch regression incl. "1.4.0 gets wrapped external_url only", no `file_url` leak | ✅ (S3 via a local mock) |
| Not run: the generated PowerShell on Windows; S3 multipart against real S3/R2; Nginx | ⚠️ |

Re-run them yourself: see "Testing" in the top-level `README.md`.

---

## 8. Rollout checklist

1. ☐ Back up `softwares` and `softwares_installed`; run `npm run migrate` (applies 001 and 002).
2. ☐ Create the bucket with CORS, lifecycle and versioning, plus the read policy (A/B/C) and the portal IAM policy.
3. ☐ `aws s3 sync` existing installers; run `npm run import-legacy`.
4. ☐ Deploy Nginx `rms.conf`. Check `curl -I https://rms.example.org/softwares/<existing-file>` returns 200 with the right `Content-Length`.
5. ☐ Start the portal and sign in. Upload a small test installer as **canary only** to one lab laptop.
6. ☐ Confirm the lab laptop installs it and the row appears under **Device History**.
7. ☐ (Optional) Mount the server patch; then pilot the client patch on canary laptops.
8. ☐ Remove FTP users and SSH keys that were only used for uploading software.
