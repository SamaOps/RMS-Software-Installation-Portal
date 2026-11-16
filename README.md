# RMS Software Portal

A standalone web portal for uploading, configuring, targeting and monitoring Windows software for the RMS fleet. It replaces SSH/FTP uploads and manual SQL inserts, and it doesn't break the existing `windows-rms` clients.

```
 Admin browser ──(1) presigned PUT / multipart──▶  S3 / R2 bucket  softwares/<file>
      │                                                   ▲
      │ (2) /api/admin/*                                   │ (4) GET /softwares/<file>
      ▼                                                   │     (Nginx proxy + cache, same URL as today)
 Portal API (Node/Express) ──▶ PostgreSQL (existing RMS DB)  ◀── windows-rms-server ◀── (3) laptops poll
                                 softwares, donor_softwares,        /api/softwares/notInstalled
                                 ngo_softwares, softwares_installed
```

## What's inside

| Path | Contents |
|---|---|
| `db/migrations/001_software_portal_up.sql` | Additive, idempotent, transactional migration (+ `_down.sql`) |
| `db/migrations/002_rollout_parameters_up.sql` | Adds `install_priority`, `success_exit_codes`, `max_retry_attempts`, `min_rms_version` (+ `_down.sql`) |
| `db/migrations/003_client_scripts_up.sql` | Install-script columns + `software_install_reports` (+ `_down.sql`, which repoints `winget_id` back to the file) |
| `backend/src/lib/wrapperScript.js` | Generates the per-software PowerShell install script that deployed 1.4.0 clients run |
| `backend/config/portal-presets.json` | **Data, not code:** installer presets, extension→type map, labels, exit-code catalog, error patterns |
| `backend/demo/seed.json` | Data for the offline demo (`npm run demo`) |
| `db/fixtures/` | Mirror of the `windows-rms-server` schema (`donors.donor_name`, `"NGOs"."NGO_name"`, …) with fictional data, **for local testing only** |
| `backend/` | Express API: JWT auth, S3/R2 storage adapter, presigned single + multipart uploads, CRUD, targeting, canary, retry, analytics, history, optional download proxy |
| `frontend/` | Vite + React + TypeScript + Tailwind UI: inventory dashboard, 3-step add/edit wizard, device history and log viewer, dark/light mode, toasts |
| `integration/INTEGRATION_GUIDE.md` | **Start here for deployment.** Bucket setup, Nginx, migration of existing files, compatibility notes, verification results |
| `integration/nginx/rms.conf` | Serves `/softwares/<file>` from the bucket, with disk cache and legacy-disk fallback, plus the portal vhost |
| `integration/aws/` | CORS, bucket policies, least-privilege IAM policy, lifecycle rule |
| `integration/server-patch/` | Optional drop-in (CommonJS) `notInstalled` / `addHistory` routes: canary, Retry, per-software auto-retry cap, install priority, min client version, logs |
| `integration/client-patch/` | Optional client module: silent args, user context, checksum, timeout, success exit codes, detection, log reporting, HMAC auth |

## Works with the RMS client already on the laptops (1.4.0)

The deployed client ignores the portal's parameters for raw installers, and crashes on non-InnoSetup EXE/MSI files (an undefined `silentArgs`). But it **does** run any `winget_id` that is an `https://…/*.ps1` URL as an elevated script. So for every uploaded or URL software, the portal:

1. **generates a PowerShell install script** from the software's parameters. The script: downloads the installer; checks size and SHA-256; runs it by type (Inno/NSIS/EXE, `msiexec` for MSI, `.ps1`, `.bat`/`.cmd`, portable copy or `.zip` extraction plus shortcut); runs as SYSTEM-elevated or as the logged-in user; enforces the timeout; checks file/registry detection (skips if already installed); applies the success exit codes; and holds a machine-wide lock so installs never overlap;
2. **uploads it next to the installers** (`/softwares/rms-install-<name>-<hash>.ps1`; content-hashed, so caches never serve a stale script) and **points `winget_id` at it**;
3. receives the script's **detailed result** (exit code, error, transcript) at `POST /api/client/install-report` and shows it in Device History next to the client's plain success/failure.

This happens automatically on every save. For existing rows run `npm run publish-scripts` (`--dry-run` first). Inventory → ⋯ → **View install script** shows exactly what laptops run. Winget software is left as is (the client handles winget natively). Switch off with `CLIENT_COMPAT_WRAPPER=false`.

**1.4.0 limits that remain:** laptops check only when RMS starts (reboot). The client reads the result once, after 5 min × pending items. A slower install is recorded as failed, then re-checked at the next start (the script's own report shows the real outcome).

## Configuration: nothing is hard-coded

| What | Where |
|---|---|
| Limits and behaviour (timeouts, canary size, retry caps, priorities, page sizes, upload tuning, analytics windows, rate limits…) | Env vars, all listed with defaults in `backend/.env.example`. The UI reads them from `GET /api/admin/lookups/installer-defaults`. |
| Installer presets, silent flags, extension→type map, labels, exit-code hints, error patterns | `backend/config/portal-presets.json`. Replace with `PORTAL_PRESETS_FILE`, or extend exit codes with `EXIT_CODE_HINTS_FILE`. |
| RMS table and column names | `DONORS_*`, `NGOS_*`, `DEVICES_*`. Defaults match `windows-rms-server`; missing optional columns are detected at startup and the feature degrades. |
| Laptop-side defaults (client patch) | `RMS_*` env vars on the laptop; values sent by the server win. |

## Features

**Inventory dashboard**
- Header stats: softwares managed, active deployments, fleet success rate, and failed installs needing attention (click through to the failing devices).
- Search by name or winget ID / file name. Filter by source, target and status.
- Table with icon, version and type, source badge, assignment badges, a rollout bar against the devices actually targeted ("850 / 920 installed, 12 failed, 58 pending"), an active switch, and an actions menu (Edit, Canary test, View device logs, Retry all failed, Verify checksum, Delete).

**Add / edit wizard**
1. **Source**: upload a file (drag-and-drop, direct-to-bucket, live progress, SHA-256 computed in the browser while uploading, multipart above 100 MB, up to 2 GB), a winget ID, or an external script URL. Then name, version and notes.
2. **Execution**: installer presets (from the presets file) that fill in silent args, editable args with a reset button, SYSTEM vs logged-in user, portable folder and shortcut, a timeout slider (`TIMEOUT_MIN/MAX_MINUTES`), and success detection (exit code, file, or registry). **Advanced rollout parameters**: success exit codes, install priority, automatic-retry cap, and a minimum RMS client version.
3. **Targeting**: global, donor and NGO searchable multi-selects, up to `CANARY_MAX_DEVICES` canary serials (checked against RMS devices), active or paused, and a summary of the exact command that will run.

**Device history**
- Serial, laptop model / NGO, software, status, timestamp, error and exit code.
- Filter by search, software, status, date range, and latest-attempt-only.
- Click any row to open the log viewer: raw transcript with errors highlighted, a server-side diagnosis (exit-code catalog + error patterns from the presets file), copy log, and **Retry deployment**.
- **Export CSV** of the filtered history (audit report), capped at `EXPORT_MAX_ROWS`.

**Safety rails**
- Live binaries can't be overwritten.
- Names are unique and locked once installs exist, because history is keyed by name.
- Strict file-name and storage-key validation (no traversal).
- Server-side size check when saving, plus on-demand server-side SHA-256 re-verification.
- Soft delete; the file is kept in storage.
- Audit log of every admin action.
- Login rate limiting with bcrypt + JWT.

 ## Quick start (local)

```bash
# Postgres with your RMS schema (or db/fixtures/legacy_schema_for_testing.sql for a demo)
psql "$DATABASE_URL" -f db/fixtures/legacy_schema_for_testing.sql   # demo only

cd backend
cp .env.example .env            # set DATABASE_URL, JWT_SECRET, S3_*, ADMIN_USERS
npm install
npm run migrate                 # applies 001, 002, 003
npm run publish-scripts -- --dry-run   # then without --dry-run: install scripts for existing software
npm run hash-password -- admin 'choose-a-strong-password'   # paste into ADMIN_USERS
npm run dev                     # API on :4000

cd ../frontend
npm install
npm run dev                     # UI on :5173 (proxies /api to :4000)
```

For local S3, run MinIO (`S3_ENDPOINT=http://localhost:9000`, `S3_FORCE_PATH_STYLE=true`) and apply `integration/aws/s3-cors.json` to the bucket.

Production: `npm run build` in `frontend/`. The API then serves `frontend/dist` itself, so you run a single Node process behind Nginx (see the integration guide), or use the `Dockerfile`.

## API

All routes need `Authorization: Bearer <token>` from `POST /api/admin/auth/login`.

| Method & path | Purpose |
|---|---|
| `POST /api/admin/softwares/upload-url` | `{file_name, file_size_bytes, software_id?}` → `{mode:'single', url}` or `{mode:'multipart', upload_id, part_size, part_count}` |
| `POST /api/admin/softwares/multipart/sign-parts` · `/complete` · `/abort` | Multipart flow |
| `GET /api/admin/softwares?search=&source=&target=&status=` | List with per-device install stats and assignments |
| `GET /api/admin/softwares/:id` | One software |
| `POST /api/admin/softwares` | Create with all parameters + donors/NGOs/canary |
| `PUT /api/admin/softwares/:id` | Edit parameters + targeting |
| `PATCH /api/admin/softwares/:id/status` | `{is_active}` kill switch |
| `PUT /api/admin/softwares/:id/test-devices` | `{serials}` canary devices |
| `POST /api/admin/softwares/:id/retry` | `{serial_numbers}` or `{all_failed:true}` |
| `POST /api/admin/softwares/:id/verify-checksum` | Re-hash the stored object server-side |
| `DELETE /api/admin/softwares/:id` | Soft delete (also deactivates) |
| `GET /api/admin/softwares/:id/audit` | Admin action history |
| `GET /api/admin/analytics/status` | Inventory counts, fleet success rate, 14-day series, top errors |
| `GET /api/admin/softwares?…&sort=newest\|priority\|name\|failures` | Sorting |
| `GET /api/admin/history?search=&status=&software_id=&ngo_id=&donor_id=&exit_code=&from=&to=&latest_only=&page=` | Install attempts, each with a `diagnosis` |
| `GET /api/admin/history/export.csv?<same filters>` | Downloadable audit report |
| `GET /api/admin/history/:id` | One attempt including `log_output` and `diagnosis` |
| `GET /api/admin/lookups/donors` · `/ngos` · `/devices?search=` · `/installer-defaults` · `/exit-codes` | Form data, presets, limits |
| `GET /api/admin/softwares/:id/client-script` · `POST` same | Preview / (re)publish the generated install script |
| `POST /api/client/install-report` *(public, rate-limited)* | Detailed result posted by install scripts |

The full software payload, with validation rules, is in `backend/src/lib/validation.js`.

## Offline demo

```bash
cd backend && npm run demo        # API on :4000 (DEMO_PORT), any login works, data from demo/seed.json
cd frontend && npm run dev        # UI on :5173
```

The demo uses the same `settings.js` and presets file as the real API, so limits and presets behave identically.

## Testing

```bash
# API end-to-end (needs a running API on a DB seeded with the fixture + migration, and an S3-compatible endpoint)
cd backend && API_URL=http://localhost:4100 ADMIN_USER=admin ADMIN_PASS=… npm test

# Server patch behaviour
cp ../integration/server-patch/softwareClientRoutes.js scr_tmp.cjs
DATABASE_URL=… node test/server-patch.manual.js && rm scr_tmp.cjs
```

## Design notes and known limits

- **Real RMS schema names:** `donors.donor_name`, `"NGOs"."NGO_name"`, `softwares.isactive`, `softwares_installed.issuccessful`. These are the defaults. The `devices` table has no model column, so the UI shows username and location instead.
- **Install history is matched by `software_name`**, because the legacy `softwares_installed` has no `software_id`. That's why renaming is blocked once history exists. To push a new major version to devices that already have the old one, add it as a new entry (e.g. "AI Tutor 2.2") and pause the old one.
- **Old clients ignore the new execution parameters** until they run the client patch. Upload, targeting, pause and analytics work immediately. See the integration guide, §1.
- Sessions use `sessionStorage`, so closing the tab signs you out. Admin accounts live in `ADMIN_USERS`. Swap `src/auth.js` for SSO (e.g. Google Workspace OIDC) if you need per-person accounts at scale.
