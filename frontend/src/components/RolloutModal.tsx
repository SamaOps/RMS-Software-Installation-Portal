import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Clock, FlaskConical, RefreshCw, Rocket, RotateCcw, XCircle } from 'lucide-react';
import { Badge, Button, Modal, Spinner } from './ui';
import { api, apiError } from '../lib/api';
import { formatDate, timeAgo } from '../lib/format';
import { useDefaults } from '../lib/defaults';
import type { RolloutStatus, Software } from '../lib/types';

/** Pilot → release panel: pilot laptops, their results, the release rule and the actions. */
export function RolloutModal({ software, onClose, onSaved }: { software: Software | null; onClose: () => void; onSaved: (s: Software) => void }) {
  const defaults = useDefaults();
  const [st, setSt] = useState<RolloutStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (id: Software['id']) => {
    setLoading(true);
    try {
      setSt(await api.rollout(id));
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSt(null);
    if (software) load(software.id);
  }, [software, load]);

  const act = async (name: string, fn: () => Promise<Software>, ok: string) => {
    if (!software) return;
    setBusy(name);
    try {
      const s = await fn();
      toast.success(ok);
      onSaved(s);
      await load(software.id);
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const g = st?.gate;
  const released = st?.stage === 'released';
  const canForce = defaults?.rollout?.allow_force_release ?? true;

  return (
    <Modal
      open={!!software}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-amber-600" /> Pilot & release
        </span>
      }
      subtitle={software?.software_name}
      footer={
        st && (
          <>
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'check'} onClick={() => act('check', async () => (await api.checkRollout(software!.id)).software, 'Pilot re-checked')}>
              Check now
            </Button>
            {released ? (
              <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={busy === 'pilot'} onClick={() => confirm('Stop releasing to new laptops and keep it on the pilot laptops only? Laptops that already installed it keep it.') && act('pilot', () => api.restartPilot(software!.id), 'Release stopped: pilot laptops only')}>
                Stop release
              </Button>
            ) : (
              <>
                {st.pilot_outcome === 'failed' && (
                  <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={busy === 'pilot'} onClick={() => act('pilot', () => api.restartPilot(software!.id), 'Pilot restarted')}>
                    Restart pilot
                  </Button>
                )}
                {g?.outcome === 'passed' ? (
                  <Button icon={<Rocket className="h-4 w-4" />} loading={busy === 'release'} onClick={() => act('release', () => api.release(software!.id), 'Released to the targets')}>
                    Release now
                  </Button>
                ) : (
                  canForce && (
                    <Button
                      variant="secondary"
                      icon={<Rocket className="h-4 w-4" />}
                      loading={busy === 'release'}
                      onClick={() =>
                        confirm(`The pilot has not passed (${g?.succeeded ?? 0}/${g?.required ?? 0} succeeded, ${g?.failed ?? 0} failed). Release to every target anyway?`) &&
                        act('release', () => api.release(software!.id, true), 'Released (pilot skipped)')
                      }
                    >
                      Release anyway
                    </Button>
                  )
                )}
              </>
            )}
          </>
        )
      }
    >
      {loading || !st || !g ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Stage + rule */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {released ? (
              <Badge color="green">Released {st.released_at && timeAgo(st.released_at)}{st.released_by ? ` by ${st.released_by}` : ''}</Badge>
            ) : st.pilot_outcome === 'failed' || g.outcome === 'failed' ? (
              <Badge color="red">Pilot failed: not released</Badge>
            ) : g.outcome === 'passed' ? (
              <Badge color="green">Pilot passed{st.auto_release ? ': releasing at the next check' : ': ready to release'}</Badge>
            ) : (
              <Badge color="amber">Pilot running</Badge>
            )}
            {!st.is_active && <Badge color="gray">Paused</Badge>}
            <span className="text-slate-500">
              Rule: {g.required} of {g.total} pilot laptop(s) succeed, at most {g.max_failures} fail · {st.auto_release ? 'auto release' : 'manual release'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Succeeded" value={`${g.succeeded}/${g.required}`} tone="good" />
            <Stat label="Failed" value={`${g.failed}/${g.max_failures} allowed`} tone={g.failed > g.max_failures ? 'bad' : undefined} />
            <Stat label="Waiting" value={String(g.pending)} />
          </div>

          {!st.server.device_targeting && st.unreachable_serials.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              {st.unreachable_serials.join(', ')} won't receive it: your RMS server can't target single laptops yet. Use a pilot NGO/donor group, or deploy the server
              patch.
            </p>
          )}
          {st.unregistered_serials.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">Not registered in RMS: {st.unregistered_serials.join(', ')}</p>
          )}
          {g.outcome === 'no_devices' && (
            <p className="text-sm text-slate-500">No pilot laptops found. Edit the software and choose a pilot NGO, donor or laptops.</p>
          )}

          {st.devices.length > 0 && (
            <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr>
                    <th className="px-3 py-2">Laptop</th>
                    <th className="px-3 py-2">Where</th>
                    <th className="px-3 py-2">Result</th>
                    <th className="px-3 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {st.devices.map((d) => (
                    <tr key={String(d.device_id)} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 font-mono text-xs">
                        {d.serial_number}
                        {d.username && <span className="block font-sans text-slate-500">{d.username}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">{[d.ngo_name, d.location].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-3 py-2">
                        {d.status === 'succeeded' && (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-4 w-4" /> Installed
                          </span>
                        )}
                        {d.status === 'failed' && (
                          <span className="flex items-center gap-1 text-red-600" title={d.error_message ?? undefined}>
                            <XCircle className="h-4 w-4" /> Failed{d.exit_code != null ? ` (exit ${d.exit_code})` : ''}
                          </span>
                        )}
                        {d.status === 'pending' && (
                          <span className="flex items-center gap-1 text-slate-500">
                            <Clock className="h-4 w-4" /> Waiting for check-in
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{d.last_attempt_at ? formatDate(d.last_attempt_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">
            Laptops check for new software when RMS starts. Restart the pilot laptops to test faster. Results include the install script's own report.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-900">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={tone === 'bad' ? 'text-lg font-semibold text-red-600' : tone === 'good' ? 'text-lg font-semibold text-emerald-600' : 'text-lg font-semibold'}>{value}</p>
    </div>
  );
}
