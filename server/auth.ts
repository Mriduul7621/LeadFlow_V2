import { NextFunction, Request, Response } from 'express';
import { hashPassword, isBcryptHash, verifyPassword } from './utils/password.js';
import { signToken as createToken, verifyToken as decodeToken, JwtPayload } from './utils/jwt.js';

export { hashPassword, isBcryptHash, verifyPassword };

export type CurrentUser = Omit<JwtPayload, 'role' | 'roleCode'> & {
  employeeId: string;
  role: string;
  roleCode: string;
};

export function signToken(payload: { id: string; employeeId: string; role: string }): string {
  return createToken({
    id: payload.id,
    employeeId: payload.employeeId,
    role: payload.role,
    roleId: payload.role,
    roleCode: payload.role,
    roleName: payload.role,
    hierarchyLevel: 0,
  });
}

export function verifyToken(token: string): CurrentUser | null {
  const payload = decodeToken(token);
  if (!payload) return null;

  const employeeId = payload.employeeId || '';
  const role = payload.role || payload.roleCode || 'USER';

  if (!employeeId) {
    return null;
  }

  return {
    ...payload,
    employeeId,
    role,
    roleCode: payload.roleCode || role,
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = verifyToken(header.slice(7));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.currentUser = user;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const currentRole = req.currentUser?.role?.toUpperCase();
    if (!req.currentUser || !currentRole || !roles.some(role => role.toUpperCase() === currentRole)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

