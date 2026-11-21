/**
 * Pure pilot rules: no DB access, so both the API (lib/rollout.js) and the offline demo use them.
 */
import { rollout as R } from '../settings.js';

export function effectiveRequired(sw, total) {
  const wanted = sw.pilot_required_successes ?? R.defaultRequiredSuccesses ?? total;
  return total > 0 ? Math.max(1, Math.min(wanted, total)) : wanted ?? 0;
}
export const effectiveMaxFailures = (sw) => sw.pilot_max_failures ?? R.defaultMaxFailures;

/** @returns {{ outcome: 'no_devices'|'running'|'passed'|'failed', total, succeeded, failed, pending, required, max_failures }} */
export function evaluateGate(sw, { total, succeeded, failed }) {
  const required = effectiveRequired(sw, total);
  const maxFailures = effectiveMaxFailures(sw);
  const pending = Math.max(0, total - succeeded - failed);
  let outcome = 'running';
  if (total === 0) outcome = 'no_devices';
  else if (failed > maxFailures) outcome = 'failed';
  else if (succeeded >= required) outcome = 'passed';
  return { outcome, total, succeeded, failed, pending, required, max_failures: maxFailures };
}

