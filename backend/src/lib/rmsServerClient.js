/**
 * Client for windows-rms-server Software Management REST API.
 * 
 * Supports:
 *   POST   /api/softwares      (Create software)
 *   PUT    /api/softwares/:id  (Update software)
 *   GET    /api/softwares/:id  (Get software by ID)
 *   DELETE /api/softwares/:id  (Delete software)
 *   GET    /api/softwares      (List all software)
 * 
 * Includes HMAC-SHA256 authentication:
 *   X-API-Signature: HMAC-SHA256(API_KEY, timestamp)
 *   X-Timestamp: Unix timestamp in seconds
 */

import crypto from 'node:crypto';
import { config } from '../config.js';

const ALLOWED_FIELDS = new Set([
  'softwareName',
  'wingetId',
  'source',
  'isGlobal',
  'installerType',
  'silentArgs',
  'runAs',
  'elevation',
  'timeoutSeconds',
  'successExitCodes',
  'isPortable',
  'isActive',
  'preInstallScript',
  'postInstallScript',
  'customInstallScript',
]);

/** Convert portal installer types ('InnoSetup', 'NSIS', etc.) to server types ('inno', 'msi', 'custom_exe', etc.) */
export function toServerInstallerType(type) {
  if (!type) return 'winget';
  const lower = String(type).toLowerCase();
  if (lower === 'innosetup' || lower === 'inno') return 'inno';
  if (lower === 'msi') return 'msi';
  if (lower === 'winget') return 'winget';
  if (lower === 'script') return 'script';
  if (lower === 'custom_exe') return 'custom_exe';
  return 'custom_exe';
}

/** Convert silent args string/object to server { switches: [...] } or object */
export function toServerSilentArgs(silentArgs) {
  if (!silentArgs) return {};
  if (typeof silentArgs === 'object') {
    if (Array.isArray(silentArgs)) return { switches: silentArgs };
    return silentArgs;
  }
  const str = String(silentArgs).trim();
  if (!str) return {};
  const switches = str.split(/\s+/).filter(Boolean);
  return { switches, args: str };
}

/** Map portal software model to strict camelCase payload accepted by windows-rms-server */
export function formatServerPayload(d, isUpdate = false) {
  const payload = {};

  if (d.software_name !== undefined) payload.softwareName = d.software_name;
  if (d.winget_id !== undefined) payload.wingetId = d.winget_id;
  if (d.source_type !== undefined || d.source !== undefined) {
    payload.source = d.source_type || d.source || 'winget';
  }
  if (d.is_global !== undefined) payload.isGlobal = Boolean(d.is_global);
  if (d.installer_type !== undefined) {
    payload.installerType = toServerInstallerType(d.installer_type);
  }
  if (d.silent_args !== undefined) {
    payload.silentArgs = toServerSilentArgs(d.silent_args);
  }
  if (d.run_as !== undefined || d.execution_context !== undefined) {
    payload.runAs = d.run_as || (d.execution_context === 'LOGGED_IN_USER' ? 'user' : 'system');
  }
  if (d.elevation !== undefined || d.execution_context !== undefined) {
    const elev = d.elevation || (d.execution_context === 'LOGGED_IN_USER' ? 'limited' : 'highest');
    payload.elevation = elev === 'none' ? 'limited' : elev;
  }
  if (d.timeout_seconds !== undefined || d.timeout_minutes !== undefined) {
    payload.timeoutSeconds = Number(d.timeout_seconds || (d.timeout_minutes ? d.timeout_minutes * 60 : 600));
  }
  if (d.success_exit_codes !== undefined) {
    payload.successExitCodes = d.success_exit_codes ? String(d.success_exit_codes) : '0,3010';
  }
  if (d.is_portable !== undefined) payload.isPortable = Boolean(d.is_portable);
  if (d.is_active !== undefined || d.isactive !== undefined) {
    payload.isActive = d.is_active !== undefined ? Boolean(d.is_active) : Boolean(d.isactive);
  }
  if (d.pre_install_script !== undefined) payload.preInstallScript = d.pre_install_script || null;
  if (d.post_install_script !== undefined) payload.postInstallScript = d.post_install_script || null;
  if (d.custom_install_script !== undefined) payload.customInstallScript = d.custom_install_script || null;

  // Strict whitelist filter: windows-rms-server rejects any field not explicitly accepted with 400 Bad Request
  const cleaned = {};
  for (const [key, value] of Object.entries(payload)) {
    if (ALLOWED_FIELDS.has(key) && value !== undefined) {
      cleaned[key] = value;
    }
  }

  if (!isUpdate) {
    if (!cleaned.softwareName) throw new Error('softwareName is required');
    if (!cleaned.wingetId) throw new Error('wingetId is required');
    if (cleaned.source === undefined) cleaned.source = 'winget';
    if (cleaned.isGlobal === undefined) cleaned.isGlobal = true;
    if (cleaned.installerType === undefined) cleaned.installerType = 'winget';
    if (cleaned.silentArgs === undefined) cleaned.silentArgs = {};
    if (cleaned.runAs === undefined) cleaned.runAs = 'system';
    if (cleaned.elevation === undefined) cleaned.elevation = 'highest';
    if (cleaned.timeoutSeconds === undefined) cleaned.timeoutSeconds = 600;
  }

  return cleaned;
}

export class RmsServerClient {
  constructor(options = {}) {
    this.baseUrl = options.apiUrl || config.rmsServer?.apiUrl || '';
    this.apiKey = options.apiKey || config.rmsServer?.apiKey || '';
    this.authEnabled = options.authEnabled ?? config.rmsServer?.authEnabled ?? Boolean(this.apiKey);
    this.timeoutMs = options.timeoutMs || config.rmsServer?.timeoutMs || 10000;
  }

  isEnabled() {
    return Boolean(this.baseUrl);
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.authEnabled && this.apiKey) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = crypto
        .createHmac('sha256', this.apiKey)
        .update(timestamp)
        .digest('hex');
      headers['X-API-Signature'] = signature;
      headers['X-Timestamp'] = timestamp;
    }
    return headers;
  }

  async request(method, path, body = null) {
    if (!this.baseUrl) {
      throw new Error('RMS_SERVER_API_URL is not configured');
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const opts = {
        method,
        headers: this.getHeaders(),
        signal: controller.signal,
      };
      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const errorMsg = data?.error || data?.message || `RMS Server error ${res.status}`;
        const err = new Error(errorMsg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listSoftwares() {
    return this.request('GET', '/api/softwares');
  }

  async getSoftware(id) {
    return this.request('GET', `/api/softwares/${id}`);
  }

  async createSoftware(portalData) {
    const payload = formatServerPayload(portalData, false);
    return this.request('POST', '/api/softwares', payload);
  }

  async updateSoftware(id, portalData) {
    const payload = formatServerPayload(portalData, true);
    return this.request('PUT', `/api/softwares/${id}`, payload);
  }

  async deleteSoftware(id) {
    return this.request('DELETE', `/api/softwares/${id}`);
  }
}

export const rmsServerClient = new RmsServerClient();
