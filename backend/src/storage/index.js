/**
 * Storage selector: S3/R2 when S3_BUCKET is set, otherwise the portal's own disk.
 * Everything else imports storage from here, never from a driver directly.
 */
import { config } from '../config.js';
import * as s3 from './s3.js';
import * as local from './local.js';

const d = config.storage.driver === 's3' ? s3 : local;

export const driver = config.storage.driver;
export const supportsMultipart = d.supportsMultipart !== false;
export const keyFor = d.keyFor;
export const assertOwnKey = d.assertOwnKey;
export const headObject = d.headObject;
export const presignPut = d.presignPut;
export const createMultipart = d.createMultipart;
export const presignParts = d.presignParts;
export const completeMultipart = d.completeMultipart;
export const abortMultipart = d.abortMultipart;
export const getObjectStream = d.getObjectStream;
export const sha256OfObject = d.sha256OfObject;
export const putObject = d.putObject;

/** URL laptops download from (mirrors the legacy ${BACKEND}/softwares/<file> layout). */
export const publicUrlFor = (fileName) =>
  config.publicDownloadBaseUrl ? `${config.publicDownloadBaseUrl}/${encodeURIComponent(fileName)}` : null;
