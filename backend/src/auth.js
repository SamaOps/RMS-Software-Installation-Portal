import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';

// A fixed dummy hash so unknown usernames cost the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', config.auth.bcryptCost);

export async function login(username, password) {
  const admin = config.auth.admins.find((a) => a.username === username);
  const ok = await bcrypt.compare(password, admin ? admin.hash : DUMMY_HASH);
  if (!admin || !ok) throw new HttpError(401, 'Invalid username or password');
  const token = jwt.sign({ sub: admin.username, role: 'admin' }, config.auth.jwtSecret, {
    expiresIn: config.auth.tokenTtl,
  });
  return { token, username: admin.username };
}

export function requireAdmin(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Authentication required'));
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    if (payload.role !== 'admin') throw new Error('not admin');
    req.user = { username: payload.sub };
    next();
  } catch {
    next(new HttpError(401, 'Session expired or invalid. Please sign in again.'));
  }
}
