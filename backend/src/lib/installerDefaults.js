/**
 * Installer-type behaviour, sourced from config/portal-presets.json
 * (override with PORTAL_PRESETS_FILE). The frontend fetches the same data via
 * GET /api/admin/lookups/installer-defaults, so the two sides never drift apart.
 */
import { presets, allowedExtensions } from '../settings.js';

export const INSTALLER_TYPES = presets.installer_types;
export const SOURCE_TYPES = Object.keys(presets.source_types);
export const EXECUTION_CONTEXTS = Object.keys(presets.execution_contexts);
export const DETECTION_TYPES = Object.keys(presets.detection_types);
export const ALLOWED_EXTENSIONS = allowedExtensions;

/** Guess an installer type from a file name (UI convenience; admins can override). */
export function guessInstallerType(fileName = '') {
  const ext = fileName.split('.').pop().toLowerCase();
  return presets.default_type_by_extension?.[ext] ?? Object.keys(INSTALLER_TYPES)[0];
}

export const defaultSilentArgs = (type) => INSTALLER_TYPES[type]?.silentArgs ?? '';
