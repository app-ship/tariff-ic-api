/**
 * Auth middleware
 *
 * Production: validates Auth0 RS256 access tokens via JWKS.
 *   Requires AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE env vars.
 *   After JWT verification, resolves auth0Sub -> Mongo User and stamps req.tenant.
 *
 * Dev bypass: if NODE_ENV !== 'production' and AUTH0_ISSUER_BASE_URL is unset,
 *   requests pass through with DEFAULT_ORG_ID / DEFAULT_USER_ID as tenant.
 */

import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isDBConnected } from '../db.js';
import { User } from '../models/User.js';

export interface Tenant {
  orgId:    string;
  userId:   string;    // Mongo User _id as string
  auth0Sub: string;
  role:     'owner' | 'member' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      tenant: Tenant;
    }
  }
}

const ISSUER_BASE    = process.env.AUTH0_ISSUER_BASE_URL ?? '';
const AUDIENCE       = process.env.AUTH0_AUDIENCE ?? '';
const DEFAULT_ORG    = process.env.DEFAULT_ORG_ID  || 'tariffic-dev-org';
const DEFAULT_USER   = process.env.DEFAULT_USER_ID || 'tariffic-dev-user';

// Lazily initialised JWKS set (cached connection)
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks && ISSUER_BASE) {
    const issuer = ISSUER_BASE.replace(/\/$/, '');
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  return jwks;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const keyset = getJwks();

  // ── Dev bypass ────────────────────────────────────────────────────────────
  if (!keyset) {
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'Auth not configured — set AUTH0_ISSUER_BASE_URL' });
      return;
    }
    req.tenant = { orgId: DEFAULT_ORG, userId: DEFAULT_USER, auth0Sub: 'dev|bypass', role: 'admin' };
    return next();
  }

  // ── Extract bearer token ──────────────────────────────────────────────────
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  const token = header.slice(7);

  // ── Verify Auth0 JWT ─────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    const { payload: p } = await jwtVerify(token, keyset, {
      issuer:   ISSUER_BASE.replace(/\/$/, '') + '/',
      audience: AUDIENCE,
    });
    payload = p as Record<string, unknown>;
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token', detail: (err as Error).message });
    return;
  }

  const auth0Sub = payload.sub as string;

  // ── Resolve to local user (if DB is connected) ────────────────────────────
  if (isDBConnected()) {
    try {
      const user = await User.findOne({ auth0Sub }).lean();
      if (user) {
        req.tenant = {
          orgId:    String(user.orgId),
          userId:   String(user._id),
          auth0Sub,
          role:     user.role as 'owner' | 'member' | 'admin',
        };
        return next();
      }
    } catch {
      // DB error — fall through to sub-based tenant (bootstrap will fix it)
    }
  }

  // User not yet provisioned (bootstrap not called yet) — allow through so
  // /auth/bootstrap can create the record. Tenant uses auth0Sub as placeholder.
  req.tenant = { orgId: '', userId: '', auth0Sub, role: 'member' };
  return next();
}
