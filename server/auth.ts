import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db.ts';

/**
 * server/auth.ts
 * ------------------------------------------------------------------
 * Minimal, dependency-light session layer for the API:
 *  - bcrypt for password hashing/verification (never store/return plaintext)
 *  - HMAC-signed, stateless bearer tokens (a lightweight JWT-alike) so we
 *    don't need an extra session store; tokens are verified on every
 *    protected request.
 *  - requireAuth / requireRole middlewares that enforce access server-side
 *    (client-side permission checks in the UI are a UX nicety only - the
 *    real security boundary MUST live here).
 *
 * SESSION_SECRET should be set via environment variable in production.
 * A random secret is generated at boot as a fallback so the app still
 * works out-of-the-box, but note this means existing tokens are invalidated
 * on every server restart unless SESSION_SECRET is set explicitly.
 */

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Returns true if a string already looks like a bcrypt hash (used to avoid double-hashing). */
export function isBcryptHash(value: string | undefined | null): boolean {
  return !!value && /^\$2[aby]\$\d{2}\$/.test(value);
}

export interface TokenPayload {
  id: string;
  employeeId: string;
  role: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export function signToken(payload: Omit<TokenPayload, 'iat' | 'exp'>): string {
  const now = Date.now();
  const full: TokenPayload = { ...payload, iat: now, exp: now + TOKEN_TTL_MS };
  const body = base64url(JSON.stringify(full));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expectedSig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload: TokenPayload = JSON.parse(base64urlDecode(body).toString('utf8'));
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: TokenPayload;
    }
  }
}

/** Requires a valid bearer token; attaches the decoded payload to req.currentUser. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] || '';
  const token = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(.+)$/.exec(token || '');
  if (!match) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const payload = verifyToken(match[1]);
  if (!payload) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
  req.currentUser = payload;
  next();
}

/**
 * Requires the current user to hold one of the given roles (case-insensitive).
 * ADMIN is always implicitly allowed regardless of the list passed in.
 */
export function requireRole(...roles: string[]) {
  const allowed = new Set(roles.map(r => r.toUpperCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req.currentUser?.role || '').toUpperCase();
    if (role === 'ADMIN' || allowed.has(role)) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
}

/**
 * Requires the current user's role to have a specific feature permission
 * enabled (checked against the roles table saved by the admin). Falls back
 * to `requireRole('ADMIN')` behaviour if the role record can't be found -
 * i.e. deny by default, never silently allow.
 */
export function requireFeaturePermission(featureKey: string, actionKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const role = (req.currentUser?.role || '').toUpperCase();
    if (role === 'ADMIN') return next();

    const pool = getPool();
    if (!pool) {
      return res.status(403).json({ error: 'Permission check unavailable.' });
    }
    try {
      const result = await pool.query('SELECT feature_permissions FROM roles WHERE UPPER(role_id) = UPPER($1)', [req.currentUser?.role]);
      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'No permission profile found for your role.' });
      }
      const featurePermissions = result.rows[0].feature_permissions ? JSON.parse(result.rows[0].feature_permissions) : {};
      const actions = featurePermissions[featureKey];
      if (actions && actions[actionKey]) {
        return next();
      }
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    } catch (err) {
      console.error('Permission check failed:', err);
      return res.status(403).json({ error: 'Permission check failed.' });
    }
  };
}
