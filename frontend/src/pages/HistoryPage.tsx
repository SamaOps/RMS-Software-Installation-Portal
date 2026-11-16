import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Clock, Download, FileText, History, RefreshCw, RotateCw, Search } from 'lucide-react';
import { LogModal } from '../components/LogModal';
import { Badge, Button, ConfirmModal, EmptyState, Spinner } from '../components/ui';
import { api, apiError } from '../lib/api';
import { formatDate, timeAgo } from '../lib/format';
import { useDefaults } from '../lib/defaults';
import type { HistoryRow, Software } from '../lib/types';

export function HistoryPage() {
  // Page size comes from the server (HISTORY_PAGE_SIZE); the response echoes the size actually used.
  const defaults = useDefaults();
  const [pageSize, setPageSize] = useState<number | null>(null);
  const PAGE_SIZE = pageSize ?? defaults?.limits.history_page_size ?? 50;
  const [exporting, setExporting] = useState(false);
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [softwares, setSoftwares] = useState<Software[]>([]);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');

  const filters = {
    search: params.get('search') ?? '',
    status: params.get('status') ?? '',
    software_id: params.get('software_id') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    latest_only: params.get('latest_only') ?? '',
    page: Number(params.get('page') ?? 1),
  };

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.history({
        search: filters.search || undefined,
        status: filters.status || undefined,
        software_id: filters.software_id || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        latest_only: filters.latest_only || undefined,
        page: filters.page,
      });
      setRows(r.data);
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
    api.listSoftwares({}).then(setSoftwares).catch(() => {});
  }, []);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => searchInput !== filters.search && update({ search: searchInput.trim() }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const retryOne = async (r: HistoryRow) => {
    if (!r.software_id || !r.serial_number) return;
    try {
      await api.retry(r.software_id, { serial_numbers: [r.serial_number] });
      toast.success('Retry queued', { description: `${r.serial_number} will re-attempt on its next check-in.` });
      load();
    } catch (e) {
      toast.error(apiError(e).message);
    }
  };

  const currentSoftware = softwares.find((s) => String(s.id) === filters.software_id);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Device installation history</h1>
          <p className="text-sm text-slate-500">Every install attempt reported by RMS clients. Click a row to see the debug log.</p>
        </div>
        <div className="flex gap-2">
          {currentSoftware && currentSoftware.stats.devices_failed > 0 && (
            <Button variant="secondary" icon={<RotateCw className="h-4 w-4" />} onClick={() => setRetryingAll(true)}>
              Retry {currentSoftware.stats.devices_failed} failed
            </Button>
          )}
          <Button
            variant="secondary"
            loading={exporting}
            icon={<Download className="h-4 w-4" />}
            onClick={async () => {
              setExporting(true);
              try {
                const { truncated } = await api.exportHistory({
                  search: filters.search || undefined,
                  status: filters.status || undefined,
                  software_id: filters.software_id || undefined,
                  from: filters.from || undefined,
                  to: filters.to || undefined,
                  latest_only: filters.latest_only || undefined,
                });
                toast.success('Report downloaded', truncated ? { description: `Limited to the newest ${truncated.toLocaleString()} rows.` } : undefined);
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

      <div className="card grid gap-2 p-3 md:grid-cols-12">
        <div className="relative md:col-span-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Serial number, software or error text…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <select className="input md:col-span-3" value={filters.software_id} onChange={(e) => update({ software_id: e.target.value })} aria-label="Software">
          <option value="">All software</option>
          {softwares.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.software_name}
            </option>
          ))}
        </select>
        <select className="input md:col-span-2" value={filters.status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <input type="date" className="input md:col-span-1 md:px-2" value={filters.from} onChange={(e) => update({ from: e.target.value })} aria-label="From" title="From" />
        <input type="date" className="input md:col-span-1 md:px-2" value={filters.to} onChange={(e) => update({ to: e.target.value })} aria-label="To" title="To" />
        <label className="flex items-center gap-2 whitespace-nowrap text-sm md:col-span-1" title="Only each device's most recent attempt">
          <input type="checkbox" className="h-4 w-4 rounded" checked={filters.latest_only === 'true'} onChange={(e) => update({ latest_only: e.target.checked ? 'true' : '' })} />
          Latest
        </label>
      </div>

      <div className="card overflow-hidden">
        {rows === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<History className="h-6 w-6" />} title="No install attempts found" body="Adjust the filters, or wait for devices to check in." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="border-b border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/60">
                <tr>
                  <th className="th">Serial number</th>
                  <th className="th">Laptop model / NGO</th>
                  <th className="th">Software</th>
                  <th className="th">Status</th>
                  <th className="th">Timestamp</th>
                  <th className="th">Error / details</th>
                  <th className="th w-28" />
                </tr>
              </thead>
              <tbody className={clsx('divide-y divide-slate-100 dark:divide-slate-800', loading && 'opacity-60')}>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelected(r)}
                    className={clsx('cursor-pointer transition', r.is_successful ? 'hover:bg-slate-50 dark:hover:bg-slate-900/60' : 'hover:bg-red-50/60 dark:hover:bg-red-500/5')}
                  >
                    <td className="td font-mono text-xs">{r.serial_number ?? `#${r.device_id}`}</td>
                    <td className="td">
                      <p className="text-sm">{r.model ?? <span className="text-slate-400">Unknown model</span>}</p>
                      <p className="text-xs text-slate-500">{r.ngo_name ?? '—'}</p>
                    </td>
                    <td className="td">
                      <p className="font-medium">{r.software_name}</p>
                      {!r.software_id && <p className="text-xs text-slate-400">removed from portal</p>}
                    </td>
                    <td className="td">
                      <div className="flex flex-col items-start gap-1">
                        {r.is_successful ? <Badge color="green">Success</Badge> : <Badge color="red">Failed</Badge>}
                        {r.retry_requested_at && (
                          <Badge color="amber" icon={<Clock className="h-3 w-3" />} title={`Requested ${formatDate(r.retry_requested_at)}`}>
                            Retry queued
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="td whitespace-nowrap" title={formatDate(r.created_at)}>
                      <p className="text-sm">{formatDate(r.created_at)}</p>
                      <p className="text-xs text-slate-500">{timeAgo(r.created_at)}</p>
                    </td>
                    <td className="td max-w-[280px]">
                      {r.error_message ? (
                        <p className="truncate text-xs text-red-600 dark:text-red-400" title={r.error_message}>
                          {r.error_message}
                        </p>
                      ) : !r.is_successful ? (
                        <p className="text-xs text-slate-400">No error reported</p>
                      ) : null}
                      <p className="flex items-center gap-2 text-xs text-slate-500">
                        {r.exit_code != null && <span>exit {r.exit_code}</span>}
                        {r.has_log && (
                          <span className="inline-flex items-center gap-1 text-brand-600">
                            <FileText className="h-3 w-3" /> log
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      {!r.is_successful && r.is_latest && r.software_id && r.serial_number && !r.retry_requested_at && (
                        <Button size="sm" variant="secondary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => retryOne(r)}>
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && rows.length > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
            <span className="text-slate-500">
              {((filters.page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(filters.page * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" disabled={filters.page <= 1} onClick={() => update({ page: String(filters.page - 1) })} icon={<ChevronLeft className="h-4 w-4" />} aria-label="Previous page" />
              <Button size="sm" variant="secondary" disabled={filters.page >= pages} onClick={() => update({ page: String(filters.page + 1) })} icon={<ChevronRight className="h-4 w-4" />} aria-label="Next page" />
            </div>
          </div>
        )}
      </div>

      <LogModal row={selected} onClose={() => setSelected(null)} onRetried={load} />
      <ConfirmModal
        open={retryingAll}
        onClose={() => setRetryingAll(false)}
        title="Retry all failed installs?"
        confirmLabel="Queue retries"
        body={
          <>
            All devices whose latest attempt at <strong>{currentSoftware?.software_name}</strong> failed will re-attempt on their next check-in.
          </>
        }
        onConfirm={async () => {
          if (!currentSoftware) return;
          try {
            const r = await api.retry(currentSoftware.id, { all_failed: true });
            toast.success(`Retry queued for ${r.queued} device(s)`);
            setRetryingAll(false);
            load();
          } catch (e) {
            toast.error(apiError(e).message);
          }
        }}
      />
    </div>
  );
}
