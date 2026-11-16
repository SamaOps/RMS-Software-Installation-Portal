/**
 * OPTIONAL upgrade for the windows-rms client (Node.js service running as SYSTEM).
 *
 * Old clients keep working without this file. Adopt it when you want laptops to honour
 * the new portal parameters: silent_args, installer_type, execution_context,
 * sha256 verification, timeout, detection rules, portable target path, and to send
 * error_message / exit_code / log_output back to the portal's log viewer.
 *
 * Integration (in the existing polling loop):
 *
 *   const { fetchPending, installSoftware, reportResult } = require('./installSoftware');
 *   const opts = { apiKey: process.env.RMS_API_KEY };          // only needed when the server has AUTH_ENABLED=true
 *   for (const sw of await fetchPending(BACKEND_BASE_URL, serial, opts)) {
 *     const result = await installSoftware(sw, { backendBaseUrl: BACKEND_BASE_URL });
 *     if (!result.deferred) await reportResult(BACKEND_BASE_URL, serial, sw, result, opts);
 *   }
 *
 * Every default below can be changed with an environment variable on the laptop
 * (RMS_DEFAULT_TIMEOUT_MINUTES, RMS_SUCCESS_EXIT_CODES, RMS_MAX_LOG_CHARS, ...);
 * per-software values sent by the server always win.
 *
 * Requires Node 18+ (global fetch). CommonJS on purpose: most packaged services are CJS.
 * ⚠ Written for Windows 10/11; review and test on a canary laptop before fleet rollout.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const env = process.env;
const envInt = (k, d) => (env[k] !== undefined && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const envCsv = (k, d) => (env[k] ? env[k].split(',').map((x) => x.trim()).filter(Boolean) : d);

const CLIENT_CAPS = env.RMS_CLIENT_CAPS || 'v2';
const MAX_LOG_CHARS = envInt('RMS_MAX_LOG_CHARS', 200_000);
const DEFAULT_TIMEOUT_MINUTES = envInt('RMS_DEFAULT_TIMEOUT_MINUTES', 10);
const USER_TASK_POLL_MS = envInt('RMS_USER_TASK_POLL_MS', 3000);
const LOG_TAIL_LINES = envInt('RMS_INSTALLER_LOG_TAIL_LINES', 60);
const SHARED_DIR = env.RMS_SHARED_DIR || path.join(env.PUBLIC || 'C:\\Users\\Public', 'RMS');
const DEFAULT_PORTABLE_ROOT = env.RMS_PORTABLE_ROOT || env.ProgramFiles || 'C:\\Program Files';

// Fallbacks only for rows the server sends without installer_type / silent_args (older server).
// Override with RMS_PRESET_ARGS_JSON='{"InnoSetup":"/VERYSILENT ..."}'.
const PRESET_ARGS = {
  InnoSetup: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-',
  NSIS: '/S',
  MSI: '/qn /norestart',
  ...(() => {
    try {
      return env.RMS_PRESET_ARGS_JSON ? JSON.parse(env.RMS_PRESET_ARGS_JSON) : {};
    } catch {
      return {};
    }
  })(),
};
const TYPE_BY_EXT = { msi: 'MSI', zip: 'Portable', ps1: 'Custom', bat: 'Custom', cmd: 'Custom' };
// Codes that still mean "installed" when the server doesn't send success_exit_codes.
const DEFAULT_SUCCESS_CODES = envCsv('RMS_SUCCESS_EXIT_CODES', ['0', '3010', '1641']).map(Number);
const successCodesFor = (sw) =>
  new Set(Array.isArray(sw.success_exit_codes) && sw.success_exit_codes.length ? sw.success_exit_codes.map(Number) : DEFAULT_SUCCESS_CODES);

/**
 * HMAC headers expected by windows-rms-server's verifyApiKey middleware when AUTH_ENABLED=true:
 * X-Timestamp = unix seconds, X-API-Signature = HMAC-SHA256(API_KEY, timestamp) hex.
 */
function authHeaders(apiKey) {
  if (!apiKey) return {};
  const ts = Math.floor(Date.now() / 1000).toString();
  return { 'X-Timestamp': ts, 'X-API-Signature': crypto.createHmac('sha256', apiKey).update(ts).digest('hex') };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class Transcript {
  constructor() {
    this.lines = [];
  }
  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.lines.push(line);
    console.log(line);
  }
  text() {
    const t = this.lines.join('\n');
    return t.length > MAX_LOG_CHARS ? t.slice(-MAX_LOG_CHARS) : t;
  }
}

const expandEnv = (p) => (p || '').replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? process.env[k.toUpperCase()] ?? `%${k}%`);
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'software';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Run a process with a hard timeout; kills the whole tree on timeout. */
function run(cmd, args, { timeoutMs, t, verbatim = false, cwd } = {}) {
  return new Promise((resolve) => {
    t?.log(`> ${cmd} ${Array.isArray(args) ? args.join(' ') : args}`);
    const child = spawn(cmd, Array.isArray(args) ? args : [args], {
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      shell: false,
      cwd,
    });
    let out = '';
    const collect = (d) => {
      out += d.toString();
      if (out.length > MAX_LOG_CHARS) out = out.slice(-MAX_LOG_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          t?.log(`ERROR: timed out after ${Math.round(timeoutMs / 60000)} min, killing process tree (pid ${child.pid})`);
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        }, timeoutMs)
      : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.trim()) t?.log(out.trim());
      resolve({ code: code ?? -1, out, timedOut });
    });
  });
}

const powershell = (script, opts) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);

// ---------------------------------------------------------------------------
// Download + integrity
// ---------------------------------------------------------------------------
async function download(url, dest, t) {
  t.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Execution contexts
// ---------------------------------------------------------------------------
/** Username of the interactive session (DOMAIN\user), or null if nobody is logged in. */
async function loggedInUser() {
  const r = await powershell('(Get-CimInstance Win32_ComputerSystem).UserName');
  const u = r.out.trim();
  return u || null;
}

/**
 * Run a command line as the logged-in user via a one-off scheduled task with an
 * Interactive principal (no password needed). Exit code is captured via a marker file.
 */
async function runAsLoggedInUser(commandLine, { timeoutMs, t, user }) {
  const id = `RMS-${crypto.randomBytes(4).toString('hex')}`;
  const dir = SHARED_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const wrapper = path.join(dir, `${id}.cmd`);
  const exitFile = path.join(dir, `${id}.exit`);
  const logFile = path.join(dir, `${id}.log`);
  fs.writeFileSync(wrapper, `@echo off\r\n${commandLine} > "${logFile}" 2>&1\r\necho %ERRORLEVEL% > "${exitFile}"\r\n`);

  t.log(`Running as logged-in user ${user} via scheduled task ${id}`);
  const reg = await powershell(
    [
      `$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote(`/c "${wrapper}"`)}`,
      `$p = New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType Interactive -RunLevel Limited`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes ${Math.ceil(timeoutMs / 60000) + 1})`,
      `Register-ScheduledTask -TaskName ${psQuote(id)} -Action $a -Principal $p -Settings $s -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${psQuote(id)}`,
    ].join('; '),
    { t },
  );
  if (reg.code !== 0) return { code: -1, timedOut: false };

  const deadline = Date.now() + timeoutMs;
  let code = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, USER_TASK_POLL_MS));
    if (fs.existsSync(exitFile)) {
      code = parseInt(fs.readFileSync(exitFile, 'utf8').trim(), 10);
      break;
    }
  }
  if (fs.existsSync(logFile)) t.log(fs.readFileSync(logFile, 'utf8').slice(-MAX_LOG_CHARS).trim());
  if (code === null) {
    t.log(`ERROR: timed out after ${Math.round(timeoutMs / 60000)} min in user context`);
    await powershell(`Stop-ScheduledTask -TaskName ${psQuote(id)} -ErrorAction SilentlyContinue`);
  }
  await powershell(`Unregister-ScheduledTask -TaskName ${psQuote(id)} -Confirm:$false -ErrorAction SilentlyContinue`);
  for (const f of [wrapper, exitFile, logFile]) fs.rmSync(f, { force: true });
  return { code: code ?? -1, timedOut: code === null };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
async function detect(sw, exitCode, t) {
  switch (sw.detection_type) {
    case 'file_exists': {
      const p = expandEnv(sw.detection_path);
      const ok = fs.existsSync(p);
      t.log(`Detection file_exists "${p}": ${ok ? 'found' : 'NOT found'}`);
      return ok;
    }
    case 'registry_key': {
      const key = sw.detection_path.replace(/^(HK[A-Z_]+):\\/i, '$1\\');
      const r = await run('reg.exe', ['query', key], { t });
      t.log(`Detection registry_key "${key}": ${r.code === 0 ? 'found' : 'NOT found'}`);
      return r.code === 0;
    }
    default: {
      const ok = successCodesFor(sw).has(exitCode);
      t.log(`Detection exit code ${exitCode}: ${ok ? 'success' : 'failure'} (success codes: ${[...successCodesFor(sw)].join(',')})`);
      return ok;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function fetchPending(backendBaseUrl, serialNumber, { apiKey = env.RMS_API_KEY } = {}) {
  const url = `${backendBaseUrl}/api/softwares/notInstalled?serial_number=${encodeURIComponent(serialNumber)}&caps=${CLIENT_CAPS}`;
  const res = await fetch(url, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`notInstalled failed: HTTP ${res.status}`);
  return res.json();
}

async function reportResult(backendBaseUrl, serialNumber, sw, result, { apiKey = env.RMS_API_KEY } = {}) {
  await fetch(`${backendBaseUrl}/api/softwares/addHistory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify({
      serial_number: serialNumber,
      software_name: sw.software_name,
      isSuccessful: result.isSuccessful,
      // new optional fields (ignored by an unpatched server)
      error_message: result.errorMessage || null,
      exit_code: Number.isInteger(result.exitCode) ? result.exitCode : null,
      log_output: result.logOutput || null,
      software_version: sw.version || null,
    }),
  });
}

/**
 * Install one software item from /notInstalled.
 * Returns { isSuccessful, exitCode, errorMessage, logOutput, deferred? }
 */
async function installSoftware(sw, { backendBaseUrl }) {
  const t = new Transcript();
  const timeoutMinutes = sw.timeout_minutes || DEFAULT_TIMEOUT_MINUTES;
  const timeoutMs = Math.max(1, timeoutMinutes) * 60_000;
  const context = sw.execution_context || 'SYSTEM';
  const fail = (errorMessage, exitCode = null) => {
    t.log(`FAILED: ${errorMessage}`);
    return { isSuccessful: false, exitCode, errorMessage, logOutput: t.text() };
  };
  t.log(`RMS client starting install: ${sw.software_name} ${sw.version || ''}`.trim());
  t.log(`Source: ${sw.source}  Type: ${sw.installer_type || '-'}  Context: ${context}  Timeout: ${timeoutMinutes}m`);

  let user = null;
  if (context === 'LOGGED_IN_USER') {
    user = await loggedInUser();
    if (!user) {
      t.log('No user is logged in; deferring until the next check-in.');
      return { deferred: true, isSuccessful: false, logOutput: t.text() };
    }
  }
  const exec = async (cmd, args, opts = {}) => {
    if (context === 'LOGGED_IN_USER') {
      const line = `"${cmd}" ${Array.isArray(args) ? args.join(' ') : args}`;
      return runAsLoggedInUser(line, { timeoutMs, t, user });
    }
    return run(cmd, args, { timeoutMs, t, ...opts });
  };

  try {
    // ---------------- winget ----------------
    if (sw.source === 'winget') {
      const args = `install --id ${sw.winget_id} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity ${
        context === 'SYSTEM' ? '--scope machine' : ''
      } ${sw.silent_args || ''}`.trim();
      // Under SYSTEM, winget.exe is not on PATH; resolve it from WindowsApps.
      let winget = 'winget.exe';
      if (context === 'SYSTEM') {
        const r = await powershell(
          `(Resolve-Path "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" | Sort-Object -Descending | Select-Object -First 1).Path`,
        );
        if (r.out.trim()) winget = r.out.trim();
      }
      const r = await exec(winget, args, { verbatim: true });
      if (r.timedOut) return fail(`Installer timed out after ${timeoutMinutes} minutes`, r.code);
      const ok = await detect(sw, r.code, t);
      return ok ? { isSuccessful: true, exitCode: r.code, logOutput: t.text() } : fail(`winget exited with code ${r.code}`, r.code);
    }

    // ---------------- download (rms-repository / external_url) ----------------
    // With an unpatched server, winget_id may be a portal install-script URL: just run that script.
    const url =
      sw.download_url ||
      (/^https?:\/\//i.test(sw.winget_id || '') ? sw.winget_id : `${backendBaseUrl}/softwares/${encodeURIComponent(sw.winget_id)}`);
    const fileName = path.basename(new URL(url).pathname) || safeName(sw.winget_id);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-'));
    const file = path.join(workDir, decodeURIComponent(fileName));
    const size = await download(url, file, t);
    t.log(`Downloaded ${size} bytes`);
    if (sw.file_size_bytes && size !== Number(sw.file_size_bytes)) return fail(`Incomplete download: got ${size} of ${sw.file_size_bytes} bytes`);
    if (sw.sha256_checksum) {
      const got = await sha256(file);
      if (got !== sw.sha256_checksum) return fail(`Checksum mismatch: expected ${sw.sha256_checksum}, got ${got}`);
      t.log('SHA-256 verified');
    }

    const ext = path.extname(file).slice(1).toLowerCase();
    const type = sw.installer_type || (sw.isPortable ? 'Portable' : TYPE_BY_EXT[ext] || 'InnoSetup');
    const silent = sw.silent_args ?? PRESET_ARGS[type] ?? '';

    // ---------------- portable ----------------
    if (type === 'Portable' || sw.isPortable) {
      const target = expandEnv(sw.target_install_path) || path.join(DEFAULT_PORTABLE_ROOT, safeName(sw.software_name));
      fs.mkdirSync(target, { recursive: true });
      let exe;
      if (ext === 'zip') {
        const r = await powershell(`Expand-Archive -LiteralPath ${psQuote(file)} -DestinationPath ${psQuote(target)} -Force`, { timeoutMs, t });
        if (r.code !== 0) return fail('Could not extract the zip archive', r.code);
        exe = fs.readdirSync(target).find((f) => f.toLowerCase().endsWith('.exe'));
        exe = exe && path.join(target, exe);
      } else {
        exe = path.join(target, path.basename(file));
        fs.copyFileSync(file, exe);
      }
      t.log(`Copied to ${target}`);
      if (sw.create_desktop_shortcut !== false && exe) {
        const lnk = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', `${safeName(sw.software_name)}.lnk`);
        await powershell(
          `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)}); $s.TargetPath=${psQuote(exe)}; $s.WorkingDirectory=${psQuote(path.dirname(exe))}; $s.Save()`,
          { t },
        );
        t.log(`Shortcut created: ${lnk}`);
      }
      const ok = sw.detection_type && sw.detection_type !== 'exit_code_zero' ? await detect(sw, 0, t) : !!exe && fs.existsSync(exe);
      return ok ? { isSuccessful: true, exitCode: 0, logOutput: t.text() } : fail('Portable binary not found after copy');
    }

    // ---------------- installers & scripts ----------------
    let r;
    if (ext === 'msi') {
      const msiLog = path.join(workDir, 'msi.log');
      r = await exec('msiexec.exe', `/i "${file}" ${silent} /L*v "${msiLog}"`, { verbatim: true });
      if (fs.existsSync(msiLog)) {
        const tail = fs.readFileSync(msiLog, 'latin1').split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n');
        t.log(`--- msiexec log (tail) ---\n${tail}`);
      }
    } else if (ext === 'ps1') {
      r = await exec('powershell.exe', `-NoProfile -ExecutionPolicy Bypass -File "${file}" ${silent}`, { verbatim: true });
    } else if (ext === 'bat' || ext === 'cmd') {
      r = await exec('cmd.exe', `/d /c ""${file}" ${silent}"`, { verbatim: true });
    } else {
      // InnoSetup / NSIS / Custom EXE. Inno can write its own log which helps triage.
      const extra = type === 'InnoSetup' ? ` /LOG="${path.join(workDir, 'inno.log')}"` : '';
      r = await exec(file, `${silent}${extra}`, { verbatim: true });
      const innoLog = path.join(workDir, 'inno.log');
      if (fs.existsSync(innoLog)) t.log(`--- Inno Setup log (tail) ---\n${fs.readFileSync(innoLog, 'utf8').split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n')}`);
    }

    if (r.timedOut) return fail(`Installer timed out after ${timeoutMinutes} minutes`, r.code);
    if (r.code === 740) return fail('Admin rights required (exit 740). Use SYSTEM context.', r.code);
    const ok = await detect(sw, r.code, t);
    fs.rmSync(workDir, { recursive: true, force: true });
    return ok ? { isSuccessful: true, exitCode: r.code, logOutput: t.text() } : fail(`Installer exited with code ${r.code}`, r.code);
  } catch (e) {
    return fail(e.message || String(e));
  }
}

module.exports = { fetchPending, installSoftware, reportResult, authHeaders };
