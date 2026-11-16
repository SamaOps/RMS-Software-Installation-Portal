/**
 * Generates the per-software PowerShell install script ("wrapper") that lets the
 * DEPLOYED RMS 1.4.0 client install any portal software correctly, without a client update.
 *
 * Contract with windows-rms 1.4.0 (services/softwareInstallUsingWinget.js):
 *   - notInstalled item whose winget_id is an http(s) URL ending in .ps1 -> getScriptInfo()
 *     -> installScriptFileViaTask(): downloads it and runs
 *        powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>
 *     in a scheduled task with /RL HIGHEST (the RMS app itself requires Administrator).
 *   - Success = script exit code 0 (or $null). Result is read once, 5 min x pending items later.
 *
 * The script applies every portal parameter: download + size + SHA-256, installer type,
 * silent args, SYSTEM vs logged-in-user context, timeout (kills the process tree), detection
 * (pre-check: skip if already installed; post-check), success exit codes, portable copy/zip +
 * shortcut, and a machine-wide mutex so installs never overlap (avoids MSI 1618).
 * Optionally posts a detailed report (exit code, error, transcript) to the portal.
 *
 * Pure function: no DB / S3 access, so the API, the demo and scripts can all use it.
 * NOTE: the generated script deliberately contains no PowerShell backtick escapes.
 */
import { createHash } from 'node:crypto';
import { wrapper, defaultSuccessExitCodes, limits, presets } from '../settings.js';

export const WRAPPER_VERSION = '1';

/** PowerShell single-quoted literal. Smart quotes are also quote chars in PowerShell, so double them too. */
export function psLit(v) {
  if (v === null || v === undefined) return "''";
  const s = String(v).replace(/[\r\n\0]+/g, ' ');
  return `'${s.replace(/['‘’‚‛]/g, (m) => m + m)}'`;
}
const psBool = (b) => (b ? '$true' : '$false');
const psInt = (n, d) => String(Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : d);

export function slugify(name) {
  return (
    String(name || 'software')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'software'
  );
}

/** Should this software be delivered to legacy clients via a wrapper? */
export function needsWrapper(sw) {
  return wrapper.enabled && wrapper.sources.includes(sw.source_type ?? sw.source);
}

/** Regex matching wrapper file names (so delivery accepts them even if .ps1 isn't an upload extension). */
export const wrapperNameRegex = new RegExp(`^${wrapper.filePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z0-9-]{1,60}-[a-f0-9]{8,16}\\.ps1$`);

/**
 * @param sw  normalized software: { id, software_name, version, source_type, file_name, file_url, sha256_checksum,
 *            file_size_bytes, installer_type, silent_args, execution_context, target_install_path,
 *            create_desktop_shortcut, timeout_minutes, detection_type, detection_path, success_exit_codes }
 * @param ctx { publicDownloadBaseUrl }
 * @returns { content, fileName, sha256 }
 */
export function generateWrapper(sw, { publicDownloadBaseUrl }) {
  const source = sw.source_type ?? sw.source;
  const fileName = sw.file_name || (source === 'external_url' && sw.file_url ? decodeURIComponent(new URL(sw.file_url).pathname.split('/').pop()) : null);
  if (!fileName) throw new Error('Wrapper needs a file name');
  const downloadUrl =
    source === 'external_url' ? sw.file_url : publicDownloadBaseUrl ? `${publicDownloadBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}` : null;
  if (!downloadUrl) throw new Error('PUBLIC_DOWNLOAD_BASE_URL is required to build install scripts for uploaded files');

  const ext = fileName.split('.').pop().toLowerCase();
  const installerType = sw.installer_type || presets.default_type_by_extension?.[ext] || 'Custom';
  const successCodes = (
    sw.success_exit_codes
      ? String(sw.success_exit_codes).split(',').map((x) => Number(x.trim()))
      : defaultSuccessExitCodes
  ).filter((n) => Number.isInteger(n));

  const cfg = [
    ['WrapperVersion', psLit(WRAPPER_VERSION)],
    ['SoftwareId', psLit(sw.id ?? '')],
    ['SoftwareName', psLit(sw.software_name)],
    ['Version', psLit(sw.version ?? '')],
    ['DownloadUrl', psLit(downloadUrl)],
    ['FileName', psLit(fileName)],
    ['Sha256', psLit((sw.sha256_checksum || '').toLowerCase())],
    ['SizeBytes', sw.file_size_bytes ? psInt(sw.file_size_bytes, 0) : '0'],
    ['InstallerType', psLit(installerType)],
    ['SilentArgs', psLit(sw.silent_args ?? '')],
    ['Context', psLit(sw.execution_context || 'SYSTEM')],
    ['TargetPath', psLit(sw.target_install_path ?? '')],
    ['Shortcut', psBool(sw.create_desktop_shortcut !== false)],
    ['TimeoutMinutes', psInt(sw.timeout_minutes, limits.timeoutDefaultMinutes)],
    ['DetectionType', psLit(sw.detection_type || 'exit_code_zero')],
    ['DetectionPath', psLit(sw.detection_path ?? '')],
    ['SuccessCodes', `@(${successCodes.join(',')})`],
    ['MutexName', psLit(wrapper.mutexName)],
    ['MutexWaitMinutes', psInt(wrapper.mutexWaitMinutes, 20)],
    ['DownloadRetries', psInt(wrapper.downloadRetries, 3)],
    ['DeviceInfoFile', psLit(wrapper.deviceInfoFile)],
    ['WorkDir', psLit(wrapper.workDir)],
    ['LogTailLines', psInt(wrapper.logTailLines, 80)],
    ['TelemetryUrl', psLit(wrapper.telemetryUrl)],
    ['ReportToken', psLit(wrapper.reportToken)],
    ['MaxReportLogChars', psInt(wrapper.maxReportLogChars, 200000)],
  ];
  const width = Math.max(...cfg.map(([k]) => k.length));

  const lines = [
    `# RMS Software Portal - install script v${WRAPPER_VERSION} for: ${String(sw.software_name).replace(/[\r\n]/g, ' ')}`,
    '# Generated by the portal. Do not edit by hand: change the software in the portal and it is regenerated.',
    '# Runs under the RMS client (elevated). Exit code 0 = installed.',
    '',
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}',
    '',
    '$Cfg = @{',
    ...cfg.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`),
    '}',
    '',
    BODY.replace(/\r?\n/g, '\r\n'),
  ];
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI (would garble non-English names).
  const content = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    content,
    sha256,
    fileName: `${wrapper.filePrefix}${slugify(sw.software_name)}-${sha256.slice(0, 12)}.ps1`,
  };
}

// ---------------------------------------------------------------------------
// Static script body (Windows PowerShell 5.1 compatible; no backticks).
// ---------------------------------------------------------------------------
const BODY = String.raw`$NL = [Environment]::NewLine
$script:Log = New-Object System.Collections.Generic.List[string]
$script:Mutex = $null
$script:HasMutex = $false
$script:WorkDir = $null
$script:TimedOut = $false

function Write-Log([string]$Message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
  $script:Log.Add($line)
  Write-Host $line
}

function Expand-PathVars([string]$Path) {
  if (-not $Path) { return $Path }
  return [Environment]::ExpandEnvironmentVariables($Path)
}

function Get-SafeName([string]$Name) {
  $n = ($Name -replace '[<>:"/\\|?*]', '').Trim()
  if (-not $n) { $n = 'Software' }
  return $n
}

function Get-DeviceSerial {
  try {
    if (Test-Path -LiteralPath $Cfg.DeviceInfoFile) {
      $info = Get-Content -LiteralPath $Cfg.DeviceInfoFile -Raw | ConvertFrom-Json
      if ($info.serialNumber) { return [string]$info.serialNumber }
    }
  } catch {}
  try { return ([string](Get-CimInstance -ClassName Win32_BIOS).SerialNumber).Trim() } catch { return '' }
}

function Convert-RegistryPath([string]$Path) {
  $p = $Path -replace '^HKLM:?\\', 'HKEY_LOCAL_MACHINE\'
  $p = $p -replace '^HKCU:?\\', 'HKEY_CURRENT_USER\'
  $p = $p -replace '^HKCR:?\\', 'HKEY_CLASSES_ROOT\'
  $p = $p -replace '^HKU:?\\', 'HKEY_USERS\'
  return 'Registry::' + $p
}

# $true / $false, or $null when detection is by exit code only.
function Test-Installed {
  switch ($Cfg.DetectionType) {
    'file_exists' {
      $p = Expand-PathVars $Cfg.DetectionPath
      $found = Test-Path -LiteralPath $p
      Write-Log ('Detection file_exists "' + $p + '": ' + $(if ($found) { 'found' } else { 'not found' }))
      return $found
    }
    'registry_key' {
      $p = Convert-RegistryPath $Cfg.DetectionPath
      $found = Test-Path -LiteralPath $p
      if (-not $found -and $p -match 'HKEY_LOCAL_MACHINE\\SOFTWARE\\(?!WOW6432Node)') {
        $p32 = $p -replace 'HKEY_LOCAL_MACHINE\\SOFTWARE\\', 'HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\'
        $found = Test-Path -LiteralPath $p32
      }
      Write-Log ('Detection registry_key "' + $Cfg.DetectionPath + '": ' + $(if ($found) { 'found' } else { 'not found' }))
      return $found
    }
    default { return $null }
  }
}

function Send-Report([bool]$Ok, [int]$Code, [string]$ErrorText) {
  if (-not $Cfg.TelemetryUrl) { return }
  try {
    $text = $script:Log -join $NL
    if ($text.Length -gt $Cfg.MaxReportLogChars) { $text = $text.Substring($text.Length - $Cfg.MaxReportLogChars) }
    $body = @{
      serial_number   = (Get-DeviceSerial)
      software_id     = $Cfg.SoftwareId
      software_name   = $Cfg.SoftwareName
      software_version = $Cfg.Version
      is_successful   = $Ok
      exit_code       = $Code
      error_message   = $ErrorText
      log_output      = $text
      wrapper_version = $Cfg.WrapperVersion
      token           = $Cfg.ReportToken
    } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod -Uri $Cfg.TelemetryUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30 -UseBasicParsing | Out-Null
  } catch {
    Write-Host ('Report not sent: ' + $_.Exception.Message)
  }
}

function Complete-Install([bool]$Ok, [int]$Code, [string]$ErrorText) {
  if ($Ok) { Write-Log ('RESULT: SUCCESS (exit ' + $Code + ')') }
  else { Write-Log ('RESULT: FAILED (exit ' + $Code + ') ' + $ErrorText) }
  Send-Report $Ok $Code $ErrorText
  if ($script:HasMutex) { try { $script:Mutex.ReleaseMutex() } catch {} }
  if ($script:WorkDir) { Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($Ok) { exit 0 }
  if ($Code -eq 0) { exit 1 }
  exit $Code
}

function Wait-OrKill($Process) {
  $null = $Process.Handle  # makes ExitCode available on Windows PowerShell 5.1
  if (-not $Process.WaitForExit([int]$Cfg.TimeoutMinutes * 60000)) {
    $script:TimedOut = $true
    Write-Log ('Timed out after ' + $Cfg.TimeoutMinutes + ' min; killing process tree ' + $Process.Id)
    Start-Process -FilePath 'taskkill.exe' -ArgumentList ('/PID ' + $Process.Id + ' /T /F') -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
    return 1460
  }
  return [int]$Process.ExitCode
}

function Invoke-AsLoggedInUser([string]$Exe, [string]$ArgLine) {
  $user = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
  if (-not $user) { Complete-Install $false 1 'No user is logged in; the install will be retried at the next check-in' }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($user -ieq $me) {
    Write-Log ('Running in the session of ' + $user)
    if ($ArgLine) { $p = Start-Process -FilePath $Exe -ArgumentList $ArgLine -PassThru -WindowStyle Hidden }
    else { $p = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden }
    return (Wait-OrKill $p)
  }
  # Different account: one-off scheduled task with an Interactive principal (no password needed).
  # Let the user's task read the installer and write its exit marker (Users group, by SID).
  Start-Process -FilePath 'icacls.exe' -ArgumentList ('"' + $script:WorkDir + '" /grant *S-1-5-32-545:(OI)(CI)M /T /Q') -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
  $id = 'RMSPortal-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $cmdFile = Join-Path $script:WorkDir ($id + '.cmd')
  $exitFile = Join-Path $script:WorkDir ($id + '.exit')
  $outFile = Join-Path $script:WorkDir ($id + '.out')
  $cmd = '@echo off' + $NL + '"' + $Exe + '" ' + $ArgLine + ' > "' + $outFile + '" 2>&1' + $NL + 'echo %ERRORLEVEL% > "' + $exitFile + '"' + $NL
  [IO.File]::WriteAllText($cmdFile, $cmd, [Text.Encoding]::ASCII)
  Write-Log ('Running as logged-in user ' + $user + ' via task ' + $id)
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmdFile + '"')
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes ([int]$Cfg.TimeoutMinutes + 1))
  Register-ScheduledTask -TaskName $id -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $id
  $deadline = (Get-Date).AddMinutes([int]$Cfg.TimeoutMinutes)
  $code = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-Path -LiteralPath $exitFile) { $code = [int]((Get-Content -LiteralPath $exitFile -Raw).Trim()); break }
  }
  if (Test-Path -LiteralPath $outFile) { Write-Log ((Get-Content -LiteralPath $outFile -Tail $Cfg.LogTailLines) -join $NL) }
  if ($null -eq $code) {
    $script:TimedOut = $true
    Stop-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue
    $code = 1460
  }
  Unregister-ScheduledTask -TaskName $id -Confirm:$false -ErrorAction SilentlyContinue
  return $code
}

function Invoke-Installer([string]$Exe, [string]$ArgLine) {
  Write-Log ('> "' + $Exe + '" ' + $ArgLine)
  if ($Cfg.Context -eq 'LOGGED_IN_USER') { return (Invoke-AsLoggedInUser $Exe $ArgLine) }
  if ($ArgLine) { $p = Start-Process -FilePath $Exe -ArgumentList $ArgLine -PassThru -WindowStyle Hidden }
  else { $p = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden }
  return (Wait-OrKill $p)
}

function Add-LogTail([string]$Path, [string]$Title) {
  if (Test-Path -LiteralPath $Path) {
    Write-Log ('--- ' + $Title + ' (tail) ---' + $NL + ((Get-Content -LiteralPath $Path -Tail $Cfg.LogTailLines -ErrorAction SilentlyContinue) -join $NL))
  }
}

# ============================== main ==============================
try {
  Write-Log ('RMS portal install: ' + $Cfg.SoftwareName + ' ' + $Cfg.Version + ' | type ' + $Cfg.InstallerType + ' | context ' + $Cfg.Context + ' | timeout ' + $Cfg.TimeoutMinutes + ' min')
  Write-Log ('Running as ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)

  # One install at a time on this machine (all RMS tasks start in the same minute).
  $script:Mutex = New-Object System.Threading.Mutex($false, $Cfg.MutexName)
  try { $script:HasMutex = $script:Mutex.WaitOne([TimeSpan]::FromMinutes([int]$Cfg.MutexWaitMinutes)) }
  catch {
    # A previous install crashed while holding the lock: we now own it. (PowerShell wraps the .NET exception.)
    $inner = $_.Exception
    while ($inner -and -not ($inner -is [System.Threading.AbandonedMutexException])) { $inner = $inner.InnerException }
    if ($inner) { $script:HasMutex = $true; Write-Log 'Recovered an abandoned install lock' } else { throw }
  }
  if (-not $script:HasMutex) { Complete-Install $false 1618 'Timed out waiting for another RMS install to finish' }

  # Already installed? (only possible with file/registry detection)
  if ((Test-Installed) -eq $true) {
    Write-Log 'Already installed; nothing to do.'
    Complete-Install $true 0 ''
  }

  $script:WorkDir = Join-Path (Expand-PathVars $Cfg.WorkDir) ([guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null
  $file = Join-Path $script:WorkDir $Cfg.FileName

  # Download with retries
  for ($i = 1; $i -le [int]$Cfg.DownloadRetries; $i++) {
    try {
      Write-Log ('Downloading ' + $Cfg.DownloadUrl + ' (attempt ' + $i + ')')
      $wc = New-Object System.Net.WebClient
      $wc.DownloadFile($Cfg.DownloadUrl, $file)
      break
    } catch {
      Write-Log ('Download failed: ' + $_.Exception.Message)
      if ($i -ge [int]$Cfg.DownloadRetries) { Complete-Install $false 2 ('Download failed: ' + $_.Exception.Message) }
      Start-Sleep -Seconds (10 * $i)
    }
  }
  $size = (Get-Item -LiteralPath $file).Length
  Write-Log ('Downloaded ' + $size + ' bytes')
  if ([int64]$Cfg.SizeBytes -gt 0 -and $size -ne [int64]$Cfg.SizeBytes) {
    Complete-Install $false 2 ('Incomplete download: got ' + $size + ' of ' + $Cfg.SizeBytes + ' bytes')
  }
  if ($Cfg.Sha256) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $Cfg.Sha256) { Complete-Install $false 1619 ('Checksum mismatch: expected ' + $Cfg.Sha256 + ', got ' + $hash) }
    Write-Log 'SHA-256 verified'
  }
  Unblock-File -LiteralPath $file -ErrorAction SilentlyContinue

  $ext = [IO.Path]::GetExtension($file).TrimStart('.').ToLowerInvariant()
  $code = 0

  if ($Cfg.InstallerType -eq 'Portable') {
    $target = Expand-PathVars $Cfg.TargetPath
    if (-not $target) { $target = Join-Path $env:ProgramFiles (Get-SafeName $Cfg.SoftwareName) }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    if ($ext -eq 'zip') {
      Expand-Archive -LiteralPath $file -DestinationPath $target -Force
      $exe = Get-ChildItem -LiteralPath $target -Filter '*.exe' -Recurse | Where-Object { $_.Name -notmatch 'unins|setup|update|helper|crash' } | Select-Object -First 1 -ExpandProperty FullName
    } else {
      $exe = Join-Path $target $Cfg.FileName
      Copy-Item -LiteralPath $file -Destination $exe -Force
    }
    Write-Log ('Placed in ' + $target)
    if ($Cfg.Shortcut -and $exe) {
      $lnk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) ((Get-SafeName $Cfg.SoftwareName) + '.lnk')
      $shell = New-Object -ComObject WScript.Shell
      $s = $shell.CreateShortcut($lnk)
      $s.TargetPath = $exe
      $s.WorkingDirectory = Split-Path -Parent $exe
      $s.Save()
      Write-Log ('Shortcut created: ' + $lnk)
    }
    if (-not ($exe -and (Test-Path -LiteralPath $exe))) { $code = 2 }
  }
  elseif ($ext -eq 'msi') {
    $msiLog = Join-Path $script:WorkDir 'msi.log'
    $code = Invoke-Installer 'msiexec.exe' ('/i "' + $file + '" ' + $Cfg.SilentArgs + ' /L*v "' + $msiLog + '"')
    Add-LogTail $msiLog 'msiexec log'
  }
  elseif ($ext -eq 'ps1') {
    $code = Invoke-Installer 'powershell.exe' ('-NoProfile -ExecutionPolicy Bypass -File "' + $file + '" ' + $Cfg.SilentArgs)
  }
  elseif ($ext -eq 'bat' -or $ext -eq 'cmd') {
    $code = Invoke-Installer 'cmd.exe' ('/d /c ""' + $file + '" ' + $Cfg.SilentArgs + '"')
  }
  else {
    $argLine = $Cfg.SilentArgs
    $innoLog = Join-Path $script:WorkDir 'inno.log'
    if ($Cfg.InstallerType -eq 'InnoSetup' -and $argLine -notmatch '/LOG') { $argLine = ($argLine + ' /LOG="' + $innoLog + '"').Trim() }
    $code = Invoke-Installer $file $argLine
    Add-LogTail $innoLog 'Inno Setup log'
  }

  Write-Log ('Exit code: ' + $code)
  if ($script:TimedOut) { Complete-Install $false 1460 ('Installer timed out after ' + $Cfg.TimeoutMinutes + ' minutes') }
  if ($code -eq 740) { Complete-Install $false 740 'Installer requires elevation (exit 740)' }

  $detected = Test-Installed
  if ($null -ne $detected) {
    if ($detected) { Complete-Install $true $code '' }
    Complete-Install $false $code ('Installer finished (exit ' + $code + ') but detection did not find ' + $Cfg.DetectionPath)
  }
  if ($Cfg.SuccessCodes -contains $code) { Complete-Install $true $code '' }
  Complete-Install $false $code ('Installer exited with code ' + $code)
}
catch {
  Complete-Install $false 1 ('Unexpected error: ' + $_.Exception.Message)
}
`;
