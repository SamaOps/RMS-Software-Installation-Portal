/**
 * Browser -> S3/R2 direct upload with progress, plus streaming SHA-256.
 *
 *  - Hashing and uploading run in parallel (both just read the File), so a 2 GB
 *    installer is hashed while it uploads instead of doubling the wait.
 *  - Below MULTIPART_THRESHOLD_BYTES (server decides): single pre-signed PUT. Above: multipart,
 *    UPLOAD_CONCURRENCY parts in flight, each retried UPLOAD_PART_RETRIES times (all from the server).
 *    Presigned part URLs are fetched lazily.
 *  - The bucket must expose the ETag header via CORS (see integration guide).
 */
import { createSHA256 } from 'hash-wasm';
import { http } from './api';
import type { Limits } from './types';

export interface UploadResult {
  storage_key: string;
  file_name: string;
  file_size_bytes: number;
  sha256_checksum: string;
}

export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'finalizing' | 'done';
  uploadedBytes: number;
  hashedBytes: number;
  totalBytes: number;
}

// Fallbacks only; the server sends the real values in installer-defaults.limits (env-driven).
const FALLBACK = { hash_chunk_bytes: 8 * 1024 * 1024, upload_concurrency: 4, upload_part_retries: 3, multipart_sign_batch: 50 };
type UploadTuning = Pick<Limits, keyof typeof FALLBACK>;

export async function sha256File(
  file: Blob,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
  HASH_CHUNK = FALLBACK.hash_chunk_bytes,
) {
  const hasher = await createSHA256();
  hasher.init();
  for (let off = 0; off < file.size; off += HASH_CHUNK) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const buf = new Uint8Array(await file.slice(off, off + HASH_CHUNK).arrayBuffer());
    hasher.update(buf);
    onProgress?.(Math.min(off + HASH_CHUNK, file.size));
  }
  return hasher.digest('hex');
}

function xhrPut(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal, contentType?: string) {
  return new Promise<string | null>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader('ETag'))
        : reject(new Error(`Storage rejected the upload (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error while uploading. Check bucket CORS settings.'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadFile(
  file: File,
  fileName: string,
  opts: { softwareId?: number | string; onProgress: (p: UploadProgress) => void; signal: AbortSignal; tuning?: Partial<UploadTuning> | null },
): Promise<UploadResult> {
  const { onProgress, signal } = opts;
  const tune = { ...FALLBACK, ...(opts.tuning ?? {}) };
  const CONCURRENCY = tune.upload_concurrency;
  const PART_RETRIES = tune.upload_part_retries;
  const SIGN_BATCH = tune.multipart_sign_batch;
  const state: UploadProgress = { phase: 'preparing', uploadedBytes: 0, hashedBytes: 0, totalBytes: file.size };
  const emit = () => onProgress({ ...state });
  emit();

  const init = (
    await http.post('/api/admin/softwares/upload-url', {
      file_name: fileName,
      file_size_bytes: file.size,
      software_id: opts.softwareId,
    })
  ).data.data as
    | { mode: 'single'; storage_key: string; url: string }
    | { mode: 'multipart'; storage_key: string; upload_id: string; part_size: number; part_count: number };

  state.phase = 'uploading';
  emit();

  const hashing = sha256File(
    file,
    (b) => {
      state.hashedBytes = b;
      emit();
    },
    signal,
    tune.hash_chunk_bytes,
  );

  const uploading = (async () => {
    if (init.mode === 'single') {
      await xhrPut(
        init.url,
        file,
        (l) => {
          state.uploadedBytes = l;
          emit();
        },
        signal,
        'application/octet-stream',
      );
      return;
    }

    // ---- multipart ----
    const { storage_key, upload_id, part_size, part_count } = init;
    const urls = new Map<number, string>();
    const loaded = new Map<number, number>();
    const parts: { PartNumber: number; ETag: string }[] = [];
    let next = 1;

    const ensureUrl = async (n: number) => {
      if (urls.has(n)) return urls.get(n)!;
      const nums = Array.from({ length: Math.min(SIGN_BATCH, part_count - n + 1) }, (_, i) => n + i);
      const r = await http.post('/api/admin/softwares/multipart/sign-parts', { storage_key, upload_id, part_numbers: nums });
      for (const p of r.data.data.parts as { part_number: number; url: string }[]) urls.set(p.part_number, p.url);
      return urls.get(n)!;
    };

    const worker = async () => {
      while (next <= part_count) {
        const n = next++;
        const blob = file.slice((n - 1) * part_size, Math.min(n * part_size, file.size));
        for (let attempt = 1; ; attempt++) {
          try {
            const etag = await xhrPut(
              await ensureUrl(n),
              blob,
              (l) => {
                loaded.set(n, l);
                state.uploadedBytes = [...loaded.values()].reduce((a, b) => a + b, 0);
                emit();
              },
              signal,
            );
            if (!etag) throw new Error('ETag header not readable. Add "ETag" to the bucket CORS ExposeHeaders.');
            parts.push({ PartNumber: n, ETag: etag });
            break;
          } catch (e) {
            if (signal.aborted || attempt >= PART_RETRIES) throw e;
            loaded.set(n, 0);
            urls.delete(n); // URL may have expired
            await sleep(1000 * 2 ** attempt);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, part_count) }, worker));
      state.phase = 'finalizing';
      emit();
      await http.post('/api/admin/softwares/multipart/complete', { storage_key, upload_id, parts });
    } catch (e) {
      http.post('/api/admin/softwares/multipart/abort', { storage_key, upload_id }).catch(() => {});
      throw e;
    }
  })();

  const [sha256] = await Promise.all([hashing, uploading]);
  state.phase = 'done';
  state.uploadedBytes = file.size;
  emit();
  return { storage_key: init.storage_key, file_name: fileName, file_size_bytes: file.size, sha256_checksum: sha256 };
}
