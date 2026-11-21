/**
 * Local-disk storage driver (default when S3_BUCKET is not set).
 *
 * Files live under STORAGE_DIR on the portal host and are served by the portal at
 * /softwares/<file>, so the only infrastructure is the portal itself. Same interface
 * as storage/s3.js. Browser uploads PUT straight to a short-lived signed URL on this
 * portal and are streamed to disk (never buffered in memory).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

const cfg = config.storage;
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(backendDir, cfg.localDir);
fs.mkdirSync(ROOT, { recursive: true });

export const supportsMultipart = false;
export const keyFor = (fileName) => `${cfg.keyPrefix}${fileName}`;

/** Ensure a key supplied by the browser stays inside our prefix. */
export function assertOwnKey(key) {
  if (typeof key !== 'string' || !key.startsWith(cfg.keyPrefix) || key.includes('..') || key.includes('//') || key.includes('\\')) {
    throw new HttpError(400, 'Invalid storage key');
  }
  return key;
}

function pathFor(key) {
  const p = path.resolve(ROOT, assertOwnKey(key));
  if (!p.startsWith(ROOT + path.sep)) throw new HttpError(400, 'Invalid storage key');
  return p;
}

export async function headObject(key) {
  try {
    const st = await fsp.stat(pathFor(key));
    return { size: st.size, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, lastModified: st.mtime };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// ---- signed upload URLs (HMAC with JWT_SECRET, short-lived) -------------------
const sign = (key, exp) => crypto.createHmac('sha256', config.auth.jwtSecret).update(`${key}\n${exp}`).digest('hex');

export function presignPut(key) {
  const exp = Math.floor(Date.now() / 1000) + cfg.presignTtlSeconds;
  return `/api/storage/upload?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp)}`;
}

export function verifyUploadSignature(key, exp, sig) {
  if (!key || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(key, exp), 'hex');
  const got = Buffer.from(String(sig), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Stream a request body to disk (temp file + rename, so readers never see a partial file). */
export async function receiveUpload(key, req, maxBytes) {
  const dest = pathFor(key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > maxBytes) req.destroy(new HttpError(413, 'File is larger than the upload limit'));
  });
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  const st = await fsp.stat(dest);
  return { size: st.size, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` };
}

export async function putObject(key, body) {
  const dest = pathFor(key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, dest);
}

/** Read stream with optional "bytes=a-b" range (used by /softwares/:file and checksum verification). */
export async function getObjectStream(key, range) {
  const p = pathFor(key);
  let st;
  try {
    st = await fsp.stat(p);
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    throw e;
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!m) return { body: fs.createReadStream(p), contentLength: st.size, contentRange: null, etag, lastModified: st.mtime };
  let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? st.size - 1 : Number(m[2]);
  start = Math.max(0, start);
  end = Math.min(end, st.size - 1);
  if (start > end) throw Object.assign(new Error('Range Not Satisfiable'), { $metadata: { httpStatusCode: 416 } });
  return {
    body: fs.createReadStream(p, { start, end }),
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${st.size}`,
    etag,
    lastModified: st.mtime,
  };
}

export async function sha256OfObject(key) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(pathFor(key))) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

const notSupported = () => {
  throw new HttpError(400, 'Multipart uploads are only used with S3/R2 storage');
};
export const createMultipart = notSupported;
export const presignParts = notSupported;
export const completeMultipart = notSupported;
export const abortMultipart = async () => {};
