import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

/** Row actions menu. Uses fixed positioning so it isn't clipped by scrollable tables. */
export function ActionsMenu({ items }: { items: MenuItem[] }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e.type === 'mousedown' && (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setPos(null);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    setPos(window.innerHeight - r.bottom < 260 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };

  return (
    <>
      <button
        ref={btn}
        onClick={toggle}
        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={!!pos}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {pos && (
        <div ref={menu} role="menu" className="card fixed z-50 w-52 py-1" style={pos}>
          {items
            .filter((i) => !i.hidden)
            .map((i) => (
              <button
                key={i.label}
                role="menuitem"
                disabled={i.disabled}
                onClick={() => {
                  setPos(null);
                  i.onClick();
                }}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm disabled:opacity-40',
                  i.danger ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                <span className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4">{i.icon}</span>
                {i.label}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
