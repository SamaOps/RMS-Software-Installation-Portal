/**
 * PUT /api/storage/upload?key=&exp=&sig= — browser upload target for LOCAL storage.
 * Authorised by the short-lived signature from POST /api/admin/softwares/upload-url
 * (same model as an S3 presigned URL), streamed straight to disk.
 */
import { Router } from 'express';
import { ah, HttpError } from '../lib/errors.js';
import { config } from '../config.js';
import { driver } from '../storage/index.js';
import { verifyUploadSignature, receiveUpload } from '../storage/local.js';

const r = Router();

r.put(
  '/upload',
  ah(async (req, res) => {
    if (driver !== 'local') throw new HttpError(404, 'Not found');
    const { key, exp, sig } = req.query;
    if (!verifyUploadSignature(String(key || ''), String(exp || ''), String(sig || '')))
      throw new HttpError(403, 'Upload link expired or invalid. Start the upload again.');
    const len = Number(req.headers['content-length'] || 0);
    if (len > config.storage.maxUploadBytes) throw new HttpError(413, 'File is larger than the upload limit');
    const out = await receiveUpload(String(key), req, config.storage.maxUploadBytes);
    res.setHeader('ETag', out.etag);
    res.status(200).end();
  }),
);

export default r;
