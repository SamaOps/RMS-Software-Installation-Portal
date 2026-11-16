import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

const BADGE: Record<string, string> = {
  gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  cyan: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300',
};

export function Badge({ color = 'gray', children, icon, title }: { color?: keyof typeof BADGE; children: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium', BADGE[color])}>
      {icon}
      {children}
    </span>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition disabled:cursor-wait disabled:opacity-60',
        checked ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700',
      )}
    >
      <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export function Field({ label, error, help, children, required }: { label: string; error?: string; help?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <div>
      <label className="label">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : help ? <p className="help">{help}</p> : null}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!ref.current?.contains(document.activeElement)) {
      ref.current?.focus();
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={clsx('card relative flex max-h-[95vh] w-full flex-col outline-none sm:max-h-[90vh]', width)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600 dark:text-slate-300">{body}</div>
    </Modal>
  );
}

export function ProgressBar({ value, color = 'bg-brand-500', className }: { value: number; color?: string; className?: string }) {
  return (
    <div className={clsx('h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800', className)}>
      <div className={clsx('h-full rounded-full transition-all duration-300', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-slate-400', className)} />;
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-500 dark:bg-slate-800">{icon}</div>
      <h3 className="font-medium">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode; description?: string }[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            'flex items-start gap-3 rounded-xl border p-3 text-left transition',
            value === o.value
              ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20 dark:bg-brand-500/10'
              : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600',
          )}
        >
          {o.icon && <span className={clsx('mt-0.5', value === o.value ? 'text-brand-600' : 'text-slate-400')}>{o.icon}</span>}
          <span>
            <span className="block text-sm font-medium">{o.label}</span>
            {o.description && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{o.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
