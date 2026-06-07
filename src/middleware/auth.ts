/**
 * Auth middleware
 *
 * Strategy (in order):
 *  1. X-Api-Key header — static API key (simple / service-to-service)
 *  2. Authorization: Bearer <jwt> — signed user token (JWT_SECRET in env)
 *  3. Dev bypass — if API_KEY is not set, allow through with default tenant
 *
 * On success, attaches `req.tenant = { orgId, userId }` for downstream use.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface Tenant {
  orgId: string;
  userId: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant: Tenant;
    }
  }
}

const API_KEY      = process.env.API_KEY;
const JWT_SECRET   = process.env.JWT_SECRET;
const DEFAULT_ORG  = process.env.DEFAULT_ORG_ID  || 'tariffic-dev-org';
const DEFAULT_USER = process.env.DEFAULT_USER_ID  || 'tariffic-dev-user';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ── 1. API key ────────────────────────────────────────────────────────
  const providedKey = req.headers['x-api-key'] as string | undefined;
  if (API_KEY && providedKey) {
    if (providedKey !== API_KEY) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    // Key valid — extract tenant hints from optional headers
    req.tenant = {
      orgId:  (req.headers['x-org-id']  as string) || DEFAULT_ORG,
      userId: (req.headers['x-user-id'] as string) || DEFAULT_USER,
    };
    return next();
  }

  // ── 2. JWT Bearer ─────────────────────────────────────────────────────
  const bearer = req.headers.authorization;
  if (JWT_SECRET && bearer?.startsWith('Bearer ')) {
    const token = bearer.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
      req.tenant = {
        orgId:  (payload.org_id  as string) || DEFAULT_ORG,
        userId: (payload.user_id as string || payload.sub as string) || DEFAULT_USER,
      };
      return next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }

  // ── 3. Dev bypass ─────────────────────────────────────────────────────
  // If neither API_KEY nor JWT_SECRET is configured, allow through with
  // default tenant (local dev only — never deploy without at least API_KEY).
  if (!API_KEY && !JWT_SECRET) {
    req.tenant = { orgId: DEFAULT_ORG, userId: DEFAULT_USER };
    return next();
  }

  res.status(401).json({ error: 'Authentication required' });
}
