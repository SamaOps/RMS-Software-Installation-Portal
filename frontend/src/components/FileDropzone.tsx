import { useRef, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, FileUp, RefreshCw, ShieldCheck, UploadCloud, X } from 'lucide-react';
import { Button, ProgressBar } from './ui';
import { formatBytes, sanitizeFileName } from '../lib/format';
import { fileNameRegex, useDefaults } from '../lib/defaults';
import type { UploadProgress } from '../lib/upload';

export interface UploadState {
  file?: File;
  fileName: string;
  progress?: UploadProgress;
  error?: string;
  uploading: boolean;
}

/** Drag-and-drop zone + live upload/hash progress. Upload logic lives in the parent. */
export function FileDropzone({
  state,
  done,
  accept,
  maxBytes,
  onPick,
  onRetry,
  onCancel,
  onFileNameChange,
  onClear,
}: {
  state: UploadState;
  done?: { file_name: string; file_size_bytes: number; sha256_checksum: string } | null;
  accept: string[];
  maxBytes: number;
  onPick: (f: File) => void;
  onRetry: () => void;
  onCancel: () => void;
  onFileNameChange: (n: string) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const FILE_NAME_RE = fileNameRegex(useDefaults());

  const pick = (f?: File) => {
    if (!f) return;
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!accept.includes(ext)) return setLocalError(`.${ext} files are not supported. Use ${accept.map((a) => '.' + a).join(', ')}`);
    if (f.size > maxBytes) return setLocalError(`File is ${formatBytes(f.size)}; the limit is ${formatBytes(maxBytes)}`);
    if (f.size === 0) return setLocalError('File is empty');
    setLocalError(undefined);
    onPick(f);
  };

  // ---- Finished upload ----
  if (done && !state.uploading) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{done.file_name}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">{formatBytes(done.file_size_bytes)} · stored in cloud storage</p>
            <p className="mt-2 flex items-center gap-1.5 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> SHA-256 {done.sha256_checksum}
            </p>
          </div>
          <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onClear}>
            Replace
          </Button>
        </div>
      </div>
    );
  }

  // ---- In progress / failed ----
  if (state.file) {
    const p = state.progress;
    const up = p ? (p.uploadedBytes / p.totalBytes) * 100 : 0;
    const hash = p ? (p.hashedBytes / p.totalBytes) * 100 : 0;
    const label =
      p?.phase === 'preparing' ? 'Preparing upload…' : p?.phase === 'finalizing' ? 'Finalizing in cloud storage…' : `Uploading ${up.toFixed(0)}%`;
    return (
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <div className="flex items-center gap-3">
          <FileUp className="h-5 w-5 shrink-0 text-brand-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{state.file.name}</p>
            <p className="text-xs text-slate-500">{formatBytes(state.file.size)}</p>
          </div>
          {state.uploading ? (
            <Button variant="ghost" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Choose another
            </Button>
          )}
        </div>
        {state.uploading && (
          <div className="mt-4 space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-xs text-slate-500">
                <span>{label}</span>
                <span>
                  {formatBytes(p?.uploadedBytes ?? 0)} / {formatBytes(state.file.size)}
                </span>
              </div>
              <ProgressBar value={up} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-slate-500">
                <span>Computing SHA-256 checksum</span>
                <span>{hash.toFixed(0)}%</span>
              </div>
              <ProgressBar value={hash} color="bg-emerald-500" />
            </div>
          </div>
        )}
        {state.error && !state.uploading && (
          <div className="mt-4 space-y-3">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{state.error}</p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="label">Stored file name</label>
                <input
                  className={clsx('input font-mono', !FILE_NAME_RE.test(state.fileName) && 'input-error')}
                  value={state.fileName}
                  onChange={(e) => onFileNameChange(e.target.value)}
                  onBlur={(e) => onFileNameChange(sanitizeFileName(e.target.value))}
                />
              </div>
              <Button onClick={onRetry} disabled={!FILE_NAME_RE.test(state.fileName)} icon={<RefreshCw className="h-4 w-4" />}>
                Retry upload
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Empty drop zone ----
  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={clsx(
          'flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
          drag
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
            : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900',
        )}
      >
        <UploadCloud className="mb-3 h-9 w-9 text-slate-400" />
        <p className="text-sm font-medium">
          Drop installer here or <span className="text-brand-600">browse</span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {accept.map((a) => '.' + a).join(' ')} · up to {formatBytes(maxBytes)} · uploads straight to cloud storage
        </p>
      </button>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={accept.map((a) => '.' + a).join(',')}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
    </div>
  );
}
