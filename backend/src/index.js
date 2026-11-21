import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { config } from './config.js';
import { pool } from './db.js';
import { login, requireAdmin } from './auth.js';
import { ah, errorHandler } from './lib/errors.js';
import { introspect } from './lib/schema.js';
import { limits } from './settings.js';
import { startRolloutJob } from './lib/rollout.js';
import softwares from './routes/softwares.js';
import uploads from './routes/uploads.js';
import lookups from './routes/lookups.js';
import analytics from './routes/analytics.js';
import history from './routes/history.js';
import devices from './routes/devices.js';
import delivery from './routes/delivery.js';
import clientReports from './routes/clientReports.js';
import storageUpload from './routes/storageUpload.js';

const app = express();
app.set('trust proxy', 1); // behind Nginx
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // CSP is set by the static host / Nginx
const adminJson = express.json({ limit: '1mb' });
// /api/client/* parses its own (larger, report-sized) bodies.
app.use((req, res, next) => (req.path.startsWith('/api/client/') ? next() : adminJson(req, res, next)));
if (config.corsOrigins.length)
  app.use(
    '/api/admin',
    cors({ origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }),
  );

app.get('/healthz', ah(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// --- Auth -------------------------------------------------------------------
app.post(
  '/api/admin/auth/login',
  rateLimit({
    windowMs: limits.loginRateWindowMinutes * 60 * 1000,
    limit: limits.loginRateMax,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  ah(async (req, res) => {
    const { username, password } = z
      .object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) })
      .parse(req.body);
    res.json({ data: await login(username, password) });
  }),
);
app.get('/api/admin/auth/me', requireAdmin, (req, res) => res.json({ data: req.user }));

// --- Admin API (all authenticated) ------------------------------------------
const admin = express.Router();
admin.use(requireAdmin);
admin.use('/softwares', uploads); // /upload-url, /multipart/* (mounted first so they don't hit /:id)
admin.use('/softwares', softwares);
admin.use('/lookups', lookups);
admin.use('/analytics', analytics);
admin.use('/history', history);
admin.use('/devices', devices);
app.use('/api/admin', admin);

// --- Local storage upload target (signed URLs, like S3 presigned PUTs) --------
app.use('/api/storage', storageUpload);

// --- Public: detailed results posted by generated install scripts ------------
app.use('/api/client', clientReports);

// --- Optional binary delivery proxy -----------------------------------------
if (config.enableDownloadProxy) {
  app.use(config.downloadProxyPath, delivery);
  console.log(`[delivery] serving ${config.downloadProxyPath}/:file from ${config.storage.driver} storage`);
}

// --- Serve the built frontend if present (single-container deploy) ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  const proxyPrefix = config.downloadProxyPath.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reserved = new RegExp(`^/(?!api/|${proxyPrefix}/|healthz).*`);
  app.get(reserved, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

await introspect();
startRolloutJob();
app.listen(config.port, () => console.log(`RMS Software Portal API listening on :${config.port}`));
