/**
 * Storage adapter for S3-compatible object storage.
 * Works unchanged with AWS S3, Cloudflare R2 (set S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com,
 * S3_REGION=auto) and MinIO (S3_FORCE_PATH_STYLE=true).
 *
 * Browser uploads go DIRECTLY to the bucket via pre-signed URLs, so large
 * installers never pass through this server's memory or EC2 disk.
 */
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

const cfg = config.storage;

const client = new S3Client({
  region: cfg.region,
  endpoint: cfg.endpoint,
  forcePathStyle: cfg.forcePathStyle,
  credentials:
    cfg.accessKeyId && cfg.secretAccessKey
      ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
      : undefined, // fall back to the default chain (EC2 instance role, env, ~/.aws)
  // R2 rejects the newer default CRC32 checksum headers on presigned URLs.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const CONTENT_TYPE = 'application/octet-stream';

export const keyFor = (fileName) => `${cfg.keyPrefix}${fileName}`;

/** Ensure a key supplied by the browser stays inside our prefix. */
export function assertOwnKey(key) {
  if (typeof key !== 'string' || !key.startsWith(cfg.keyPrefix) || key.includes('..') || key.includes('//')) {
    throw new HttpError(400, 'Invalid storage key');
  }
  return key;
}

export async function headObject(key) {
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return { size: r.ContentLength, etag: r.ETag, lastModified: r.LastModified };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    throw err;
  }
}

export function presignPut(key) {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: CONTENT_TYPE }), {
    expiresIn: cfg.presignTtlSeconds,
  });
}

export async function createMultipart(key) {
  const r = await client.send(
    new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, ContentType: CONTENT_TYPE }),
  );
  return r.UploadId;
}

export function presignParts(key, uploadId, partNumbers) {
  return Promise.all(
    partNumbers.map(async (n) => ({
      part_number: n,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: n }),
        { expiresIn: cfg.presignTtlSeconds },
      ),
    })),
  );
}

export async function completeMultipart(key, uploadId, parts) {
  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: cfg.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted },
    }),
  );
}

export async function abortMultipart(key, uploadId) {
  await client.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
}

/** Stream an object (used by the optional download proxy and by checksum verification). */
export async function getObjectStream(key, range) {
  const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: range }));
  return {
    body: r.Body,
    contentLength: r.ContentLength,
    contentRange: r.ContentRange,
    etag: r.ETag,
    lastModified: r.LastModified,
  };
}

/** Server-side SHA-256 of a stored object — independent check of what the browser computed. */
export async function sha256OfObject(key) {
  const { body } = await getObjectStream(key);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** URL clients will download from (mirrors the legacy ${BACKEND}/softwares/<file> layout). */
export const publicUrlFor = (fileName) =>
  config.publicDownloadBaseUrl ? `${config.publicDownloadBaseUrl}/${encodeURIComponent(fileName)}` : null;

/** Small server-side write (used for generated client install scripts; installers never go through here). */
export async function putObject(key, body, { contentType = CONTENT_TYPE, cacheControl } = {}) {
  await client.send(
    new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }),
  );
}
