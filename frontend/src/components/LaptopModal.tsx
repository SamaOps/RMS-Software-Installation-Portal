import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Laptop, XCircle } from 'lucide-react';
import { Badge, Modal, Spinner } from './ui';
import { api, apiError } from '../lib/api';
import { formatDate, timeAgo } from '../lib/format';
import type { LaptopDetail } from '../lib/types';

/** One laptop: every software it should have, and what happened with each. */
export function LaptopModal({ serial, onClose }: { serial: string | null; onClose: () => void }) {
  const [d, setD] = useState<LaptopDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setD(null);
    if (!serial) return;
    setLoading(true);
    api
      .laptop(serial)
      .then(setD)
      .catch((e) => toast.error(apiError(e).message))
      .finally(() => setLoading(false));
  }, [serial]);

  const dev = d?.device;
  return (
    <Modal
      open={!!serial}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <Laptop className="h-5 w-5 text-brand-600" /> {serial}
        </span>
      }
      subtitle={dev ? [dev.username, dev.location, dev.ngo_name, dev.donor_name].filter(Boolean).join(' · ') : undefined}
    >
      {loading || !d || !dev ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Info label="Installed" value={`${dev.installed} / ${dev.targeted}`} tone={dev.targeted && dev.installed === dev.targeted ? 'good' : undefined} />
            <Info label="Failed" value={String(dev.failed)} tone={dev.failed ? 'bad' : undefined} />
            <Info label="Waiting" value={String(dev.waiting)} />
            <Info label="RMS version" value={dev.rms_version ?? '—'} />
            <Info label="Last seen" value={dev.last_seen_at ? timeAgo(dev.last_seen_at) : '—'} />
          </div>
          {!dev.is_active && <Badge color="gray">Marked inactive in RMS</Badge>}

          {d.softwares.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing is targeted at this laptop yet.</p>
          ) : (
            <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900">
                  <tr>
                    <th className="px-3 py-2">Software</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Attempts</th>
                    <th className="px-3 py-2">Last attempt</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {d.softwares.map((s) => (
                    <tr key={s.software_name} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2">
                        <span className="font-medium">{s.software_name}</span>
                        {s.version && <span className="ml-1 text-xs text-slate-500">v{s.version.replace(/^v/i, '')}</span>}
                        {s.stage === 'pilot' && <span className="ml-2 text-xs text-amber-600">pilot</span>}
                        {!s.targeted && <span className="ml-2 text-xs text-slate-400">{s.not_in_portal ? 'removed / paused' : 'no longer targeted'}</span>}
                      </td>
                      <td className="px-3 py-2">
                        {s.status === 'installed' && (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-4 w-4" /> Installed
                          </span>
                        )}
                        {s.status === 'failed' && (
                          <span className="flex items-center gap-1 text-red-600" title={s.error_message ?? undefined}>
                            <XCircle className="h-4 w-4" /> Failed{s.exit_code != null ? ` (exit ${s.exit_code})` : ''}
                          </span>
                        )}
                        {s.status === 'waiting' && (
                          <span className="flex items-center gap-1 text-slate-500">
                            <Clock className="h-4 w-4" /> Waiting for next RMS start
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">{s.attempts || '—'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{s.last_attempt_at ? formatDate(s.last_attempt_at) : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {s.attempts > 0 && (
                          <button
                            type="button"
                            className="text-xs text-brand-600 underline"
                            onClick={() => navigate(`/history?search=${encodeURIComponent(serial ?? '')}${s.software_id ? `&software_id=${s.software_id}` : ''}`)}
                          >
                            Logs
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">
            Same rules as the RMS server: a software is offered until it installs once. Failed ones are retried automatically the next time RMS starts on this
            laptop.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-900">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={tone === 'bad' ? 'font-semibold text-red-600' : tone === 'good' ? 'font-semibold text-emerald-600' : 'font-semibold'}>{value}</p>
    </div>
  );
}
