# RMS Software Portal: architecture & deployment guide

One goal: **upload a software once, test it on a few laptops, then install it on every RMS laptop**, without anyone touching EC2, SSH, FTP or SQL.

---

## 1. Architecture

```
 Admin (browser)
      │ upload installer / winget ID / URL · choose pilot + release targets
      ▼
 ┌─────────────────────────── Portal (one Node service) ───────────────────────────┐
 │ UI + API │ Release engine (pilot → release) │ Install-script generator │ Reports │
 └─────┬──────────────────────────────┬─────────────────────────────────────┬──────┘
       │ installers + scripts         │ software + live targeting           │ detailed results
       ▼                              ▼                                     ▲
  Portal disk (or S3/R2)       RMS PostgreSQL (existing)          POST /api/client/install-report
       ▲                              ▲
       │ direct HTTPS download        │ reads targeting (unchanged)
       │                       windows-rms-server  ── GET /api/softwares/notInstalled
       │                              ▲               POST /api/softwares/addHistory
       └──────────────  Laptop: RMS client 1.4.0 (unchanged) runs the install script
```

| Component | Responsibility | Change to RMS? |
|---|---|---|
| Portal UI + API | Add software, install settings, pilot/release targets, rollout panel, history | — |
| Storage | Installers + generated install scripts on the portal's disk (default) or S3/R2; laptops download over HTTPS | — |
| Release engine | Keeps pilot + release targets and **writes the live targeting tables from the stage** | none: the server only reads them |
| Install script | The single install engine on the laptop: download, SHA-256, silent install by type, install location, SYSTEM/user, timeout, detection, success codes, one install at a time, report | none: 1.4.0 already runs `.ps1` URLs |
| Reports | RMS `addHistory` (success/failure) + the script's exit code, error and log | none |
| `windows-rms-server` | Unchanged. Tells each laptop what to install | **none** |
| `windows-rms` client 1.4.0 | Unchanged. Runs the script, records the result | **none** |

### Why this works with the existing RMS code

- **Targeting**: `models/softwareModel.js` offers a software when `is_global` is true, or the laptop's donor/NGO is in `donor_softwares`/`ngo_softwares`, and it was never installed successfully **under that name**. No RMS code writes these tables, so the portal owns them.
- **Delivery**: the 1.4.0 client runs any `winget_id` that is an `https://…/*.ps1` URL as an elevated script (`getScriptInfo` + `installScriptFileViaTask`) and treats exit code 0 as success. The portal stores the generated script's URL there. That URL points at the portal itself (or a bucket), so **no Nginx or EC2 change is needed**.
- Verified by running the real `softwareModel.js` (local UAT branch and GitHub `main`) against the portal's database (§8).

---

## 2. Release lifecycle

```
 add ──► PILOT ──(rule passes)──► RELEASED ──► (new version) ──► next entry … old one paused
          │  ▲                       │
          │  └──── Stop release ─────┘
          └─(too many failures)─► stays on PILOT (fix → pilot restarts)
 Pause / Delete at any stage ──► removed from every laptop's list
```

| Stage | Live targeting the RMS server sees |
|---|---|
| Pilot | pilot NGO/donor groups (+ pilot serials if the server patch is present) |
| Released | release targets (global / donors / NGOs) + pilot groups |
| Paused / deleted | nothing, so it works even on RMS versions that ignore `isactive` |

**Release rule** (per software, defaults from `.env`): *N pilot laptops succeed (default: all) and at most M fail (default 0)*. A background check (`ROLLOUT_CHECK_INTERVAL_SECONDS`) releases automatically when it passes, or waits for one click if auto-release is off. **Release anyway** exists for emergencies (`ALLOW_FORCE_RELEASE`) and is audited.

**Updates are new versions.** RMS remembers installs by software name and never re-offers a name that succeeded. So once a software is installed anywhere, its installer can't be changed in place (the API refuses it). Use **New version**: it copies every setting into "Name 1.2.1", pilots it, and **pauses the old entry automatically when the new one is released**. While nothing is installed yet, editing the installer simply restarts the pilot.

---

## 3. Where files are stored

| Mode | Setup | When |
|---|---|---|
| **Portal disk (default)** | Nothing. Uploads stream to `STORAGE_DIR` (`backend/data/storage`; a Docker volume) and laptops download from `<PORTAL_PUBLIC_URL>/softwares/…` | Most fleets. No AWS console, no bucket, no Nginx |
| S3 / R2 (optional) | Set `S3_BUCKET` (+ region or endpoint and keys). Apply `aws/s3-cors.json` for browser uploads; optionally make `softwares/*` public or put CloudFront in front and set `PUBLIC_DOWNLOAD_BASE_URL` to it | Very large fleets or installers, CDN, or you don't want files on the portal host |

`integration/aws/` (CORS, policies, IAM, lifecycle) and `integration/nginx/rms.conf` are only needed for the optional S3 mode or to keep serving legacy EC2-disk files at the old path.

## 4. Deploy the portal (one time)

```bash
pg_dump "$DATABASE_URL" -t softwares -t softwares_installed -t donor_softwares -t ngo_softwares > pre-portal-backup.sql
cd backend && cp .env.example .env          # 4 values: DATABASE_URL, PORTAL_PUBLIC_URL, JWT_SECRET, ADMIN_USERS
npm ci && npm run migrate                   # 001–004, additive + idempotent; run with a role that can ALTER tables
npm run hash-password -- <admin> '<long-password>'   # paste into ADMIN_USERS
cd ../frontend && npm ci && npm run build   # the API serves frontend/dist
cd ../backend && npm start                  # or the Dockerfile / pm2 / systemd
```

Runtime DB role (least privilege):

```sql
CREATE ROLE rms_portal LOGIN PASSWORD '…';
GRANT SELECT, INSERT, UPDATE ON softwares TO rms_portal;
GRANT SELECT, INSERT, DELETE ON donor_softwares, ngo_softwares, software_test_devices, software_targets TO rms_portal;
GRANT SELECT, INSERT, UPDATE, DELETE ON software_retry_requests TO rms_portal;
GRANT SELECT, INSERT ON software_audit_log, software_install_reports TO rms_portal;
GRANT SELECT ON softwares_installed, devices, donors, "NGOs", rms_server_heartbeat, software_portal_migrations TO rms_portal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rms_portal;
```

Table and column names default to the `windows-rms-server` schema. Override them with `DONORS_*`, `NGOS_*`, `DEVICES_*` if yours differ. The API checks at startup and logs any optional feature it had to switch off.

`PORTAL_PUBLIC_URL` must be reachable from the laptops: they download `/softwares/…` and post results to `/api/client/install-report` there. If the admin UI should stay internal, expose only those two paths publicly. Every other setting is optional ([`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md)).

---

## 5. Move existing software onto the portal

```bash
# copy files currently on the EC2 disk into the portal's storage (once):
#   portal disk: copy them into backend/data/storage/softwares/   ·   S3: aws s3 sync … s3://<bucket>/softwares/
npm run import-legacy -- --dry-run && npm run import-legacy                       # record size + SHA-256
npm run publish-scripts -- --dry-run && npm run publish-scripts                    # install scripts; winget_id -> script URL
```

Existing rows are migrated as **released** with their current targets, so nothing changes in the field. After `publish-scripts`, laptops get every uploaded software through its install script, and the EC2 disk is no longer used.

---

## 6. First release (canary)

1. In RMS, create an NGO such as **"RMS Lab"** and move 2–5 test laptops into it once. That NGO is your pilot group for every release.
2. In the portal, add a small test installer with pilot NGO = RMS Lab and release targets as needed. Rule: all succeed.
3. Restart the test laptops (RMS checks at startup). In **Pilot & release**, watch each laptop. In **Device History**, read the exit code and log.
4. On a pass it releases automatically. From then on, every release follows the same flow.

**Check on the canary laptops:** the 1.4.0 client downloads the script with Windows PowerShell 5.1. On some Windows 10 builds it doesn't use TLS 1.2 by default, and S3/CloudFront require TLS 1.2. If the script download fails with an SSL/TLS error, enable strong crypto for .NET on those laptops (`SchUseStrongCrypto=1`) or use option D in §3 behind a host that matches your fleet.

---

## 7. Known limits of the deployed RMS client (1.4.0)

| Limit | Effect | Handled by |
|---|---|---|
| Checks only when RMS starts | New software arrives after a restart | Nothing; restart pilot laptops to test faster |
| Reads the result once, 5 min × pending items after start | Slow installs can be recorded as failed | The install script reports the real result; the release rule trusts it (`PILOT_TRUST_SCRIPT_RESULT`); a failed row is retried at the next start |
| Never re-offers a name that succeeded | In-place updates can't reach laptops | **New version** flow |
| Failed installs are re-offered at every start | Automatic retries, no cap | Without the server patch the portal hides Retry and retry limits, because they would do nothing |
| Groups only (no single-laptop targeting) | Pilot by NGO/donor | Lab NGO; or the server patch |

### Optional: server patch (`integration/server-patch`)

One-time mount in `windows-rms-server` (CommonJS; instructions at the top of the file). It unlocks **pilot by serial**, **Retry** requests, a retry limit, install priority and a minimum client version. It reports itself via `rms_server_heartbeat`, and the portal then shows those options automatically (`RMS_SERVER_DEVICE_TARGETING=auto`). It is backward compatible (unknown serial → `[]`, legacy fields unchanged; `addHistory` accepts the legacy body). Everything else works without it.

---

## 8. Verification performed

| Check | Result |
|---|---|
| Migrations 001–004 on a copy of the `windows-rms-server` schema (incl. `"NGOs"`, `laptop_tracking`); re-run is a no-op; existing rows backfilled as released with their targets | ✅ |
| **Real `windows-rms-server` `softwareModel.js` (local UAT and GitHub `main`)** on the portal DB: pilot NGO laptops offered it, others not; release blocked until the rule passes; background job auto-released and the fleet was offered it; installed laptops not re-offered; pause hides it on both (incl. `main`, which ignores `isactive`); failed pilot never reaches the fleet; serial pilots rejected until the patch heartbeat exists | ✅ |
| **Laptops view**: for every laptop the portal's "failed + waiting" list equals exactly what the real `softwareModel.js` (UAT and `main`) offers it, incl. a piloted software (pilot NGO only) and a paused one (nowhere); filters, per-software view, laptop detail, CSV, last seen from `laptop_tracking` | ✅ |
| Minimal setup (only `DATABASE_URL`, `PORTAL_PUBLIC_URL`, `JWT_SECRET`, `ADMIN_USERS`; no S3): signed browser upload (tampered link rejected), file and script served by the portal (checksum match, Range 206, path traversal 404), real RMS `softwareModel.js` hands the pilot laptop the portal script URL | ✅ |
| Installer type detected from the file in the browser: Inno Setup, NSIS, MSI, WiX Burn (+ InstallShield, Advanced Installer, Squirrel rules); unknown `.exe` asks the admin to check | ✅ |
| Install scripts: generated, uploaded content-hashed, `winget_id` repointed; the 1.4.0 client's own `getScriptInfo()` picks the script from a legacy-server item; reports merged into history | ✅ (S3 via a local mock) |
| In-place installer change refused once installed; New version pilots separately and pauses the old entry on release | ✅ |
| Server patch regression suite incl. heartbeat | ✅ |
| UI: wizard (install settings, test & release), rollout panel, release, stop release, script viewer, history export; 0 console errors | ✅ (demo) |
| **Not yet run:** the generated PowerShell on Windows laptops; real S3/R2 multipart; TLS behaviour of PowerShell 5.1 on your fleet | ⚠️ do the canary in §6 |

---

## 9. Rollback

- Pause any software: it disappears from every laptop's list immediately.
- Undo the portal entirely: `004_down`, then `003_down` (points `winget_id` back at the installer file names), then `002_down`, `001_down`. Each restores what the RMS server needs before dropping portal columns.
