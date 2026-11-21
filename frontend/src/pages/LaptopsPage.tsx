import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Download, Laptop, RefreshCw, Search } from 'lucide-react';
import { Button, EmptyState, Spinner } from '../components/ui';
import { LaptopModal } from '../components/LaptopModal';
import { api, apiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { LaptopRow, LaptopSummary, NamedRef, Software } from '../lib/types';

const STATUS = [
  { v: 'all', label: 'All laptops' },
  { v: 'not_installed', label: 'Missing or failed' },
  { v: 'failed', label: 'Has failures' },
  { v: 'waiting', label: 'Waiting to install' },
  { v: 'complete', label: 'Up to date' },
] as const;

/** Every RMS laptop with what it has installed, what failed and what is still waiting. */
export function LaptopsPage() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<LaptopRow[] | null>(null);
  const [summary, setSummary] = useState<LaptopSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [ngos, setNgos] = useState<NamedRef[]>([]);
  const [donors, setDonors] = useState<NamedRef[]>([]);
  const [softwares, setSoftwares] = useState<Software[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');

  const f = {
    search: params.get('search') ?? '',
    status: params.get('status') ?? 'all',
    ngo_id: params.get('ngo_id') ?? '',
    donor_id: params.get('donor_id') ?? '',
    software_id: params.get('software_id') ?? '',
    sort: params.get('sort') ?? 'attention',
    page: Number(params.get('page') ?? 1),
  };
  const query = () => ({
    search: f.search || undefined,
    status: f.status,
    ngo_id: f.ngo_id || undefined,
    donor_id: f.donor_id || undefined,
    software_id: f.software_id || undefined,
    sort: f.sort,
  });

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v && !(k === 'status' && v === 'all') ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.laptops({ ...query(), page: f.page });
      setRows(r.data);
      setSummary(r.summary);
      setTotal(r.total);
      setPageSize(r.page_size);
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    Promise.all([api.ngos(), api.donors(), api.listSoftwares({})])
      .then(([n, d, s]) => {
        setNgos(n);
        setDonors(d);
        setSoftwares(s);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => searchInput !== f.search && update({ search: searchInput }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const sw = softwares.find((s) => String(s.id) === f.software_id);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const n = (x: number | string | undefined) => Number(x ?? 0).toLocaleString();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Laptops</h1>
          <p className="text-sm text-slate-500">
            {sw ? (
              <>
                Status of <strong>{sw.software_name}</strong> on every laptop it targets.
              </>
            ) : (
              'Every laptop registered in RMS and the software it should have. Click a laptop for details.'
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            loading={exporting}
            icon={<Download className="h-4 w-4" />}
            onClick={async () => {
              setExporting(true);
              try {
                await api.exportLaptops(query());
              } catch (e) {
                toast.error(apiError(e).message);
              } finally {
                setExporting(false);
              }
            }}
          >
            Export CSV
          </Button>
          <Button variant="secondary" onClick={load} loading={loading} icon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary: each card filters the list */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Laptops', value: summary?.laptops, status: 'all', sub: summary && `${n(summary.installs)} installs done` },
          { label: 'Up to date', value: summary?.complete, status: 'complete', tone: 'good' },
          { label: 'Waiting to install', value: summary?.with_waiting, status: 'waiting', sub: summary && `${n(summary.waiting_installs)} installs pending` },
          { label: 'With failures', value: summary?.with_failures, status: 'failed', tone: 'bad', sub: summary && `${n(summary.failed_installs)} failed installs` },
        ].map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => update({ status: c.status })}
            className={clsx('card p-4 text-left transition hover:ring-2 hover:ring-brand-500/30', f.status === c.status && 'ring-2 ring-brand-500')}
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className={clsx('mt-1 text-2xl font-semibold', c.tone === 'good' && 'text-emerald-600', c.tone === 'bad' && Number(c.value) > 0 && 'text-red-600')}>
              {c.value != null ? n(c.value) : '—'}
            </p>
            {c.sub && <p className="text-xs text-slate-500">{c.sub}</p>}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card grid gap-2 p-3 md:grid-cols-12">
        <div className="relative md:col-span-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Serial, user or location…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <select className="input md:col-span-2" value={f.status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
          {STATUS.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="input md:col-span-2" value={f.software_id} onChange={(e) => update({ software_id: e.target.value })} aria-label="Software">
          <option value="">All software</option>
          {softwares.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.software_name}
            </option>
          ))}
        </select>
        <select className="input md:col-span-2" value={f.ngo_id} onChange={(e) => update({ ngo_id: e.target.value })} aria-label="NGO">
          <option value="">All NGOs</option>
          {ngos.map((x) => (
            <option key={x.id} value={String(x.id)}>
              {x.name}
            </option>
          ))}
        </select>
        <select className="input md:col-span-2" value={f.donor_id} onChange={(e) => update({ donor_id: e.target.value })} aria-label="Donor">
          <option value="">All donors</option>
          {donors.map((x) => (
            <option key={x.id} value={String(x.id)}>
              {x.name}
            </option>
          ))}
        </select>
        <select className="input md:col-span-1 md:px-2" value={f.sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort">
          <option value="attention">Needs attention</option>
          <option value="serial">Serial</option>
          <option value="last_seen">Last seen</option>
          <option value="location">Location</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {rows === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Laptop />} title="No laptops match" body="Try another filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900">
                <tr>
                  <th className="px-4 py-3">Laptop</th>
                  <th className="px-4 py-3">NGO / donor</th>
                  <th className="px-4 py-3">{sw ? sw.software_name : 'Software'}</th>
                  <th className="px-4 py-3">RMS</th>
                  <th className="px-4 py-3">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr
                    key={String(d.device_id)}
                    onClick={() => setOpen(d.serial_number)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60"
                  >
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-medium">{d.serial_number}</p>
                      <p className="text-xs text-slate-500">{[d.username, d.location].filter(Boolean).join(' · ') || '—'}</p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p>{d.ngo_name ?? '—'}</p>
                      <p className="text-slate-500">{d.donor_name ?? ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      <InstallBar d={d} single={!!sw} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {d.rms_version ? `v${d.rms_version}` : '—'}
                      {!d.is_active && <span className="ml-1 text-slate-400">(inactive)</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{d.last_seen_at ? timeAgo(d.last_seen_at) : 'never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && total > pageSize && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm dark:border-slate-800">
            <span className="text-slate-500">
              {((f.page - 1) * pageSize + 1).toLocaleString()}–{Math.min(f.page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={f.page <= 1} onClick={() => update({ page: String(f.page - 1) })} icon={<ChevronLeft className="h-4 w-4" />} />
              <Button variant="secondary" disabled={f.page >= pages} onClick={() => update({ page: String(f.page + 1) })} icon={<ChevronRight className="h-4 w-4" />} />
            </div>
          </div>
        )}
      </div>

      <LaptopModal serial={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function InstallBar({ d, single }: { d: LaptopRow; single: boolean }) {
  if (!d.targeted) return <span className="text-xs text-slate-400">{single ? 'Not targeted' : 'Nothing targeted'}</span>;
  if (single)
    return d.installed ? (
      <span className="text-xs font-medium text-emerald-600">Installed</span>
    ) : d.failed ? (
      <span className="text-xs font-medium text-red-600">Failed</span>
    ) : (
      <span className="text-xs text-slate-500">Waiting</span>
    );
  return (
    <div className="min-w-[160px]">
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="bg-emerald-500" style={{ width: `${(d.installed / d.targeted) * 100}%` }} />
        <div className="bg-red-500" style={{ width: `${(d.failed / d.targeted) * 100}%` }} />
      </div>
      <p className="mt-1 text-xs">
        <span className="font-medium">{d.installed}</span>
        <span className="text-slate-500"> / {d.targeted} installed</span>
        {d.failed > 0 && <span className="text-red-600"> · {d.failed} failed</span>}
        {d.waiting > 0 && <span className="text-slate-500"> · {d.waiting} waiting</span>}
      </p>
    </div>
  );
}
