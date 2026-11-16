import { z } from 'zod';
import {
  INSTALLER_TYPES,
  SOURCE_TYPES,
  EXECUTION_CONTEXTS,
  DETECTION_TYPES,
  defaultSilentArgs,
} from './installerDefaults.js';
import { config } from '../config.js';
import { allowedExtensions, fileNameRegex, limits } from '../settings.js';

export const FILE_NAME_RE = fileNameRegex;
const EXT_LIST = allowedExtensions.map((e) => `.${e}`).join('/');
export const SERIAL_RE = /^[A-Za-z0-9._\-/]+$/; // RMS serials may contain "/" (see windows-rms-server logsController)
const EXIT_CODES_RE = /^-?\d+(\s*,\s*-?\d+)*$/;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}$/;
export const WINGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_+]{0,127}$/;
const WIN_PATH_RE = /^([A-Za-z]:\\|%[A-Za-z_]+%\\?)/;
const REG_PATH_RE = /^(HKLM|HKCU|HKCR|HKU|HKEY_[A-Z_]+)(:)?\\/i;
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;

const optText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const id = z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]);

export const softwareInput = z
  .object({
    // A. General
    software_name: z.string().trim().min(2, 'Name is required').max(200),
    version: optText(50),
    description: optText(5000),
    is_active: z.boolean().default(true),

    // B. Source
    source_type: z.enum(SOURCE_TYPES),
    file_name: optText(255),
    storage_key: optText(1024),
    file_size_bytes: z.number().int().nonnegative().optional().nullable(),
    sha256_checksum: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/, 'Must be a 64-char hex SHA-256')
      .optional()
      .nullable(),
    winget_id: optText(128),
    file_url: optText(2048),

    // C. Execution
    installer_type: z.enum(Object.keys(INSTALLER_TYPES)).optional().nullable(),
    silent_args: z
      .string()
      .max(2000)
      .regex(NO_CONTROL_CHARS, 'Silent args must be a single line')
      .optional()
      .nullable(),
    execution_context: z.enum(EXECUTION_CONTEXTS).default('SYSTEM'),
    is_portable: z.boolean().optional(),
    target_install_path: optText(500),
    create_desktop_shortcut: z.boolean().default(true),
    timeout_minutes: z
      .number()
      .int()
      .min(limits.timeoutMinMinutes, `Minimum is ${limits.timeoutMinMinutes} minutes`)
      .max(limits.timeoutMaxMinutes, `Maximum is ${limits.timeoutMaxMinutes} minutes`)
      .default(limits.timeoutDefaultMinutes),
    success_exit_codes: z
      .string()
      .trim()
      .max(200)
      .regex(EXIT_CODES_RE, 'Comma-separated integers, e.g. 0,3010,1641')
      .optional()
      .nullable()
      .or(z.literal('')),

    // Rollout behaviour
    install_priority: z.number().int().min(0).max(limits.installPriorityMax).default(limits.installPriorityDefault),
    max_retry_attempts: z.number().int().min(0).max(limits.maxRetryAttemptsCeiling).optional().nullable(),
    min_rms_version: z.string().trim().regex(VERSION_RE, 'Use a version like 2.1.0').optional().nullable().or(z.literal('')),

    // D. Targeting
    is_global: z.boolean().default(false),
    assigned_donors: z.array(id).max(500).default([]),
    assigned_ngos: z.array(id).max(2000).default([]),
    test_device_serials: z
      .array(z.string().trim().min(3).max(100).regex(SERIAL_RE, 'Invalid serial number'))
      .max(limits.canaryMaxDevices, `Use at most ${limits.canaryMaxDevices} canary devices`)
      .default([]),

    // E. Verification
    detection_type: z.enum(DETECTION_TYPES).default('exit_code_zero'),
    detection_path: optText(1000),
  })
  .superRefine((d, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (d.source_type === 'rms-repository') {
      if (!d.file_name) issue('file_name', 'Upload a file first');
      else if (!FILE_NAME_RE.test(d.file_name))
        issue('file_name', `Only letters, digits, . _ - and one of ${EXT_LIST}`);
      if (!d.storage_key) issue('storage_key', 'Upload a file first');
      if (!d.sha256_checksum) issue('sha256_checksum', 'Checksum is required for uploaded files');
      if (!d.file_size_bytes) issue('file_size_bytes', 'File size is required for uploaded files');
      if (!d.installer_type) issue('installer_type', 'Choose an installer type');
    }

    if (d.source_type === 'winget') {
      if (!d.winget_id) issue('winget_id', 'Winget package ID is required (e.g. Google.Chrome)');
      else if (!WINGET_ID_RE.test(d.winget_id)) issue('winget_id', 'Invalid winget package ID');
    }

    if (d.source_type === 'external_url') {
      let u;
      try {
        u = new URL(d.file_url || '');
      } catch {
        issue('file_url', 'A valid URL is required');
      }
      const okProto = config.allowHttpExternalUrls ? ['https:', 'http:'] : ['https:'];
      if (u && !okProto.includes(u.protocol))
        issue('file_url', config.allowHttpExternalUrls ? 'Only http(s):// URLs are allowed' : 'Only https:// URLs are allowed');
      if (u && !FILE_NAME_RE.test(decodeURIComponent(u.pathname.split('/').pop() || '')))
        issue('file_url', `URL must end in a file name with ${EXT_LIST}`);
      if (!d.installer_type) issue('installer_type', 'Choose an installer type');
    }

    if (d.target_install_path && !WIN_PATH_RE.test(d.target_install_path))
      issue('target_install_path', 'Use an absolute Windows path (C:\\...) or %VARIABLE%\\...');

    if (d.detection_type === 'file_exists') {
      if (!d.detection_path) issue('detection_path', 'Path to check is required');
      else if (!WIN_PATH_RE.test(d.detection_path)) issue('detection_path', 'Use an absolute Windows file path');
    }
    if (d.detection_type === 'registry_key') {
      if (!d.detection_path) issue('detection_path', 'Registry key is required');
      else if (!REG_PATH_RE.test(d.detection_path))
        issue('detection_path', 'Use a key like HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\<id>');
    }

    if (d.execution_context === 'LOGGED_IN_USER' && d.target_install_path?.toLowerCase().includes('program files'))
      issue('execution_context', 'Per-user installs usually cannot write to Program Files. Use SYSTEM or a %LOCALAPPDATA% path.');
  })
  .transform((d) => {
    const isPortable = d.installer_type === 'Portable' || d.is_portable === true;
    const fileName =
      d.source_type === 'external_url'
        ? decodeURIComponent(new URL(d.file_url).pathname.split('/').pop())
        : d.source_type === 'rms-repository'
          ? d.file_name
          : null;
    return {
      ...d,
      is_portable: isPortable,
      file_name: fileName,
      // winget_id keeps its legacy meaning: winget package ID OR the downloadable file name.
      // The existing client downloads `${BACKEND}/softwares/${winget_id}`.
      winget_id: d.source_type === 'winget' ? d.winget_id : fileName,
      // Store the EFFECTIVE args: what is stored is exactly what runs.
      silent_args:
        d.silent_args === undefined || d.silent_args === null
          ? defaultSilentArgs(d.installer_type)
          : d.silent_args.trim(),
      target_install_path:
        d.target_install_path || (isPortable ? `C:\\Program Files\\${d.software_name.replace(/[<>:"/\\|?*]/g, '')}` : null),
      detection_path: d.detection_type === 'exit_code_zero' ? null : d.detection_path,
      test_device_serials: [...new Set(d.test_device_serials)],
      assigned_donors: [...new Set(d.assigned_donors.map(String))],
      assigned_ngos: [...new Set(d.assigned_ngos.map(String))],
      // Only rms-repository rows carry storage metadata.
      storage_key: d.source_type === 'rms-repository' ? d.storage_key : null,
      sha256_checksum: d.source_type === 'rms-repository' ? d.sha256_checksum : (d.sha256_checksum ?? null),
      file_size_bytes: d.source_type === 'rms-repository' ? d.file_size_bytes : (d.file_size_bytes ?? null),
      file_url: d.source_type === 'external_url' ? d.file_url : null,
      success_exit_codes: d.success_exit_codes
        ? [...new Set(d.success_exit_codes.split(',').map((x) => Number(x.trim())))].join(',')
        : null,
      max_retry_attempts: d.max_retry_attempts ?? null,
      min_rms_version: d.min_rms_version || null,
    };
  });

export const uploadRequest = z.object({
  file_name: z.string().trim().regex(FILE_NAME_RE, 'Rename the file: only letters, digits, . _ - are allowed'),
  file_size_bytes: z.number().int().positive(),
  content_type: z.string().max(200).optional(),
  overwrite: z.boolean().default(false),
});

export const multipartSignRequest = z.object({
  storage_key: z.string().min(1),
  upload_id: z.string().min(1),
  part_numbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
});

export const multipartCompleteRequest = z.object({
  storage_key: z.string().min(1),
  upload_id: z.string().min(1),
  parts: z
    .array(z.object({ PartNumber: z.number().int().min(1), ETag: z.string().min(1) }))
    .min(1)
    .max(10000),
});
