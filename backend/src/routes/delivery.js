/**
 * OPTIONAL download proxy: GET /softwares/:file
 *
 * Only mounted when ENABLE_DOWNLOAD_PROXY=true. Use it when you'd rather not make
 * the bucket reachable from Nginx directly (e.g. a fully private bucket with no
 * CloudFront). It streams from S3/R2 with Range support so interrupted client
 * downloads can resume. The preferred production path is still Nginx -> S3/CDN
 * (see integration/INTEGRATION_GUIDE.md) because it keeps traffic off Node.
 */
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { ah } from '../lib/errors.js';
import { FILE_NAME_RE } from '../lib/validation.js';
import { wrapperNameRegex } from '../lib/wrapperScript.js';
import { getObjectStream, keyFor } from '../storage/s3.js';

const r = Router();

r.get(
  '/:file',
  ah(async (req, res) => {
    const file = req.params.file;
    if (!FILE_NAME_RE.test(file) && !wrapperNameRegex.test(file)) return res.status(404).end();
    const range = /^bytes=\d*-\d*$/.test(req.headers.range || '') ? req.headers.range : undefined;
    let obj;
    try {
      obj = await getObjectStream(keyFor(file), range);
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      if (code === 404 || err?.name === 'NoSuchKey') return res.status(404).end();
      if (code === 416) return res.status(416).end();
      throw err;
    }
    res.status(obj.contentRange ? 206 : 200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);
    if (obj.contentRange) res.setHeader('Content-Range', obj.contentRange);
    if (obj.etag) res.setHeader('ETag', obj.etag);
    await pipeline(obj.body, res).catch(() => {}); // client aborted
  }),
);

export default r;
