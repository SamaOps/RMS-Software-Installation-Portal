/**
 * Plain-English diagnosis of an install attempt, driven entirely by
 * config/portal-presets.json (exit_codes + error_patterns).
 */
import { presets } from '../settings.js';

const patterns = (presets.error_patterns || [])
  .map((p) => {
    try {
      return { ...p, re: new RegExp(p.match, 'i') };
    } catch {
      console.warn(`[diagnostics] ignoring invalid error_patterns regex: ${p.match}`);
      return null;
    }
  })
  .filter(Boolean);

/**
 * @returns {{ source: 'exit_code'|'pattern', code?: number, severity: string, title: string, hint: string } | null}
 */
export function diagnose(exitCode, errorMessage, logOutput) {
  if (exitCode !== null && exitCode !== undefined) {
    const hit = presets.exit_codes?.[String(exitCode)];
    if (hit) return { source: 'exit_code', code: Number(exitCode), ...hit };
  }
  const text = `${errorMessage || ''}\n${(logOutput || '').slice(-4000)}`;
  for (const p of patterns) {
    if (p.re.test(text)) return { source: 'pattern', severity: p.severity || 'error', title: p.title, hint: p.hint };
  }
  return null;
}
