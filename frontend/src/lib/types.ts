export type SourceType = 'rms-repository' | 'winget' | 'external_url';
export type InstallerType = 'InnoSetup' | 'NSIS' | 'MSI' | 'Portable' | 'Custom';
export type ExecutionContext = 'SYSTEM' | 'LOGGED_IN_USER';
export type DetectionType = 'exit_code_zero' | 'file_exists' | 'registry_key';

export interface NamedRef {
  id: number | string;
  name: string;
}

export interface SoftwareStats {
  devices_targeted: number | null;
  devices_pending: number | null;
  devices_attempted: number;
  devices_succeeded: number;
  devices_failed: number;
  total_attempts: number;
  last_attempt_at: string | null;
  success_rate: number | null;
}

export interface Software {
  id: number | string;
  software_name: string;
  version: string | null;
  description: string | null;
  is_active: boolean;
  source_type: SourceType;
  winget_id: string | null;
  /** How deployed RMS clients receive it. 'install_script' = portal-generated .ps1 (works on client 1.4.0). */
  delivery?: 'winget' | 'install_script' | 'direct';
  client_script_url?: string | null;
  client_script_generated_at?: string | null;
  file_name: string | null;
  storage_key: string | null;
  file_url: string | null;
  download_url: string | null;
  file_size_bytes: number | null;
  sha256_checksum: string | null;
  checksum_verified_at: string | null;
  installer_type: InstallerType | null;
  silent_args: string | null;
  execution_context: ExecutionContext;
  is_portable: boolean;
  target_install_path: string | null;
  create_desktop_shortcut: boolean;
  timeout_minutes: number;
  is_global: boolean;
  detection_type: DetectionType;
  detection_path: string | null;
  success_exit_codes: string | null;
  install_priority: number;
  max_retry_attempts: number | null;
  effective_max_retry_attempts: number;
  min_rms_version: string | null;
  assigned_donors: NamedRef[];
  assigned_ngos: NamedRef[];
  test_device_serials: string[];
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  stats: SoftwareStats;
}

export interface SoftwarePayload {
  software_name: string;
  version?: string | null;
  description?: string | null;
  is_active: boolean;
  source_type: SourceType;
  file_name?: string | null;
  storage_key?: string | null;
  file_size_bytes?: number | null;
  sha256_checksum?: string | null;
  winget_id?: string | null;
  file_url?: string | null;
  installer_type?: InstallerType | null;
  silent_args?: string | null;
  execution_context: ExecutionContext;
  is_portable: boolean;
  target_install_path?: string | null;
  create_desktop_shortcut: boolean;
  timeout_minutes: number;
  is_global: boolean;
  assigned_donors: (number | string)[];
  assigned_ngos: (number | string)[];
  test_device_serials: string[];
  detection_type: DetectionType;
  detection_path?: string | null;
  success_exit_codes?: string | null;
  install_priority: number;
  max_retry_attempts?: number | null;
  min_rms_version?: string | null;
}

export interface InstallerTypeInfo {
  label: string;
  silentArgs: string;
  hint: string;
  extensions: string[];
}

export interface LabelInfo {
  label: string;
  description?: string;
}

export interface ExitCodeInfo {
  severity: 'success' | 'warning' | 'error';
  title: string;
  hint: string;
}

export interface Diagnosis extends ExitCodeInfo {
  source: 'exit_code' | 'pattern';
  code?: number;
}

export interface Limits {
  timeout_min_minutes: number;
  timeout_max_minutes: number;
  timeout_default_minutes: number;
  canary_min_devices: number;
  canary_max_devices: number;
  max_auto_retry_attempts: number;
  max_retry_attempts_ceiling: number;
  install_priority_default: number;
  install_priority_max: number;
  history_page_size: number;
  upload_concurrency: number;
  upload_part_retries: number;
  multipart_sign_batch: number;
  hash_chunk_bytes: number;
  analytics_daily_days: number;
  analytics_error_window_days: number;
}

/** Everything served by GET /api/admin/lookups/installer-defaults (env + config/portal-presets.json). */
export interface Defaults {
  installer_types: Record<InstallerType, InstallerTypeInfo>;
  default_type_by_extension: Record<string, InstallerType>;
  source_types: Record<SourceType, LabelInfo>;
  execution_contexts: Record<ExecutionContext, LabelInfo>;
  detection_types: Record<DetectionType, LabelInfo>;
  exit_codes: Record<string, ExitCodeInfo>;
  default_success_exit_codes: number[];
  allowed_extensions: string[];
  max_upload_bytes: number;
  public_download_base_url: string | null;
  limits: Limits;
  features?: { devices: boolean; donors: boolean; ngos: boolean; device_model: boolean };
  demo?: boolean;
}

export interface Analytics {
  inventory: {
    total_softwares: number;
    active_deployments: number;
    paused: number;
    global_count: number;
    repository_count: number;
    winget_count: number;
    external_count: number;
  };
  fleet: {
    device_software_pairs: number;
    succeeded: number;
    failed_needing_attention: number;
    success_rate: number | null;
    attempts_24h: number;
    devices_reporting: number;
  };
  daily: { date: string; success: number; failed: number }[];
  top_errors: { error: string; exit_code?: number | null; count: number }[];
  windows?: { recent_hours: number; daily_days: number; error_window_days: number };
}

export interface HistoryRow {
  id: number | string;
  device_id: number | string | null;
  serial_number: string | null;
  model: string | null;
  username?: string | null;
  location?: string | null;
  ngo_name: string | null;
  donor_name?: string | null;
  software_name: string;
  software_id: number | string | null;
  current_version: string | null;
  is_successful: boolean | null;
  created_at: string;
  error_message: string | null;
  exit_code: number | null;
  has_log: boolean;
  is_latest: boolean;
  retry_requested_at: string | null;
  diagnosis?: Diagnosis | null;
  /** Result the install script itself reported (can differ from the client's timer-based verdict). */
  script_reported_success?: boolean | null;
  script_reported_at?: string | null;
}

export interface HistoryDetail extends HistoryRow {
  log_output: string | null;
  software_version: string | null;
  installer_type: InstallerType | null;
  silent_args: string | null;
  execution_context: ExecutionContext | null;
  timeout_minutes: number | null;
  source: SourceType | null;
  success_exit_codes?: string | null;
}

export interface DeviceHit {
  serial_number: string;
  model: string | null;
  username?: string | null;
  location?: string | null;
  ngo_name: string | null;
  donor_name?: string | null;
}
