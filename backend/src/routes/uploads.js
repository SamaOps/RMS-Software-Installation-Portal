/**
 * Direct-to-bucket uploads.
 *
 *  Small files (< MULTIPART_THRESHOLD): one pre-signed PUT.
 *  Large files: S3 multipart upload. The browser asks for pre-signed URLs for
 *  batches of parts, PUTs each part straight to S3/R2, then asks us to complete.
 *
 *  The installer bytes NEVER touch this server.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/errors.js';
import { uploadRequest, multipartSignRequest, multipartCompleteRequest } from '../lib/validation.js';
import {
  keyFor,
  assertOwnKey,
  headObject,
  presignPut,
  createMultipart,
  presignParts,
  completeMultipart,
  abortMultipart,
} from '../storage/s3.js';
import { limits } from '../settings.js';

const r = Router();

// All tunable via env: MULTIPART_THRESHOLD_BYTES, MULTIPART_PART_SIZE_BYTES, MULTIPART_MAX_PARTS
const MULTIPART_THRESHOLD = limits.multipartThresholdBytes;
const MIN_PART = limits.multipartMinPartBytes;
const MAX_PARTS = limits.multipartMaxParts;

function partSizeFor(size) {
  return Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / (1024 * 1024)) * 1024 * 1024);
}

/**
 * POST /api/admin/softwares/upload-url
 * Body: { file_name, file_size_bytes, software_id? }
 */
r.post(
  '/upload-url',
  ah(async (req, res) => {
    const body = uploadRequest.extend({ software_id: z.union([z.string(), z.number()]).optional() }).parse(req.body);
    if (body.file_size_bytes > config.storage.maxUploadBytes)
      throw new HttpError(413, `File is larger than the ${+(config.storage.maxUploadBytes / 1024 ** 3).toFixed(2)} GB limit`);

    // Never let an upload replace a binary that a live software (other than the one being edited) points to.
    const inUse = await query(
      `SELECT id, software_name FROM softwares
       WHERE deleted_at IS NULL AND source <> 'winget' AND COALESCE(file_name, winget_id) = $1
         AND ($2::text IS NULL OR id::text <> $2)`,
      [body.file_name, body.software_id != null ? String(body.software_id) : null],
    );
    if (inUse.rowCount)
      throw new HttpError(
        409,
        `"${body.file_name}" is already used by "${inUse.rows[0].software_name}". Rename the file (e.g. add the version: <name>-v2.1.<ext>).`,
      );

    const key = keyFor(body.file_name);
    const existing = await headObject(key);

    if (body.file_size_bytes < MULTIPART_THRESHOLD) {
      return res.json({
        data: { mode: 'single', storage_key: key, url: await presignPut(key), replaces_existing_object: !!existing },
      });
    }

    const uploadId = await createMultipart(key);
    const partSize = partSizeFor(body.file_size_bytes);
    res.json({
      data: {
        mode: 'multipart',
        storage_key: key,
        upload_id: uploadId,
        part_size: partSize,
        part_count: Math.ceil(body.file_size_bytes / partSize),
        replaces_existing_object: !!existing,
      },
    });
  }),
);

/** POST /api/admin/softwares/multipart/sign-parts */
r.post(
  '/multipart/sign-parts',
  ah(async (req, res) => {
    const b = multipartSignRequest.parse(req.body);
    assertOwnKey(b.storage_key);
    res.json({ data: { parts: await presignParts(b.storage_key, b.upload_id, b.part_numbers) } });
  }),
);

/** POST /api/admin/softwares/multipart/complete */
r.post(
  '/multipart/complete',
  ah(async (req, res) => {
    const b = multipartCompleteRequest.parse(req.body);
    assertOwnKey(b.storage_key);
    await completeMultipart(b.storage_key, b.upload_id, b.parts);
    const obj = await headObject(b.storage_key);
    res.json({ data: { storage_key: b.storage_key, size: obj?.size ?? null } });
  }),
);

/** POST /api/admin/softwares/multipart/abort */
r.post(
  '/multipart/abort',
  ah(async (req, res) => {
    const b = z.object({ storage_key: z.string(), upload_id: z.string() }).parse(req.body);
    assertOwnKey(b.storage_key);
    await abortMultipart(b.storage_key, b.upload_id).catch(() => {});
    res.status(204).end();
  }),
);

/** GET /api/admin/softwares/upload-status?storage_key= — confirm an object landed */
r.get(
  '/upload-status',
  ah(async (req, res) => {
    const key = assertOwnKey(String(req.query.storage_key || ''));
    const obj = await headObject(key);
    if (!obj) throw new HttpError(404, 'Object not found');
    res.json({ data: { storage_key: key, size: obj.size } });
  }),
);

export default r;
