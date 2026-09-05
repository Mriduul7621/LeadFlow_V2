import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

export const securityHeaders = helmet();

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const requestSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.any().optional(),
});

export function validateRequest(req: Request, res: Response, next: NextFunction) {
  const parsed = requestSchema.safeParse({ body: req.body, query: req.query, params: req.params });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request payload.' });
  }
  next();
}

export function sanitizeInput(req: Request, res: Response, next: NextFunction) {
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/<script|javascript:/gi, '').trim();
    }
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
    }
    return value;
  };
  req.body = sanitize(req.body);
  req.query = sanitize(req.query) as typeof req.query;
  req.params = sanitize(req.params) as typeof req.params;
  next();
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
}
