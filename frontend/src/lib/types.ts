export type SourceType = 'rms-repository' | 'winget' | 'external_url';
export type InstallerType = 'InnoSetup' | 'NSIS' | 'MSI' | 'Portable' | 'Custom' | 'winget' | 'inno' | 'msi' | 'custom_exe' | 'script' | 'portable';
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
  run_as?: 'system' | 'user';
  elevation?: 'highest' | 'limited';
  pre_install_script?: string | null;
  post_install_script?: string | null;
  custom_install_script?: string | null;
  process_name_to_wait?: string | null;
  timeout_seconds?: number | null;
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
  /** Pilot groups (work on any RMS server); serials above need the server patch. */
  pilot_ngos: NamedRef[];
  pilot_donors: NamedRef[];
  pilot_required_successes: number | null;
  pilot_max_failures: number | null;
  auto_release: boolean;
  replaces_software_id?: string | null;
  live_is_global?: boolean;
  rollout: RolloutSummary;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  stats: SoftwareStats;
}

export type RolloutStage = 'pilot' | 'released';
export type GateOutcome = 'no_devices' | 'running' | 'passed' | 'failed';

export interface Gate {
  outcome: GateOutcome;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  required: number;
  max_failures: number;
}

export interface RolloutSummary {
  stage: RolloutStage;
  pilot_outcome: 'running' | 'passed' | 'failed' | null;
  pilot_started_at: string | null;
  released_at: string | null;
  released_by: string | null;
  gate: Gate;
}

export interface ServerCapabilities {
  device_targeting: boolean;
  mode: 'auto' | 'env';
  server_patch: { version: string; last_seen_at: string; fresh: boolean } | null;
}

export interface PilotDevice {
  device_id: number | string;
  serial_number: string;
  username: string | null;
  location: string | null;
  ngo_name: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  last_attempt_at: string | null;
  exit_code: number | null;
  error_message: string | null;
}

export interface RolloutStatus {
  stage: RolloutStage;
  pilot_outcome: 'running' | 'passed' | 'failed' | null;
  auto_release: boolean;
  is_active: boolean;
  pilot_started_at: string | null;
  pilot_decided_at: string | null;
  released_at: string | null;
  released_by: string | null;
  gate: Gate;
  devices: PilotDevice[];
  unregistered_serials: string[];
  unreachable_serials: string[];
  server: ServerCapabilities;
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
  run_as?: 'system' | 'user';
  elevation?: 'highest' | 'limited';
  pre_install_script?: string | null;
  post_install_script?: string | null;
  custom_install_script?: string | null;
  process_name_to_wait?: string | null;
  timeout_seconds?: number | null;
  is_portable: boolean;
  target_install_path?: string | null;
  create_desktop_shortcut: boolean;
  timeout_minutes: number;
  is_global: boolean;
  assigned_donors: (number | string)[];
  assigned_ngos: (number | string)[];
  test_device_serials: string[];
  pilot_ngos: (number | string)[];
  pilot_donors: (number | string)[];
  pilot_required_successes?: number | null;
  pilot_max_failures?: number | null;
  auto_release: boolean;
  release_now?: boolean;
  replaces_software_id?: string | number | null;
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
  /** e.g. '/DIR="{path}"'. null = no install-location switch for this type. */
  installDirArg?: string | null;
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
  installer_detection?: {
    scan_head_bytes?: number;
    scan_tail_bytes?: number;
    rules: { label: string; type: InstallerType; text?: string; magic_hex?: string; silentArgs?: string }[];
  } | null;
  allowed_extensions: string[];
  max_upload_bytes: number;
  public_download_base_url: string | null;
  limits: Limits;
  rollout: {
    require_pilot: boolean;
    auto_release_default: boolean;
    default_required_successes: number | null;
    default_max_failures: number;
    allow_force_release: boolean;
    max_pilot_groups: number;
  };
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

// ---------------------------------------------------------------------------
// Laptops view (GET /api/admin/devices)
// ---------------------------------------------------------------------------
export interface LaptopRow {
  device_id: number | string;
  serial_number: string;
  username: string | null;
  location: string | null;
  ngo_name: string | null;
  donor_name: string | null;
  rms_version: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  targeted: number;
  installed: number;
  failed: number;
  waiting: number;
  last_install_at: string | null;
}

export interface LaptopSummary {
  laptops: number | string;
  complete: number | string;
  with_waiting: number | string;
  with_failures: number | string;
  installs: number | string;
  failed_installs: number | string;
  waiting_installs: number | string;
}

export type LaptopSoftwareStatus = 'installed' | 'failed' | 'waiting';

export interface LaptopSoftware {
  software_id: string | null;
  software_name: string;
  version: string | null;
  source: SourceType | null;
  stage: RolloutStage | null;
  targeted: boolean;
  status: LaptopSoftwareStatus;
  attempts: number;
  last_attempt_at: string | null;
  last_history_id: number | string | null;
  exit_code: number | null;
  error_message: string | null;
  not_in_portal: boolean;
}

export interface LaptopDetail {
  device: LaptopRow;
  softwares: LaptopSoftware[];
  server: ServerCapabilities;
}
