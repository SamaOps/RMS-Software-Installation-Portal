# RMS Software Portal

Upload a software once, **test it on a few laptops, then install it on every laptop that runs RMS**, from a web page. No EC2, SSH, FTP, SQL or AWS console. Works with the RMS server and the RMS client (1.4.0) exactly as they are deployed today. Setup needs **four settings**.

```
 Admin (browser) ──► Portal (UI + API + file storage, one Node service)
                       │ /softwares/… (installers + scripts)   │ software + live targeting
                       ▼                                       ▼
          Laptop downloads over HTTPS                   RMS PostgreSQL ◄── windows-rms-server (unchanged)
                       ▲                                                   ▲ notInstalled / addHistory
                       └──────────── Laptop: RMS client 1.4.0 (unchanged) runs the install script
```

**Start here for deployment and the full design:** [`integration/INTEGRATION_GUIDE.md`](integration/INTEGRATION_GUIDE.md).

## How a release works

1. **Add software**: drop a file (`.exe .msi .zip .ps1 .bat .cmd`, up to 2 GB, with an in-browser SHA-256), or enter a winget ID or URL. Name and version are suggested from the file name.
2. **Install settings**: the portal **detects the installer type from the file** (Inno Setup, NSIS, MSI, WiX, InstallShield, Advanced Installer, Squirrel) and fills in the silent arguments. Everything else (install location, SYSTEM or logged-in user, timeout, detection, exit codes) has good defaults under *More install options*.
3. **Test & release**:
   - **Pilot**: a lab NGO/donor group (and serials, if the server patch is present). On save it installs **only** there.
   - **Release to**: all laptops, or donors / NGOs.
   - **Rule**: "N pilot laptops succeed, at most M fail". It releases automatically when the rule passes, or waits for your click.
4. **Laptops**: every RMS laptop with what it has **installed**, what **failed** and what is still **waiting**, plus RMS version and last seen. Filter by NGO, donor, software or status, click a laptop for its full software list and logs, and export CSV. Click any software's install bar in the inventory to see exactly which laptops still miss it. The status uses the same rules as the RMS server, so "waiting" is exactly what each laptop will install at its next start.
5. **Watch**: Inventory shows each software's stage (`Pilot 3/5`, `Pilot failed`, `Released`, `Paused`). **Pilot & release** lists every pilot laptop's result. **Device History** shows each attempt with the exit code, a plain-English diagnosis and the install log, plus CSV export.
6. **Update**: **New version** copies the settings into a new entry and pilots it. The old version is paused automatically when the new one is released. RMS tracks installs by name, so updates are never done in place once installed.

**Pause** removes a software from every laptop's list at any stage.

## Design in one paragraph

The portal owns two target sets per software (pilot and release) and **writes the tables `windows-rms-server` already reads** (`softwares.is_global`, `donor_softwares`, `ngo_softwares`) from the rollout stage. For uploaded and URL software it generates **one PowerShell install script** that applies every setting, stores it in the bucket, and puts its URL in `winget_id`. The 1.4.0 client runs any `.ps1` URL as an elevated script, so no client or server change is needed. The script reports its exit code and log back to the portal. The **optional server patch** adds single-laptop pilots, Retry, install priority, a retry limit and a minimum client version. The portal detects it and only shows those options when it is present.

## What's inside

| Path | Contents |
|---|---|
| `backend/src/` | Express API: auth, uploads (presigned / multipart), software CRUD, rollout engine (`lib/rollout.js`), install-script generator (`lib/wrapperScript.js`), history, analytics, install-report endpoint |
| `backend/config/portal-presets.json` | **Data, not code**: installer presets and install-location switches, extension→type map, labels, exit-code catalog, error patterns |
| `backend/.env.example` | The 4 settings you need |
| `docs/CONFIGURATION.md` | Every optional setting with its default (you rarely need any) |
| `frontend/` | Vite + React + TypeScript + Tailwind UI |
| `db/migrations/` | 001–004, additive and idempotent, each with a `_down.sql` |
| `db/fixtures/` | Mirror of the `windows-rms-server` schema with fictional data, **for local testing only** |
| `integration/INTEGRATION_GUIDE.md` | Architecture, deployment, migrating existing software, canary, limits, verification, rollback |
| `integration/aws/` | Only for the optional S3 mode: bucket CORS, read policies, least-privilege IAM, lifecycle |
| `integration/server-patch/` | **Optional** drop-in for `windows-rms-server` (single-laptop pilots, Retry, priority, limits) |
| `integration/nginx/rms.conf` | **Optional**: only to keep legacy EC2-disk files served at `/softwares/` before migrating them |
| `backend/demo-server.js` + `backend/demo/seed.json` | Offline demo (no DB/S3), using the same presets and rules as the API |

## Configuration: nothing hard-coded

| What | Where |
|---|---|
| Required: database, public URL, login | `backend/.env.example` (4 values) |
| Optional behaviour (release rule defaults, limits, storage, S3, analytics…) | `docs/CONFIGURATION.md`; all have defaults; the UI reads them from the API |
| Installer presets, detection signatures, install-location switches, exit-code hints | `backend/config/portal-presets.json` (data, not code) |
| RMS table and column names | `DONORS_*`, `NGOS_*`, `DEVICES_*` (defaults match `windows-rms-server`; missing optional columns are detected) |
| What the RMS server supports | Detected from the server patch heartbeat (`RMS_SERVER_DEVICE_TARGETING=auto`) |

## Quick start (local)

```bash
psql "$DATABASE_URL" -f db/fixtures/legacy_schema_for_testing.sql   # test schema only
cd backend && cp .env.example .env    # DATABASE_URL, PORTAL_PUBLIC_URL, JWT_SECRET, ADMIN_USERS
npm install && npm run migrate        # 001–004
npm run hash-password -- admin 'choose-a-strong-password'   # paste into ADMIN_USERS
npm run dev                           # API on :4000
cd ../frontend && npm install && npm run dev                 # UI on :5173 (proxies /api)
```

Files are stored on the portal's disk (`backend/data/storage`) unless `S3_BUCKET` is set.
Offline demo instead: `cd backend && npm run demo` (any login works; `DEMO_DEVICE_TARGETING=true` simulates the server patch).
Production: `npm run build` in `frontend/`; the API serves `frontend/dist`, or use the `Dockerfile`.

## API

All `/api/admin/*` routes need `Authorization: Bearer <token>` from `POST /api/admin/auth/login`.

| Method & path | Purpose |
|---|---|
| `POST /api/admin/softwares/upload-url` (+ `/multipart/*` with S3) · `PUT /api/storage/upload` (signed, portal disk) | Uploads |
| `GET /softwares/:file` *(public)* | Installers and install scripts for laptops |
| `GET /api/admin/softwares?search=&source=&target=&status=&stage=&sort=` | Inventory with stats and rollout stage |
| `GET` · `PUT` · `DELETE /api/admin/softwares/:id` | One software (PUT refuses installer changes once installed → New version) |
| `POST /api/admin/softwares` | Create (starts the pilot; `replaces_software_id` for a new version) |
| `PATCH /api/admin/softwares/:id/status` | `{is_active}`: pause removes it from every laptop |
| `GET /api/admin/softwares/:id/rollout` | Pilot laptops, results, release rule |
| `POST /api/admin/softwares/:id/rollout/check` · `/release` (`{force}`) · `/restart-pilot` | Evaluate now, release, back to pilot |
| `GET` · `POST /api/admin/softwares/:id/client-script` | Preview / republish the install script |
| `POST /api/admin/softwares/:id/verify-checksum` · `GET …/audit` | Re-hash stored file · admin action history |
| `POST /api/admin/softwares/:id/retry` · `PUT …/test-devices` | Server patch only (otherwise failed installs retry at the next start) |
| `GET /api/admin/devices?search=&ngo_id=&donor_id=&software_id=&status=&sort=` · `/devices/export.csv` · `/devices/:serial` | Laptops: installed / failed / waiting per laptop, summary counts, per-laptop detail |
| `GET /api/admin/history` · `/history/export.csv` · `/history/:id` | Install attempts with diagnosis and log |
| `GET /api/admin/analytics/status` | Inventory counts, success rate, daily series, top errors |
| `GET /api/admin/lookups/donors` · `/ngos` · `/devices` · `/installer-defaults` · `/exit-codes` · `/rms-server` | Form data, presets, limits, server capabilities |
| `POST /api/client/install-report` *(public, rate-limited, token)* | Detailed result from install scripts |

## Testing

```bash
cd backend && API_URL=http://localhost:4100 ADMIN_USER=admin ADMIN_PASS=… npm test     # API e2e (DB + S3-compatible endpoint)
cp ../integration/server-patch/softwareClientRoutes.js scr_tmp.cjs && DATABASE_URL=… node test/server-patch.manual.js; rm scr_tmp.cjs
```

## Known limits (from the deployed RMS client)

- Laptops check for new software only when RMS starts.
- The client records the result once, 5 min × pending items after start. The install script's own report shows the real outcome, and the release rule trusts it.
- RMS tracks installs by **name**: updates are a **New version**, and renaming is blocked once installs exist.
- Without the server patch, pilots are by NGO/donor group (tip: a "RMS Lab" NGO with your test laptops).
- Sessions use `sessionStorage`. Admin accounts live in `ADMIN_USERS`; swap `src/auth.js` for SSO if needed.
