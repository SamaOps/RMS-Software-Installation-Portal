import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  // Postgres constraint violations -> 400/409 instead of 500
  if (err && err.code === '23505') return res.status(409).json({ error: 'Duplicate value', detail: err.detail });
  if (err && (err.code === '23514' || err.code === '22P02')) return res.status(400).json({ error: err.message });

  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: 'Internal server error' });
}
