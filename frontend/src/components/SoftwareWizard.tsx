import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  Cloud,
  FlaskConical,
  Globe2,
  Link2,
  Monitor,
  Package,
  RotateCcw,
  ShieldCheck,
  User,
} from 'lucide-react';
import { Button, Field, Modal, Segmented, Switch } from './ui';
import { FileDropzone, type UploadState } from './FileDropzone';
import { MultiSelect } from './MultiSelect';
import { api, apiError } from '../lib/api';
import { uploadFile } from '../lib/upload';
import { formatBytes, sanitizeFileName } from '../lib/format';
import { extOf, guessInstallerType, useDefaults, useServerPatch } from '../lib/defaults';
import { detectInstaller, type Detected } from '../lib/detectInstaller';
import axios from 'axios';
import type {
  Defaults,
  Limits,
  DetectionType,
  InstallerType,
  NamedRef,
  Software,
  ServerCapabilities,
  SoftwarePayload,
  SourceType,
} from '../lib/types';

const STEPS = [
  { title: 'Package & source', short: 'Source' },
  { title: 'Installer & execution', short: 'Execution' },
  { title: 'Test on pilot laptops, then release', short: 'Test & release' },
];

// Which step each field lives on (to route server-side validation errors).
const FIELD_STEP: Record<string, number> = {
  software_name: 0, version: 0, description: 0, source_type: 0, file_name: 0, storage_key: 0,
  file_size_bytes: 0, sha256_checksum: 0, winget_id: 0, file_url: 0,
  installer_type: 1, silent_args: 1, execution_context: 1, is_portable: 1, target_install_path: 1,
  create_desktop_shortcut: 1, timeout_minutes: 1, detection_type: 1, detection_path: 1,
  success_exit_codes: 1, install_priority: 1, max_retry_attempts: 1, min_rms_version: 1,
  is_global: 2, assigned_donors: 2, assigned_ngos: 2, test_device_serials: 2, pilot_ngos: 2, pilot_donors: 2,
  pilot_required_successes: 2, pilot_max_failures: 2, auto_release: 2, release_now: 2,
};

const SERIAL_RE = /^[A-Za-z0-9._\-/]{3,100}$/;
const EXIT_CODES_RE = /^-?\d+(\s*,\s*-?\d+)*$/;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}$/;
// Used only until /installer-defaults has loaded.
const FALLBACK_LIMITS: Pick<Limits, 'timeout_min_minutes' | 'timeout_max_minutes' | 'timeout_default_minutes' | 'canary_max_devices' | 'install_priority_default' | 'install_priority_max' | 'max_auto_retry_attempts' | 'max_retry_attempts_ceiling'> = {
  timeout_min_minutes: 1, timeout_max_minutes: 240, timeout_default_minutes: 10, canary_max_devices: 5,
  install_priority_default: 100, install_priority_max: 1000, max_auto_retry_attempts: 3, max_retry_attempts_ceiling: 20,
};
const WINGET_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_+]{0,127}$/;
const WIN_PATH_RE = /^([A-Za-z]:\\|%[A-Za-z_]+%\\?)/;
const REG_RE = /^(HKLM|HKCU|HKCR|HKU|HKEY_[A-Z_]+)(:)?\\/i;

type Uploaded = { storage_key: string; file_name: string; file_size_bytes: number; sha256_checksum: string };

interface Form {
  software_name: string;
  version: string;
  description: string;
  is_active: boolean;
  source_type: SourceType;
  winget_id: string;
  file_url: string;
  installer_type: InstallerType | '';
  silent_args: string;
  execution_context: 'SYSTEM' | 'LOGGED_IN_USER';
  run_as: 'system' | 'user';
  elevation: 'highest' | 'none';
  pre_install_script: string;
  post_install_script: string;
  process_name_to_wait: string;
  target_install_path: string;
  create_desktop_shortcut: boolean;
  timeout_minutes: number;
  is_global: boolean;
  assigned_donors: (string | number)[];
  assigned_ngos: (string | number)[];
  serialsText: string;
  detection_type: DetectionType;
  detection_path: string;
  success_exit_codes: string;
  install_priority: number;
  max_retry_attempts: string; // '' = use server default
  min_rms_version: string;
  pilot_ngos: (string | number)[];
  pilot_donors: (string | number)[];
  pilot_required_successes: string; // '' = all pilot laptops
  pilot_max_failures: string; // '' = server default
  auto_release: boolean;
  release_now: boolean;
  replaces_software_id: string; // "New version" of this entry
}

type L = typeof FALLBACK_LIMITS;

const emptyForm = (l: L, autoRelease = true): Form => ({
  pilot_ngos: [], pilot_donors: [], pilot_required_successes: '', pilot_max_failures: '', auto_release: autoRelease, release_now: false,
  replaces_software_id: '',
  software_name: '', version: '', description: '', is_active: true, source_type: 'rms-repository',
  winget_id: '', file_url: '', installer_type: '', silent_args: '', execution_context: 'SYSTEM',
  run_as: 'system', elevation: 'highest', pre_install_script: '', post_install_script: '', process_name_to_wait: '',
  target_install_path: '', create_desktop_shortcut: true, timeout_minutes: l.timeout_default_minutes, is_global: false,
  assigned_donors: [], assigned_ngos: [], serialsText: '', detection_type: 'exit_code_zero', detection_path: '',
  success_exit_codes: '', install_priority: l.install_priority_default, max_retry_attempts: '', min_rms_version: '',
});

function fromSoftware(s: Software, l: L): Form {
  return {
    software_name: s.software_name,
    version: s.version ?? '',
    description: s.description ?? '',
    is_active: s.is_active,
    source_type: s.source_type,
    winget_id: s.source_type === 'winget' ? (s.winget_id ?? '') : '',
    file_url: s.file_url ?? '',
    installer_type: s.installer_type ?? (s.is_portable ? 'Portable' : ''),
    silent_args: s.silent_args ?? '',
    execution_context: s.execution_context,
    run_as: s.run_as ?? (s.execution_context === 'LOGGED_IN_USER' ? 'user' : 'system'),
    elevation: s.elevation ?? (s.execution_context === 'LOGGED_IN_USER' ? 'none' : 'highest'),
    pre_install_script: s.pre_install_script ?? '',
    post_install_script: s.post_install_script ?? '',
    process_name_to_wait: s.process_name_to_wait ?? '',
    target_install_path: s.target_install_path ?? '',
    create_desktop_shortcut: s.create_desktop_shortcut,
    timeout_minutes: Math.min(l.timeout_max_minutes, Math.max(l.timeout_min_minutes, s.timeout_minutes || l.timeout_default_minutes)),
    is_global: s.is_global,
    assigned_donors: s.assigned_donors.map((d) => d.id),
    assigned_ngos: s.assigned_ngos.map((n) => n.id),
    serialsText: s.test_device_serials.join('\n'),
    detection_type: s.detection_type,
    detection_path: s.detection_path ?? '',
    success_exit_codes: s.success_exit_codes ?? '',
    install_priority: s.install_priority ?? l.install_priority_default,
    max_retry_attempts: s.max_retry_attempts != null ? String(s.max_retry_attempts) : '',
    min_rms_version: s.min_rms_version ?? '',
    pilot_ngos: (s.pilot_ngos ?? []).map((n) => n.id),
    pilot_donors: (s.pilot_donors ?? []).map((d) => d.id),
    pilot_required_successes: s.pilot_required_successes != null ? String(s.pilot_required_successes) : '',
    pilot_max_failures: s.pilot_max_failures != null ? String(s.pilot_max_failures) : '',
    auto_release: s.auto_release !== false,
    release_now: false,
    replaces_software_id: s.replaces_software_id ?? '',
  };
}

/** "AI Tutor" v1.2.0 -> name "AI Tutor 1.2.1", version "1.2.1" (admin can edit both). */
function nextVersionOf(s: Software) {
  const v = (s.version ?? '').replace(/^v/i, '');
  const parts = v.split('.');
  const last = Number(parts[parts.length - 1]);
  const next = v && Number.isFinite(last) ? [...parts.slice(0, -1), String(last + 1)].join('.') : '';
  const base = v ? s.software_name.replace(new RegExp(`\\s*v?${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '') : s.software_name;
  return { name: next ? `${base} ${next}` : `${base} (new version)`, version: next };
}

const parseSerials = (t: string) => [...new Set(t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
const defaultPortablePath = (name: string) => `C:\\Program Files\\${name.replace(/[<>:"/\\|?*]/g, '').trim() || '<software_name>'}`;

export function SoftwareWizard({
  open,
  onClose,
  editing,
  basedOn,
  onNewVersion,
  defaults: defaultsProp,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Software | null;
  /** "New version": prefill from this software, saved as a NEW entry that replaces it. */
  basedOn?: Software | null;
  onNewVersion?: (s: Software) => void;
  defaults: Defaults | null;
  onSaved: (s: Software) => void;
}) {
  const hooked = useDefaults();
  const patch = useServerPatch(); // server-patch-only settings are hidden without it
  const defaults = defaultsProp ?? hooked;
  const lim: L = { ...FALLBACK_LIMITS, ...(defaults?.limits ?? {}) };
  const MAX_CANARY = lim.canary_max_devices;
  const allowedExt = defaults?.allowed_extensions ?? [];
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(() => emptyForm(lim));
  const [server, setServer] = useState<ServerCapabilities | null>(null);
  const requirePilot = defaults?.rollout?.require_pilot ?? true;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ fileName: '', uploading: false });
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [argsTouched, setArgsTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRule, setShowRule] = useState(false);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [undetected, setUndetected] = useState(false);
  const [donors, setDonors] = useState<NamedRef[]>([]);
  const [ngos, setNgos] = useState<NamedRef[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(true);
  const [unknownSerials, setUnknownSerials] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  const types = defaults?.installer_types;
  const hasHistory = !!editing && editing.stats.total_attempts > 0;

  // Reset when (re)opened
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setErrors({});
    setUpload({ fileName: '', uploading: false });
    setArgsTouched(!!editing);
    setUnknownSerials([]);
    setDetected(null);
    setUndetected(false);
    setShowAdvanced(false);
    setShowRule(false);
    if (editing) {
      setForm(fromSoftware(editing, lim));
      setUploaded(
        editing.source_type === 'rms-repository' && editing.storage_key && editing.sha256_checksum
          ? {
              storage_key: editing.storage_key,
              file_name: editing.file_name!,
              file_size_bytes: editing.file_size_bytes ?? 0,
              sha256_checksum: editing.sha256_checksum,
            }
          : null,
      );
    } else if (basedOn) {
      const nv = nextVersionOf(basedOn);
      setForm({
        ...fromSoftware(basedOn, lim),
        software_name: nv.name,
        version: nv.version,
        description: '',
        replaces_software_id: String(basedOn.id),
        release_now: false,
      });
      setArgsTouched(true);
      setUploaded(null); // a new version needs its new installer
    } else {
      setForm(emptyForm(lim, defaults?.rollout?.auto_release_default ?? true));
      setUploaded(null);
    }
    api.rmsServer().then(setServer).catch(() => setServer(null));
    setLookupsLoading(true);
    Promise.all([api.donors(), api.ngos()])
      .then(([d, n]) => {
        setDonors(d);
        setNgos(n);
      })
      .catch((e) => toast.error(`Couldn't load donors/NGOs: ${apiError(e).message}`))
      .finally(() => setLookupsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, basedOn]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => {
      if (!e[k as string]) return e;
      const { [k as string]: _omit, ...rest } = e;
      return rest;
    });
  };

  const setInstallerType = (t: InstallerType) => {
    setForm((f) => ({
      ...f,
      installer_type: t,
      silent_args: argsTouched ? f.silent_args : (types?.[t]?.silentArgs ?? ''),
      target_install_path: t === 'Portable' && !f.target_install_path ? defaultPortablePath(f.software_name) : f.target_install_path,
    }));
  };

  // ---------------- Upload ----------------
  const startUpload = async (file: File, fileName: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setUploaded(null);
    setUpload({ file, fileName, uploading: true });
    // Detect the installer technology from the file itself; fall back to the extension.
    const found = await detectInstaller(file, defaults).catch(() => null);
    setDetected(found);
    setUndetected(!found && extOf(file.name) === 'exe');
    const guessed = found?.type ?? guessInstallerType(file.name, defaults);
    if (guessed && (!form.installer_type || !argsTouched)) {
      setInstallerType(guessed);
      if (found?.silentArgs && !argsTouched) setForm((f) => ({ ...f, silent_args: found.silentArgs! }));
    }
    if (!form.software_name) {
      // "AITutor-Setup-v2.1.exe" -> "AITutor Setup v2.1" as a starting point
      set('software_name', file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim());
    }
    try {
      const res = await uploadFile(file, fileName, {
        softwareId: editing?.id,
        signal: ctrl.signal,
        onProgress: (p) => setUpload((u) => ({ ...u, progress: p })),
        tuning: defaults?.limits,
      });
      setUploaded(res);
      setUpload({ file: undefined, fileName: res.file_name, uploading: false });
      setErrors((e) => ({ ...e, file_name: '' }));
      toast.success('Upload complete', { description: `${res.file_name} · ${formatBytes(res.file_size_bytes)}` });
    } catch (err) {
      if ((err as Error).name === 'AbortError' || ctrl.signal.aborted) {
        setUpload({ fileName: '', uploading: false });
        toast.message('Upload cancelled');
        return;
      }
      setUpload((u) => ({ ...u, uploading: false, error: apiError(err).message }));
    }
  };

  useEffect(() => () => abort.current?.abort(), []);

  // ---------------- Validation ----------------
  const serials = useMemo(() => parseSerials(form.serialsText), [form.serialsText]);

  function validateStep(s: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (form.software_name.trim().length < 2) e.software_name = 'Enter a display name';
      if (form.source_type === 'rms-repository') {
        if (upload.uploading) e.file_name = 'Wait for the upload to finish';
        else if (!uploaded) e.file_name = 'Upload an installer file';
      }
      if (form.source_type === 'winget') {
        if (!form.winget_id.trim()) e.winget_id = 'Enter a winget package ID';
        else if (!WINGET_RE.test(form.winget_id.trim())) e.winget_id = 'Invalid ID. Example: Google.Chrome';
      }
      if (form.source_type === 'external_url') {
        try {
          const u = new URL(form.file_url);
          if (!['http:', 'https:'].includes(u.protocol)) e.file_url = 'Must start with http:// or https://';
          else if (allowedExt.length && !allowedExt.includes(extOf(u.pathname)))
            e.file_url = `URL must end with ${allowedExt.map((x) => '.' + x).join(', ')}`;
        } catch {
          e.file_url = 'Enter a valid URL';
        }
      }
    }
    if (s === 1) {
      if (form.source_type !== 'winget' && !form.installer_type) e.installer_type = 'Choose an installer type';
      if (/[\r\n]/.test(form.silent_args)) e.silent_args = 'Must be a single line';
      if (supportsInstallDir && form.target_install_path && !WIN_PATH_RE.test(form.target_install_path))
        e.target_install_path = 'Use an absolute Windows path, e.g. C:\\Program Files\\<App>';
      if (form.detection_type === 'file_exists' && !WIN_PATH_RE.test(form.detection_path))
        e.detection_path = 'Enter the full path of a file the installer creates';
      if (form.detection_type === 'registry_key' && !REG_RE.test(form.detection_path))
        e.detection_path = 'Example: HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\<AppId>';
      if (form.execution_context === 'LOGGED_IN_USER' && /program files/i.test(form.target_install_path))
        e.execution_context = 'User-context installs cannot write to Program Files. Use SYSTEM or a %LOCALAPPDATA% path.';
      if (form.timeout_minutes < lim.timeout_min_minutes || form.timeout_minutes > lim.timeout_max_minutes)
        e.timeout_minutes = `Use ${lim.timeout_min_minutes}–${lim.timeout_max_minutes} minutes`;
      if (form.success_exit_codes.trim() && !EXIT_CODES_RE.test(form.success_exit_codes.trim()))
        e.success_exit_codes = 'Comma-separated integers, e.g. 0,3010,1641';
      if (!Number.isInteger(form.install_priority) || form.install_priority < 0 || form.install_priority > lim.install_priority_max)
        e.install_priority = `Use 0–${lim.install_priority_max}`;
      if (form.max_retry_attempts !== '') {
        const n = Number(form.max_retry_attempts);
        if (!Number.isInteger(n) || n < 0 || n > lim.max_retry_attempts_ceiling) e.max_retry_attempts = `Use 0–${lim.max_retry_attempts_ceiling}, or leave empty`;
      }
      if (form.min_rms_version.trim() && !VERSION_RE.test(form.min_rms_version.trim())) e.min_rms_version = 'Use a version like 2.1.0';
    }
    if (s === 2) {
      const pos = (v: string, min: number) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= min);
      if (!pos(form.pilot_required_successes, 1)) e.pilot_required_successes = 'A whole number ≥ 1, or empty for all';
      if (!pos(form.pilot_max_failures, 0)) e.pilot_max_failures = 'A whole number ≥ 0, or empty';
      // A pilot is needed when it starts (new software) or while the software is still in its pilot.
      // Already-released software can be edited without one (the API asks if an installer change restarts it).
      const pilotNeeded = !editing || editing.rollout?.stage === 'pilot';
      if (pilotNeeded && !form.release_now && !form.pilot_ngos.length && !form.pilot_donors.length && !serials.length)
        e.test_device_serials = 'Choose pilot laptops, or a pilot NGO/donor group';
      else if (!form.release_now && server && !server.device_targeting && serials.length && !form.pilot_ngos.length && !form.pilot_donors.length)
        e.test_device_serials = 'Your RMS server cannot target single laptops yet: add a pilot NGO or donor group';
      const bad = serials.filter((x) => !SERIAL_RE.test(x));
      if (bad.length) e.test_device_serials = `Invalid serial(s): ${bad.join(', ')}`;
      else if (serials.length > MAX_CANARY) e.test_device_serials = `Use at most ${MAX_CANARY} canary devices`;
    }
    return e;
  }

  const next = () => {
    const e = validateStep(step);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep((s) => s + 1);
  };

  const buildPayload = (): SoftwarePayload => ({
    software_name: form.software_name.trim(),
    version: form.version.trim() || null,
    description: form.description.trim() || null,
    is_active: form.is_active,
    source_type: form.source_type,
    file_name: form.source_type === 'rms-repository' ? uploaded?.file_name : null,
    storage_key: form.source_type === 'rms-repository' ? uploaded?.storage_key : null,
    file_size_bytes: form.source_type === 'rms-repository' ? uploaded?.file_size_bytes : null,
    sha256_checksum: form.source_type === 'rms-repository' ? uploaded?.sha256_checksum : null,
    winget_id: form.source_type === 'winget' ? form.winget_id.trim() : null,
    file_url: form.source_type === 'external_url' ? form.file_url.trim() : null,
    installer_type: form.installer_type || null,
    silent_args: form.silent_args,
    execution_context: form.execution_context,
    run_as: form.run_as,
    elevation: form.elevation,
    pre_install_script: form.pre_install_script.trim() || null,
    post_install_script: form.post_install_script.trim() || null,
    process_name_to_wait: form.process_name_to_wait.trim() || null,
    timeout_seconds: form.timeout_minutes * 60,
    is_portable: form.installer_type === 'Portable',
    target_install_path: supportsInstallDir ? form.target_install_path.trim() || null : null,
    create_desktop_shortcut: form.create_desktop_shortcut,
    timeout_minutes: form.timeout_minutes,
    is_global: form.is_global,
    assigned_donors: form.is_global ? [] : form.assigned_donors,
    assigned_ngos: form.is_global ? [] : form.assigned_ngos,
    test_device_serials: serials,
    detection_type: form.detection_type,
    detection_path: form.detection_type === 'exit_code_zero' ? null : form.detection_path.trim(),
    success_exit_codes: form.success_exit_codes.replace(/\s+/g, '') || null,
    install_priority: form.install_priority,
    max_retry_attempts: form.max_retry_attempts === '' ? null : Number(form.max_retry_attempts),
    min_rms_version: form.min_rms_version.trim() || null,
    pilot_ngos: form.release_now ? [] : form.pilot_ngos,
    pilot_donors: form.release_now ? [] : form.pilot_donors,
    pilot_required_successes: form.pilot_required_successes === '' ? null : Number(form.pilot_required_successes),
    pilot_max_failures: form.pilot_max_failures === '' ? null : Number(form.pilot_max_failures),
    auto_release: form.auto_release,
    release_now: form.release_now,
    replaces_software_id: editing ? form.replaces_software_id || null : basedOn ? String(basedOn.id) : null,
  });

  const save = async () => {
    for (const s of [0, 1, 2]) {
      const e = validateStep(s);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(s);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      const saved = editing ? await api.updateSoftware(editing.id, payload) : await api.createSoftware(payload);
      const st = saved.rollout?.stage;
      toast.success(editing ? 'Software updated' : 'Software added', {
        description: !saved.is_active
          ? 'Saved as paused.'
          : st === 'pilot'
            ? 'Installing on the pilot laptops at their next check-in. It is released automatically when the rule passes.'
            : 'Releasing to the targets at their next check-in.',
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      const { message, fields } = apiError(err);
      const code = axios.isAxiosError(err) ? (err.response?.data as { details?: { code?: string } } | undefined)?.details?.code : undefined;
      if (code === 'new_version_required' && editing && onNewVersion) {
        toast.error('Already installed: create a new version instead', {
          description: message,
          duration: 15000,
          action: { label: 'New version', onClick: () => onNewVersion(editing) },
        });
        return;
      }
      if (fields.length) {
        const e: Record<string, string> = {};
        fields.forEach((f) => (e[f.path] = f.message));
        setErrors(e);
        setStep(Math.min(...fields.map((f) => FIELD_STEP[f.path] ?? 2)));
      }
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  // Check canary serials against the device registry (warning only)
  const checkSerials = async () => {
    if (!serials.length) return setUnknownSerials([]);
    const results = await Promise.all(
      serials.map((s) => api.devices(s).then((hits) => (hits.some((h) => h.serial_number.toLowerCase() === s.toLowerCase()) ? null : s)).catch(() => null)),
    );
    setUnknownSerials(results.filter((x): x is string => !!x));
  };

  const close = () => {
    if (upload.uploading && !confirm('An upload is in progress. Cancel it and close?')) return;
    abort.current?.abort();
    onClose();
  };

  const isWinget = form.source_type === 'winget';
  // "More install options" opens by itself when something there is non-default or has an error.
  const moreOpen =
    showAdvanced ||
    form.execution_context !== 'SYSTEM' ||
    form.detection_type !== 'exit_code_zero' ||
    !!form.success_exit_codes ||
    (form.installer_type === 'Portable') ||
    (patch && !!(form.max_retry_attempts || form.min_rms_version || form.install_priority !== lim.install_priority_default)) ||
    ['execution_context', 'timeout_minutes', 'detection_path', 'target_install_path', 'success_exit_codes', 'install_priority', 'max_retry_attempts', 'min_rms_version'].some((k) => errors[k]);
  const typeInfo = form.installer_type && types ? types[form.installer_type] : null;
  const noPilot = !form.pilot_ngos.length && !form.pilot_donors.length && !serials.length;
  // Install location works for Portable and for every type with an installDirArg template (presets file).
  const dirTemplate = !isWinget && form.installer_type ? types?.[form.installer_type]?.installDirArg ?? null : null;
  const supportsInstallDir = !isWinget && (form.installer_type === 'Portable' || !!dirTemplate);
  const previewArgs = (() => {
    const path = form.target_install_path.trim();
    if (!dirTemplate || !path) return form.silent_args;
    const key = dirTemplate.split('{path}')[0].replace(/"$/, '').toLowerCase();
    if (form.silent_args.toLowerCase().split(/\s+/).some((a) => a.startsWith(key))) return form.silent_args;
    return `${form.silent_args} ${dirTemplate.replace('{path}', path)}`.trim();
  })();

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={editing ? `Edit “${editing.software_name}”` : basedOn ? `New version of “${basedOn.software_name}”` : 'Add new software'}
      subtitle={STEPS[step].title}
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            Step {step + 1} of {STEPS.length}
          </span>
          {step > 0 && (
            <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button onClick={next} disabled={upload.uploading}>
              Continue
            </Button>
          ) : (
            <Button onClick={save} loading={saving} icon={<Check className="h-4 w-4" />}>
              {editing ? 'Save changes' : form.is_active ? 'Save & deploy' : 'Save as paused'}
            </Button>
          )}
        </>
      }
    >
      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s.short} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              className={clsx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-500 dark:bg-slate-800',
              )}
            >
              {i < step ? <Check className="h-4 w-4" /> : i + 1}
            </button>
            <span className={clsx('hidden text-sm sm:inline', i === step ? 'font-medium' : 'text-slate-500')}>{s.short}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />}
          </li>
        ))}
      </ol>

      {/* ---------------- STEP 1 ---------------- */}
      {step === 0 && (
        <div className="space-y-5">
          <div>
            <label className="label">Package source</label>
            <Segmented<SourceType>
              value={form.source_type}
              onChange={(v) => {
                if (hasHistory && v !== editing!.source_type) {
                  toast.warning('Changing the source of a deployed software affects devices that have not installed it yet.');
                }
                set('source_type', v);
              }}
              options={(
                [
                  { value: 'rms-repository', icon: <Cloud className="h-4 w-4" />, fallback: 'Upload file' },
                  { value: 'winget', icon: <Package className="h-4 w-4" />, fallback: 'Winget package' },
                  { value: 'external_url', icon: <Link2 className="h-4 w-4" />, fallback: 'External script URL' },
                ] as const
              )
                .filter((o) => !defaults?.source_types || o.value in defaults.source_types)
                .map((o) => ({
                  value: o.value,
                  icon: o.icon,
                  label: defaults?.source_types?.[o.value]?.label ?? o.fallback,
                  description:
                    o.value === 'rms-repository' && allowedExt.length
                      ? allowedExt.map((x) => '.' + x).join(' ')
                      : defaults?.source_types?.[o.value]?.description,
                }))}
            />
          </div>

          {form.source_type === 'rms-repository' && (
            <Field label="Installer file" required error={errors.file_name || errors.storage_key || errors.sha256_checksum}>
              <FileDropzone
                state={upload}
                done={uploaded}
                accept={allowedExt}
                maxBytes={defaults?.max_upload_bytes ?? Number.MAX_SAFE_INTEGER}
                onPick={(f) => startUpload(f, sanitizeFileName(f.name))}
                onRetry={() => upload.file && startUpload(upload.file, upload.fileName)}
                onCancel={() => abort.current?.abort()}
                onFileNameChange={(n) => setUpload((u) => ({ ...u, fileName: n }))}
                onClear={() => {
                  setUploaded(null);
                  setUpload({ fileName: '', uploading: false });
                }}
              />
            </Field>
          )}

          {isWinget && (
            <Field
              label="Winget package ID"
              required
              error={errors.winget_id}
              help={
                <>
                  Exact ID, e.g. <code>Google.Chrome</code>, <code>VideoLAN.VLC</code>, <code>Brave.Brave</code>. Look it up with{' '}
                  <code>winget search &lt;name&gt;</code>.
                </>
              }
            >
              <input className={clsx('input font-mono', errors.winget_id && 'input-error')} value={form.winget_id} onChange={(e) => set('winget_id', e.target.value)} placeholder="Google.Chrome" />
            </Field>
          )}

          {form.source_type === 'external_url' && (
            <Field label="Script / installer URL" required error={errors.file_url} help="Devices download this URL directly. Prefer https:// so the file can't be tampered with in transit.">
              <input className={clsx('input font-mono', errors.file_url && 'input-error')} value={form.file_url} onChange={(e) => set('file_url', e.target.value)} placeholder="https://example.org/scripts/setup.ps1" />
              {form.file_url.startsWith('http://') && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> Plain http is not encrypted; consider hosting the script via “Upload file” instead.
                </p>
              )}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label="Display name" required error={errors.software_name} help={hasHistory ? 'Locked: devices track installs by this name.' : 'Shown to admins and recorded in device history.'}>
                <input
                  className={clsx('input', errors.software_name && 'input-error')}
                  value={form.software_name}
                  disabled={hasHistory}
                  onChange={(e) => set('software_name', e.target.value)}
                  placeholder="e.g. AI Tutor"
                />
              </Field>
            </div>
            <Field label="Version" error={errors.version}>
              <input className="input" value={form.version} onChange={(e) => set('version', e.target.value)} placeholder="1.4.0" />
            </Field>
          </div>
          <Field label="Description / release notes" error={errors.description}>
            <textarea className="input min-h-[80px]" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What changed, who requested it, known issues…" />
          </Field>
        </div>
      )}

      {/* ---------------- STEP 2 ---------------- */}
      {step === 1 && (
        <div className="space-y-5">
          {undetected && !isWinget && (
            <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Couldn't recognise this installer. Check the installer type, or ask the vendor for its silent-install switch.</span>
            </p>
          )}
          {detected && !isWinget && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <Check className="h-4 w-4 shrink-0" />
              <span>
                Detected <strong>{detected.label}</strong> from the file. It will install silently with the arguments below.
              </span>
            </p>
          )}
          {!isWinget && (
            <Field label="Installer type" required error={errors.installer_type} help={typeInfo?.hint}>
              <select
                className={clsx('input', errors.installer_type && 'input-error')}
                value={form.installer_type}
                onChange={(e) => setInstallerType(e.target.value as InstallerType)}
              >
                <option value="" disabled>
                  Select installer type…
                </option>
                {types &&
                  (Object.keys(types) as InstallerType[]).map((t) => (
                    <option key={t} value={t}>
                      {types[t].label}
                      {types[t].silentArgs ? `  —  ${types[t].silentArgs}` : ''}
                    </option>
                  ))}
              </select>
            </Field>
          )}

          {form.installer_type !== 'Portable' && (
            <Field
              label={isWinget ? 'Extra winget arguments (optional)' : 'Silent arguments'}
              error={errors.silent_args}
              help={isWinget ? 'Winget installs silently by default. Use e.g. --override "/S" for stubborn packages.' : 'Exactly what the device runs. Edit for custom flags like /DIR="C:\\AFE".'}
            >
              <div className="flex gap-2">
                <input
                  className={clsx('input font-mono', errors.silent_args && 'input-error')}
                  value={form.silent_args}
                  onChange={(e) => {
                    setArgsTouched(true);
                    set('silent_args', e.target.value);
                  }}
                  placeholder={isWinget ? '--scope machine' : '/S'}
                />
                {!isWinget && form.installer_type && typeInfo && form.silent_args !== typeInfo.silentArgs && (
                  <Button
                    variant="secondary"
                    title="Reset to preset"
                    icon={<RotateCcw className="h-4 w-4" />}
                    onClick={() => {
                      setArgsTouched(false);
                      set('silent_args', typeInfo.silentArgs);
                    }}
                  />
                )}
              </div>
            </Field>
          )}

          <button
            type="button"
            className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-left text-sm font-medium dark:border-slate-700"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={moreOpen}
          >
            More install options
            <span className="text-xs font-normal text-slate-500">
              {moreOpen ? 'Hide' : `${form.execution_context === 'SYSTEM' ? 'SYSTEM' : 'Logged-in user'} · ${form.timeout_minutes} min · ${form.target_install_path || 'default folder'}`}
            </span>
          </button>
          {moreOpen && (
          <>
          <Field label="Execution privilege" error={errors.execution_context}>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { v: 'SYSTEM' as const, icon: <ShieldCheck className="h-4 w-4" /> },
                { v: 'LOGGED_IN_USER' as const, icon: <User className="h-4 w-4" /> },
              ].map(({ v, icon }) => ({
                v,
                icon,
                t: defaults?.execution_contexts?.[v]?.label ?? v,
                d: defaults?.execution_contexts?.[v]?.description ?? '',
              })).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => {
                    set('execution_context', o.v);
                    set('run_as', o.v === 'LOGGED_IN_USER' ? 'user' : 'system');
                    set('elevation', o.v === 'LOGGED_IN_USER' ? 'none' : 'highest');
                  }}
                  className={clsx(
                    'flex items-start gap-3 rounded-xl border p-3 text-left transition',
                    form.execution_context === o.v ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700',
                  )}
                >
                  <span className={form.execution_context === o.v ? 'text-brand-600' : 'text-slate-400'}>{o.icon}</span>
                  <span>
                    <span className="block text-sm font-medium">{o.t}</span>
                    <span className="block text-xs text-slate-500">{o.d}</span>
                  </span>
                </button>
              ))}
            </div>
          </Field>

          {supportsInstallDir && (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/40">
              <p className="text-sm font-medium">Where it is installed on the laptop</p>
              <Field
                label={form.installer_type === 'Portable' ? 'Target folder' : 'Install location (optional)'}
                error={errors.target_install_path}
                help={
                  form.installer_type === 'Portable'
                    ? 'The file (or extracted .zip) is placed here.'
                    : dirTemplate
                      ? `Empty = the installer's default folder. Passed as ${dirTemplate.replace('{path}', '<path>')}. %ProgramFiles% style variables are allowed.`
                      : undefined
                }
              >
                <input
                  className={clsx('input font-mono', errors.target_install_path && 'input-error')}
                  value={form.target_install_path}
                  onChange={(e) => set('target_install_path', e.target.value)}
                  placeholder={form.installer_type === 'Portable' ? defaultPortablePath(form.software_name) : `%ProgramFiles%\\${form.software_name.replace(/[<>:"/\\|?*]/g, '').trim() || 'App'}`}
                />
              </Field>
              {form.installer_type === 'Portable' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 rounded" checked={form.create_desktop_shortcut} onChange={(e) => set('create_desktop_shortcut', e.target.checked)} />
                Create a desktop shortcut for all users
              </label>
              )}
            </div>
          )}

          <Field label={`Safety timeout: ${form.timeout_minutes} min`} error={errors.timeout_minutes} help="The installer is killed and reported as failed if it runs longer than this.">
            <input
              type="range"
              min={lim.timeout_min_minutes}
              max={lim.timeout_max_minutes}
              step={1}
              value={form.timeout_minutes}
              onChange={(e) => set('timeout_minutes', Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>{lim.timeout_min_minutes} min</span>
              <span>{lim.timeout_max_minutes} min</span>
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Success detection">
              <select className="input" value={form.detection_type} onChange={(e) => set('detection_type', e.target.value as DetectionType)}>
                {(
                  Object.entries(
                    defaults?.detection_types ?? { exit_code_zero: { label: 'Exit code' }, file_exists: { label: 'File exists' }, registry_key: { label: 'Registry key exists' } },
                  ) as [DetectionType, { label: string }][]
                ).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
            {form.detection_type !== 'exit_code_zero' && (
              <div className="sm:col-span-2">
                <Field label={form.detection_type === 'file_exists' ? 'File path to check' : 'Registry key'} required error={errors.detection_path}>
                  <input
                    className={clsx('input font-mono', errors.detection_path && 'input-error')}
                    value={form.detection_path}
                    onChange={(e) => set('detection_path', e.target.value)}
                    placeholder={form.detection_type === 'file_exists' ? 'C:\\Program Files\\<App>\\app.exe' : 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\<AppId>'}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Exit codes (+ server-patch-only extras, hidden without the patch) */}
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-medium">Exit codes{patch ? ' & rollout extras' : ''}</p>
            {(
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field
                label="Success exit codes"
                error={errors.success_exit_codes}
                help={`Comma-separated. Empty = default (${defaults?.default_success_exit_codes?.join(',') ?? '0'}). Used when detection is by exit code.`}
              >
                <input
                  className={clsx('input font-mono', errors.success_exit_codes && 'input-error')}
                  value={form.success_exit_codes}
                  onChange={(e) => set('success_exit_codes', e.target.value)}
                  placeholder={defaults?.default_success_exit_codes?.join(',') ?? '0'}
                />
              </Field>
              {patch && (
              <>
              <Field label="Install priority" error={errors.install_priority} help={`Lower installs first (0–${lim.install_priority_max}). Default ${lim.install_priority_default}.`}>
                <input
                  type="number"
                  min={0}
                  max={lim.install_priority_max}
                  className={clsx('input', errors.install_priority && 'input-error')}
                  value={form.install_priority}
                  onChange={(e) => set('install_priority', e.target.value === '' ? lim.install_priority_default : Number(e.target.value))}
                />
              </Field>
              <Field
                label="Automatic retries after failure"
                error={errors.max_retry_attempts}
                help={`Empty = fleet default (${lim.max_auto_retry_attempts}). 0 = never retry automatically; use Retry instead.`}
              >
                <input
                  type="number"
                  min={0}
                  max={lim.max_retry_attempts_ceiling}
                  className={clsx('input', errors.max_retry_attempts && 'input-error')}
                  value={form.max_retry_attempts}
                  onChange={(e) => set('max_retry_attempts', e.target.value)}
                  placeholder={String(lim.max_auto_retry_attempts)}
                />
              </Field>
              <Field label="Minimum RMS client version" error={errors.min_rms_version} help="Only offer to laptops whose RMS client is at least this version (devices.rms_version). Empty = all.">
                <input
                  className={clsx('input font-mono', errors.min_rms_version && 'input-error')}
                  value={form.min_rms_version}
                  onChange={(e) => set('min_rms_version', e.target.value)}
                  placeholder="e.g. 2.0.0"
                />
              </Field>
              </>
              )}
            </div>
            )}
          </div>

          {/* Custom scripts & process monitor */}
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 space-y-4">
            <p className="text-sm font-medium">Custom scripts & process monitor (optional)</p>
            <Field label="Process name to wait for" help="Optional process name to wait for completion (e.g. setup.exe).">
              <input
                className="input font-mono"
                value={form.process_name_to_wait}
                onChange={(e) => set('process_name_to_wait', e.target.value)}
                placeholder="setup.exe"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pre-install script (PowerShell)" help="Commands executed before starting the installer.">
                <textarea
                  className="input font-mono text-xs h-20 resize-y"
                  value={form.pre_install_script}
                  onChange={(e) => set('pre_install_script', e.target.value)}
                  placeholder="# PowerShell commands to run prior to install"
                />
              </Field>
              <Field label="Post-install script (PowerShell)" help="Commands executed after installer finishes.">
                <textarea
                  className="input font-mono text-xs h-20 resize-y"
                  value={form.post_install_script}
                  onChange={(e) => set('post_install_script', e.target.value)}
                  placeholder="# PowerShell commands to run after install"
                />
              </Field>
            </div>
          </div>
          </>
          )}
        </div>
      )}

      {/* ---------------- STEP 3 ---------------- */}
      {step === 2 && (
        <div className="space-y-5">
          {/* 1. Pilot */}
          <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-500/30 dark:bg-amber-500/5">
            <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <FlaskConical className="h-4 w-4 text-amber-600" /> 1 · Test first on pilot laptops
            </p>
            <p className="mb-3 text-xs text-slate-600 dark:text-slate-400">
              It installs only on these laptops first, then goes to everyone below when they succeed.
              {!server?.device_targeting && ' Tip: keep 2–5 test laptops in one NGO (e.g. "RMS Lab") and pick it here.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pilot NGOs / schools" help="Every laptop in these NGOs is a pilot laptop">
                <MultiSelect options={ngos} value={form.pilot_ngos} onChange={(v) => set('pilot_ngos', v)} placeholder="e.g. a lab NGO…" loading={lookupsLoading} />
              </Field>
              <Field label="Pilot donors" help="Every laptop of these donors is a pilot laptop">
                <MultiSelect options={donors} value={form.pilot_donors} onChange={(v) => set('pilot_donors', v)} placeholder="Optional…" loading={lookupsLoading} />
              </Field>
            </div>
            {(server?.device_targeting || serials.length > 0) && (
            <Field
              label={`Pilot laptops by serial (up to ${MAX_CANARY})`}
              error={errors.test_device_serials}
              help={server?.device_targeting ? 'Your RMS server supports single-laptop targeting.' : 'Needs the server patch to take effect.'}
            >
              <textarea
                className={clsx('input min-h-[64px] font-mono', errors.test_device_serials && 'input-error')}
                value={form.serialsText}
                onChange={(e) => set('serialsText', e.target.value)}
                onBlur={checkSerials}
                placeholder={'PF2X91AB\n5CD1234XYZ'}
              />
              <div className="mt-1 flex justify-between text-xs">
                <span className="text-amber-700 dark:text-amber-400">{unknownSerials.length > 0 && `Not found in RMS (yet): ${unknownSerials.join(', ')}`}</span>
                <span className={serials.length > MAX_CANARY ? 'text-red-600' : 'text-slate-500'}>
                  {serials.length}/{MAX_CANARY}
                </span>
              </div>
            </Field>
            )}
            {errors.test_device_serials && !(server?.device_targeting || serials.length > 0) && (
              <p className="mt-2 text-xs text-red-600">{errors.test_device_serials}</p>
            )}
          </section>

          {/* 2. Release targets */}
          <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Globe2 className="h-4 w-4" /> 2 · Then release to
            </p>
            <label className="mb-3 flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded" checked={form.is_global} onChange={(e) => set('is_global', e.target.checked)} />
              <span>
                <span className="block text-sm font-medium">All laptops (global)</span>
                <span className="block text-xs text-slate-500">Every laptop registered in RMS.</span>
              </span>
            </label>
            <div className={clsx('grid gap-4 sm:grid-cols-2', form.is_global && 'pointer-events-none opacity-50')}>
              <Field label="Donors">
                <MultiSelect options={donors} value={form.assigned_donors} onChange={(v) => set('assigned_donors', v)} placeholder="Select donors…" loading={lookupsLoading} disabled={form.is_global} />
              </Field>
              <Field label="NGOs / schools">
                <MultiSelect options={ngos} value={form.assigned_ngos} onChange={(v) => set('assigned_ngos', v)} placeholder="Select NGOs…" loading={lookupsLoading} disabled={form.is_global} />
              </Field>
            </div>
          </section>

          {/* 3. Release rule */}
          <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">3 · Release rule</p>
              <Switch checked={form.auto_release} onChange={(v) => set('auto_release', v)} label="Release automatically" />
            </div>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {form.auto_release ? 'Release automatically' : 'Wait for my click'} when{' '}
              <strong>{form.pilot_required_successes || 'all'}</strong> pilot laptop(s) succeed and no more than{' '}
              <strong>{form.pilot_max_failures || defaults?.rollout?.default_max_failures || 0}</strong> fail.{' '}
              <button type="button" className="text-brand-600 underline" onClick={() => setShowRule((v) => !v)}>
                {showRule ? 'Done' : 'Change'}
              </button>
            </p>
            {(showRule || errors.pilot_required_successes || errors.pilot_max_failures) && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Pilot laptops that must succeed" error={errors.pilot_required_successes} help="Empty = all pilot laptops">
                <input
                  type="number"
                  min={1}
                  className={clsx('input', errors.pilot_required_successes && 'input-error')}
                  value={form.pilot_required_successes}
                  onChange={(e) => set('pilot_required_successes', e.target.value)}
                  placeholder={defaults?.rollout?.default_required_successes ? String(defaults.rollout.default_required_successes) : 'all'}
                />
              </Field>
              <Field label="Failures allowed" error={errors.pilot_max_failures} help="More failures than this stops the rollout">
                <input
                  type="number"
                  min={0}
                  className={clsx('input', errors.pilot_max_failures && 'input-error')}
                  value={form.pilot_max_failures}
                  onChange={(e) => set('pilot_max_failures', e.target.value)}
                  placeholder={String(defaults?.rollout?.default_max_failures ?? 0)}
                />
              </Field>
            </div>
            )}
            {!requirePilot && (
              <label className="mt-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                <input type="checkbox" className="h-4 w-4 rounded" checked={form.release_now} onChange={(e) => set('release_now', e.target.checked)} />
                Skip the pilot and release to the targets now
              </label>
            )}
            {errors.release_now && <p className="mt-1 text-xs text-red-600">{errors.release_now}</p>}
          </section>

          <div className="flex items-center justify-between rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div>
              <p className="text-sm font-medium">{form.is_active ? 'Active' : 'Paused: save without installing anywhere'}</p>
              <p className="text-xs text-slate-500">Pausing stops it on every laptop (pilot and released).</p>
            </div>
            <Switch checked={form.is_active} onChange={(v) => set('is_active', v)} label="Active" />
          </div>

          {/* Summary */}
          <div className="rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-900">
            <p className="mb-2 font-medium">Summary</p>
            <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-slate-600 dark:text-slate-400">
              <dt>Software</dt>
              <dd className="text-slate-900 dark:text-slate-100">
                {form.software_name || '—'} {form.version && <span className="text-slate-500">v{form.version.replace(/^v/i, '')}</span>}
              </dd>
              <dt>Install</dt>
              <dd className="break-all font-mono text-xs">
                {isWinget
                  ? `winget install --id ${form.winget_id} --silent ${form.silent_args}`
                  : form.installer_type === 'Portable'
                    ? `copy → ${form.target_install_path || defaultPortablePath(form.software_name)}`
                    : `${form.installer_type} ${previewArgs}`}
              </dd>
              <dt>Runs as</dt>
              <dd className="flex items-center gap-1">
                {form.execution_context === 'SYSTEM' ? <Monitor className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                {form.execution_context === 'SYSTEM' ? 'SYSTEM' : 'Logged-in user'} · timeout {form.timeout_minutes} min
              </dd>
              <dt>Delivery</dt>
              <dd>{isWinget ? 'winget on the laptop' : 'generated install script (works on RMS client 1.4.0)'}</dd>
              <dt>1 · Pilot</dt>
              <dd>
                {form.release_now
                  ? 'skipped'
                  : [
                      form.pilot_ngos.length && `${form.pilot_ngos.length} NGO(s)`,
                      form.pilot_donors.length && `${form.pilot_donors.length} donor(s)`,
                      serials.length && `${serials.length} laptop(s)${server && !server.device_targeting ? ' (need server patch)' : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'none'}
              </dd>
              <dt>2 · Release to</dt>
              <dd>
                {form.is_global
                  ? 'All laptops'
                  : [form.assigned_donors.length && `${form.assigned_donors.length} donor(s)`, form.assigned_ngos.length && `${form.assigned_ngos.length} NGO(s)`]
                      .filter(Boolean)
                      .join(' · ') || 'nobody yet (pilot only)'}
              </dd>
              <dt>3 · Rule</dt>
              <dd>
                {form.pilot_required_successes || 'all'} pilot laptop(s) succeed, ≤ {form.pilot_max_failures || defaults?.rollout?.default_max_failures || 0} fail ·{' '}
                {form.auto_release ? 'auto release' : 'manual release'}
              </dd>
            </dl>
            {noPilot && !form.release_now && (!editing || editing.rollout?.stage === 'pilot') && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> Choose at least one pilot NGO, donor or laptop.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
