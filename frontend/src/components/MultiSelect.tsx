import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { NamedRef } from '../lib/types';

type Id = NamedRef['id'];

/** Searchable multi-select dropdown with removable chips. */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  disabled,
  loading,
}: {
  options: NamedRef[];
  value: Id[];
  onChange: (v: Id[]) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(value.map(String)), [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: Id) =>
    onChange(selected.has(String(id)) ? value.filter((v) => String(v) !== String(id)) : [...value, id]);
  const chips = options.filter((o) => selected.has(String(o.id)));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={clsx('input flex min-h-[40px] flex-wrap items-center gap-1.5 text-left', disabled && 'opacity-60')}
      >
        {chips.length === 0 && <span className="text-slate-400">{loading ? 'Loading…' : placeholder}</span>}
        {chips.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-100">
            {c.name}
            <X
              className="h-3 w-3 cursor-pointer opacity-70 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                toggle(c.id);
              }}
            />
          </span>
        ))}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="card absolute z-30 mt-1 w-full overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <Search className="h-4 w-4 text-slate-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full bg-transparent text-sm outline-none" />
            {value.length > 0 && (
              <button type="button" className="text-xs text-slate-500 hover:text-slate-700" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No matches</li>}
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => toggle(o.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <span className={clsx('flex h-4 w-4 items-center justify-center rounded border', selected.has(String(o.id)) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>
                    {selected.has(String(o.id)) && <Check className="h-3 w-3" />}
                  </span>
                  {o.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
