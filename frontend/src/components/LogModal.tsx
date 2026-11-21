import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, RotateCw, XCircle } from 'lucide-react';
import { Badge, Button, Modal, Spinner } from './ui';
import { api, apiError } from '../lib/api';
import { formatDate } from '../lib/format';
import { useDefaults, useServerPatch } from '../lib/defaults';
import type { HistoryDetail, HistoryRow } from '../lib/types';


export function LogModal({ row, onClose, onRetried }: { row: HistoryRow | null; onClose: () => void; onRetried: () => void }) {
  const [d, setD] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const defaults = useDefaults();
  const patch = useServerPatch();

  useEffect(() => {
    if (!row) return;
    setD(null);
    setLoading(true);
    api
      .historyDetail(row.id)
      .then(setD)
      .catch((e) => toast.error(apiError(e).message))
      .finally(() => setLoading(false));
  }, [row]);

  const retry = async () => {
    if (!row?.software_id || !row.serial_number) return;
    setRetrying(true);
    try {
      await api.retry(row.software_id, { serial_numbers: [row.serial_number] });
      toast.success('Retry queued', { description: `${row.serial_number} will re-attempt ${row.software_name} on its next check-in.` });
      onRetried();
      onClose();
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setRetrying(false);
    }
  };

  const log = d?.log_output?.trim();
  // Server-side diagnosis first (exit code or error pattern), then the shared exit-code catalog.
  const catalog = d?.exit_code != null ? defaults?.exit_codes?.[String(d.exit_code)] : undefined;
  const dx = d?.diagnosis ?? (catalog ? { ...catalog, source: 'exit_code' as const, code: d!.exit_code! } : null);
  const exitHint = dx ? `${dx.title}. ${dx.hint}` : undefined;
  const successCodes = d?.success_exit_codes ?? defaults?.default_success_exit_codes?.join(',');

  return (
    <Modal
      open={!!row}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          {row?.is_successful ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-red-500" />}
          {row?.software_name} on {row?.serial_number ?? `device #${row?.device_id}`}
        </span>
      }
      subtitle={row ? formatDate(row.created_at) : undefined}
      footer={
        <>
          {log && (
            <Button
              variant="secondary"
              icon={<Copy className="h-4 w-4" />}
              onClick={() => navigator.clipboard.writeText(log).then(() => toast.success('Log copied'))}
            >
              Copy log
            </Button>
          )}
          {row && !row.is_successful && !patch && (
            <span className="mr-auto text-xs text-slate-500">This laptop retries automatically the next time RMS starts.</span>
          )}
          {row && !row.is_successful && patch && (
            <Button onClick={retry} loading={retrying} disabled={!row.software_id || !row.serial_number || !!row.retry_requested_at} icon={<RotateCw className="h-4 w-4" />}>
              {row.retry_requested_at ? 'Retry already queued' : 'Retry deployment'}
            </Button>
          )}
        </>
      }
    >
      {loading || !d ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <Info label="Status">{d.is_successful ? <Badge color="green">Success</Badge> : <Badge color="red">Failed</Badge>}</Info>
            <Info label="Exit code">{d.exit_code ?? '—'}</Info>
            <Info label="Device">{[d.model ?? d.username, d.ngo_name ?? d.location].filter(Boolean).join(' · ') || '—'}</Info>
            <Info label="Version">{d.software_version ?? d.current_version ?? '—'}</Info>
            <Info label="Installer">{d.installer_type ?? d.source ?? '—'}</Info>
            <Info label="Context">{d.execution_context ?? '—'}</Info>
            <Info label="Timeout">{d.timeout_minutes ? `${d.timeout_minutes} min` : '—'}</Info>
            <Info label="Silent args">
              <code className="break-all text-xs">{d.silent_args || '—'}</code>
            </Info>
            <Info label="Success codes">
              <code className="text-xs">{successCodes || '—'}</code>
            </Info>
            <Info label="Donor">{d.donor_name ?? '—'}</Info>
          </div>

          {d.script_reported_success != null && d.script_reported_success !== d.is_successful && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              The install script reported <strong>{d.script_reported_success ? 'success' : 'failure'}</strong>, but the RMS client recorded{' '}
              <strong>{d.is_successful ? 'success' : 'failure'}</strong>. The 1.4.0 client checks after a fixed timer, so a slow install can finish after it
              gave up. It is re-checked at the next check-in.
            </div>
          )}

          {(d.error_message || exitHint) && (
            <div
              className={
                dx?.severity === 'warning'
                  ? 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10'
                  : 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-500/30 dark:bg-red-500/10'
              }
            >
              {d.error_message && <p className="font-medium text-red-800 dark:text-red-300">{d.error_message}</p>}
              {exitHint && (
                <p className="mt-1 text-red-700/80 dark:text-red-300/80">
                  {dx?.code != null ? `Exit ${dx.code}: ` : 'Diagnosis: '}
                  {exitHint}
                </p>
              )}
            </div>
          )}

          <div>
            <p className="label">Client transcript</p>
            {log ? (
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
                {log.split('\n').map((line, i) => (
                  <span key={i} className={/error|fail|denied|exception|timed out|mismatch/i.test(line) ? 'text-red-400' : /warn/i.test(line) ? 'text-amber-300' : undefined}>
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
                No transcript was sent for this attempt. Laptops on the older RMS client only report success/failure. Update the client (see the
                integration guide) to capture PowerShell/winget logs, exit codes and error messages.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-900">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}
