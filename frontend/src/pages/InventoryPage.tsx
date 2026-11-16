import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { toast } from 'sonner';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Cloud,
  FileSearch,
  FlaskConical,
  Globe2,
  Link2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { ActionsMenu } from '../components/ActionsMenu';
import { CanaryModal } from '../components/CanaryModal';
import { ClientScriptModal } from '../components/ClientScriptModal';
import { SoftwareWizard } from '../components/SoftwareWizard';
import { Badge, Button, ConfirmModal, EmptyState, Spinner, Switch } from '../components/ui';
import { api, apiError } from '../lib/api';
import { colorFor, formatBytes, timeAgo } from '../lib/format';
import type { Analytics, Defaults, Software } from '../lib/types';

type SourceFilter = '' | 'rms-repository' | 'winget' | 'external_url';
type TargetFilter = '' | 'global' | 'donor' | 'ngo' | 'canary' | 'unassigned';
type StatusFilter = '' | 'active' | 'paused';

export function InventoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Software[] | null>(null);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(false);

  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SourceFilter>('');
  const [target, setTarget] = useState<TargetFilter>('');
  const [status, setStatus] = useState<StatusFilter>('');

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<Software | null>(null);
  const [canary, setCanary] = useState<Software | null>(null);
  const [scriptOf, setScriptOf] = useState<Software | null>(null);
  const [deleting, setDeleting] = useState<Software | null>(null);
  const [retrying, setRetrying] = useState<Software | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, a] = await Promise.all([api.listSoftwares({}), api.analytics()]);
      setItems(list);
      setStats(a);
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api.defaults().then(setDefaults).catch(() => toast.error('Could not load installer presets'));
  }, [load]);

  const upsert = (s: Software) => {
    setItems((list) => {
      if (!list) return [s];
      const i = list.findIndex((x) => x.id === s.id);
      return i === -1 ? [s, ...list] : list.map((x) => (x.id === s.id ? s : x));
    });
    api.analytics().then(setStats).catch(() => {});
  };

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = search.trim().toLowerCase();
    return items.filter((s) => {
      if (q && !s.software_name.toLowerCase().includes(q) && !(s.winget_id ?? '').toLowerCase().includes(q) && !(s.file_name ?? '').toLowerCase().includes(q)) return false;
      if (source && s.source_type !== source) return false;
      if (status === 'active' && !s.is_active) return false;
      if (status === 'paused' && s.is_active) return false;
      if (target === 'global' && !s.is_global) return false;
      if (target === 'donor' && !s.assigned_donors.length) return false;
      if (target === 'ngo' && !s.assigned_ngos.length) return false;
      if (target === 'canary' && !s.test_device_serials.length) return false;
      if (target === 'unassigned' && (s.is_global || s.assigned_donors.length || s.assigned_ngos.length || s.test_device_serials.length)) return false;
      return true;
    });
  }, [items, search, source, target, status]);

  const toggleActive = async (s: Software, v: boolean) => {
    setBusy((b) => ({ ...b, [s.id]: true }));
    setItems((list) => list?.map((x) => (x.id === s.id ? { ...x, is_active: v } : x)) ?? null); // optimistic
    try {
      upsert(await api.setActive(s.id, v));
      toast.success(v ? `${s.software_name} resumed` : `${s.software_name} paused`, {
        description: v ? 'Devices will install it on their next check-in.' : 'No new devices will receive it.',
      });
    } catch (e) {
      setItems((list) => list?.map((x) => (x.id === s.id ? s : x)) ?? null);
      toast.error(apiError(e).message);
    } finally {
      setBusy((b) => ({ ...b, [s.id]: false }));
    }
  };

  const verify = async (s: Software) => {
    const id = toast.loading(`Verifying ${s.file_name} in storage…`);
    try {
      const r = await api.verifyChecksum(s.id);
      if (r.ok) toast.success('Checksum verified: stored file is intact', { id });
      else toast.error('Checksum mismatch! Re-upload this file.', { id, description: `expected ${r.expected.slice(0, 12)}… got ${r.actual.slice(0, 12)}…` });
      load();
    } catch (e) {
      toast.error(apiError(e).message, { id });
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await api.deleteSoftware(deleting.id);
      setItems((l) => l?.filter((x) => x.id !== deleting.id) ?? null);
      toast.success(`${deleting.software_name} deleted`, { description: 'Deployment stopped. The file is kept in storage.' });
      setDeleting(null);
      api.analytics().then(setStats).catch(() => {});
    } catch (e) {
      toast.error(apiError(e).message);
    }
  };

  const doRetryAll = async () => {
    if (!retrying) return;
    try {
      const r = await api.retry(retrying.id, { all_failed: true });
      toast.success(`Retry queued for ${r.queued} device(s)`);
      setRetrying(null);
    } catch (e) {
      toast.error(apiError(e).message);
    }
  };

  const f = stats?.fleet;
  const inv = stats?.inventory;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Software inventory</h1>
          <p className="text-sm text-slate-500">Upload, configure and target software for RMS-managed laptops.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load} loading={loading} icon={<RefreshCw className="h-4 w-4" />}>
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setWizardOpen(true);
            }}
            icon={<Plus className="h-4 w-4" />}
          >
            Upload / Add new software
          </Button>
        </div>
      </div>

      {/* Header stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Boxes />} label="Softwares managed" value={inv?.total_softwares} sub={inv && `${inv.repository_count} uploaded · ${inv.winget_count} winget · ${inv.external_count} URL`} />
        <Stat icon={<Activity />} label="Active deployments" value={inv?.active_deployments} sub={inv && `${inv.paused} paused · ${inv.global_count} global`} />
        <Stat
          icon={<TrendingUp />}
          label="Fleet success rate"
          value={f?.success_rate != null ? `${f.success_rate}%` : '—'}
          sub={f && `${f.succeeded.toLocaleString()} / ${f.device_software_pairs.toLocaleString()} installs · ${f.attempts_24h} in ${stats?.windows?.recent_hours ?? 24}h`}
          tone={f?.success_rate != null ? (f.success_rate >= 90 ? 'good' : f.success_rate >= 70 ? 'warn' : 'bad') : undefined}
        />
        <Stat
          icon={<AlertTriangle />}
          label="Failed, needs attention"
          value={f?.failed_needing_attention}
          sub="Click to view failing devices →"
          tone={f && f.failed_needing_attention > 0 ? 'bad' : undefined}
          onClick={() => navigate('/history?status=failed&latest_only=true')}
        />
      </div>

      {/* Filters */}
      <div className="card flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search by name or winget ID / file name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-2 md:flex">
          <select className="input md:w-44" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} aria-label="Source">
            <option value="">All sources</option>
            <option value="rms-repository">RMS Repository</option>
            <option value="winget">Winget</option>
            <option value="external_url">Script / URL</option>
          </select>
          <select className="input md:w-40" value={target} onChange={(e) => setTarget(e.target.value as TargetFilter)} aria-label="Target">
            <option value="">All targets</option>
            <option value="global">Global</option>
            <option value="donor">Donor</option>
            <option value="ngo">NGO</option>
            <option value="canary">Canary</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <select className="input md:w-36" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {items === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Package className="h-6 w-6" />}
            title={items.length ? 'No software matches these filters' : 'No software yet'}
            body={items.length ? 'Try clearing the search or filters.' : 'Upload your first installer or add a winget package to start deploying.'}
            action={
              items.length ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setSource('');
                    setTarget('');
                    setStatus('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setWizardOpen(true)} icon={<Plus className="h-4 w-4" />}>
                  Add software
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px]">
              <thead className="border-b border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/60">
                <tr>
                  <th className="th">Software</th>
                  <th className="th">Version & type</th>
                  <th className="th">Source</th>
                  <th className="th">Assigned to</th>
                  <th className="th w-52">Install success</th>
                  <th className="th">Active</th>
                  <th className="th w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((s) => (
                  <tr key={s.id} className={clsx('transition hover:bg-slate-50/60 dark:hover:bg-slate-900/60', !s.is_active && 'opacity-60')}>
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white', colorFor(s.software_name))}>
                          {s.software_name.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{s.software_name}</p>
                          <p className="max-w-[240px] truncate font-mono text-xs text-slate-500" title={s.source_type === 'winget' ? (s.winget_id ?? '') : (s.file_url ?? s.file_name ?? '')}>
                            {s.source_type === 'winget' ? s.winget_id : (s.file_name ?? s.winget_id)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      <p>{s.version ? `v${s.version.replace(/^v/i, '')}` : <span className="text-slate-400">—</span>}</p>
                      <p className="text-xs text-slate-500">
                        {s.source_type === 'winget' ? 'Winget' : `${s.installer_type ?? 'Unconfigured'} .${(s.file_name ?? '').split('.').pop()}`}
                        {s.file_size_bytes ? ` · ${formatBytes(s.file_size_bytes)}` : ''}
                        {s.execution_context === 'LOGGED_IN_USER' && ' · user'}
                      </p>
                    </td>
                    <td className="td">
                      {s.source_type === 'rms-repository' && (
                        <Badge color="blue" icon={<Cloud className="h-3 w-3" />} title={s.checksum_verified_at ? `Verified ${timeAgo(s.checksum_verified_at)}` : undefined}>
                          Cloud Storage {s.checksum_verified_at && <ShieldCheck className="h-3 w-3" />}
                        </Badge>
                      )}
                      {s.source_type === 'winget' && (
                        <Badge color="violet" icon={<Package className="h-3 w-3" />}>
                          Winget Store
                        </Badge>
                      )}
                      {s.source_type === 'external_url' && (
                        <Badge color="cyan" icon={<Link2 className="h-3 w-3" />}>
                          External URL
                        </Badge>
                      )}
                      {s.delivery === 'install_script' && (
                        <button type="button" className="mt-1 block text-[11px] text-slate-500 hover:text-brand-600" onClick={() => setScriptOf(s)} title="Delivered to RMS 1.4.0 laptops via a generated install script">
                          via install script
                        </button>
                      )}
                      {s.delivery === 'direct' && s.source_type !== 'winget' && (
                        <span className="mt-1 block text-[11px] text-amber-600" title="Deployed RMS 1.4.0 clients ignore most parameters for direct delivery">
                          direct (limited on 1.4.0)
                        </span>
                      )}
                    </td>
                    <td className="td">
                      <Targets s={s} />
                    </td>
                    <td className="td">
                      <SuccessBar s={s} />
                    </td>
                    <td className="td">
                      <Switch checked={s.is_active} disabled={busy[s.id]} onChange={(v) => toggleActive(s, v)} label={`Toggle ${s.software_name}`} />
                    </td>
                    <td className="td text-right">
                      <ActionsMenu
                        items={[
                          {
                            label: 'Edit parameters',
                            icon: <Pencil />,
                            onClick: () => {
                              setEditing(s);
                              setWizardOpen(true);
                            },
                          },
                          { label: 'Canary test', icon: <FlaskConical />, onClick: () => setCanary(s) },
                          { label: 'View device logs', icon: <FileSearch />, onClick: () => navigate(`/history?software_id=${s.id}`) },
                          { label: 'Retry all failed', icon: <RotateCw />, onClick: () => setRetrying(s), hidden: !s.stats.devices_failed },
                          { label: 'View install script', icon: <TerminalSquare />, onClick: () => setScriptOf(s), hidden: s.delivery !== 'install_script' },
                          { label: 'Verify checksum', icon: <ShieldCheck />, onClick: () => verify(s), hidden: s.source_type !== 'rms-repository' || !s.storage_key },
                          { label: 'Delete', icon: <Trash2 />, danger: true, onClick: () => setDeleting(s) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {items && items.length > 0 && (
        <p className="text-xs text-slate-500">
          Showing {filtered.length} of {items.length}. Success counts use each device's latest attempt.
        </p>
      )}

      <SoftwareWizard open={wizardOpen} onClose={() => setWizardOpen(false)} editing={editing} defaults={defaults} onSaved={upsert} />
      <CanaryModal software={canary} onClose={() => setCanary(null)} onSaved={upsert} />
      <ClientScriptModal software={scriptOf} onClose={() => setScriptOf(null)} onSaved={upsert} />
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={doDelete}
        danger
        title="Delete software?"
        confirmLabel="Delete"
        body={
          <>
            <strong>{deleting?.software_name}</strong> will stop deploying immediately and disappear from the inventory. Laptops that already installed it
            keep it. The installer file stays in storage and install history is preserved.
          </>
        }
      />
      <ConfirmModal
        open={!!retrying}
        onClose={() => setRetrying(null)}
        onConfirm={doRetryAll}
        title="Retry failed installs?"
        confirmLabel={`Retry on ${retrying?.stats.devices_failed ?? 0} device(s)`}
        body={
          <>
            Every device whose latest attempt at <strong>{retrying?.software_name}</strong> failed will try again on its next check-in. Consider fixing the
            parameters first if failures share the same cause.
          </>
        }
      />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'warn' | 'bad';
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={clsx('card p-4 text-left', onClick && 'transition hover:border-red-300 hover:shadow-md dark:hover:border-red-500/40')}
    >
      <div className="flex items-center gap-2 text-sm text-slate-500 [&>svg]:h-4 [&>svg]:w-4">
        {icon}
        {label}
      </div>
      <p
        className={clsx(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'bad' && 'text-red-600',
        )}
      >
        {value ?? <span className="text-slate-300">—</span>}
      </p>
      {sub && <p className="mt-1 truncate text-xs text-slate-500">{sub}</p>}
    </Tag>
  );
}

function Targets({ s }: { s: Software }) {
  const chips: ReactNode[] = [];
  if (s.is_global)
    chips.push(
      <Badge key="g" color="green" icon={<Globe2 className="h-3 w-3" />}>
        Global
      </Badge>,
    );
  const named = [...s.assigned_donors.map((d) => ({ ...d, kind: 'Donor' })), ...s.assigned_ngos.map((n) => ({ ...n, kind: 'NGO' }))];
  named.slice(0, 2).forEach((n) =>
    chips.push(
      <Badge key={`${n.kind}${n.id}`} color={n.kind === 'Donor' ? 'blue' : 'gray'} title={n.kind}>
        {n.kind === 'Donor' ? '♦ ' : ''}
        {n.name}
      </Badge>,
    ),
  );
  if (named.length > 2)
    chips.push(
      <Badge key="more" title={named.slice(2).map((n) => `${n.kind}: ${n.name}`).join('\n')}>
        +{named.length - 2} more
      </Badge>,
    );
  if (s.test_device_serials.length)
    chips.push(
      <Badge key="c" color="amber" icon={<FlaskConical className="h-3 w-3" />} title={s.test_device_serials.join(', ')}>
        {s.test_device_serials.length} canary
      </Badge>,
    );
  return chips.length ? <div className="flex max-w-[260px] flex-wrap gap-1">{chips}</div> : <span className="text-xs text-slate-400">Not assigned</span>;
}

function SuccessBar({ s }: { s: Software }) {
  const { devices_attempted: attempted, devices_succeeded: ok, devices_failed: bad, devices_targeted: targeted, last_attempt_at } = s.stats;
  // Denominator: devices this software targets (when the devices table is available), else devices that reported.
  const total = Math.max(targeted ?? 0, attempted);
  if (!total) return <span className="text-xs text-slate-400">{targeted === 0 ? 'No devices targeted' : 'No installs reported yet'}</span>;
  const pending = Math.max(0, total - ok - bad);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="bg-emerald-500" style={{ width: `${(ok / total) * 100}%` }} />
        <div className="bg-red-500" style={{ width: `${(bad / total) * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs">
        <span>
          <span className="font-medium">{ok.toLocaleString()}</span>
          <span className="text-slate-500"> / {total.toLocaleString()} installed</span>
        </span>
        {bad > 0 ? (
          <span className="text-red-600">{bad.toLocaleString()} failed</span>
        ) : pending > 0 ? (
          <span className="text-slate-400">{pending.toLocaleString()} pending</span>
        ) : (
          <span className="text-slate-400">{timeAgo(last_attempt_at)}</span>
        )}
      </div>
    </div>
  );
}
