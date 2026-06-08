/**
 * Public auth routes — custom consumer login/signup (no bearer token required).
 *
 * These are mounted BEFORE the auth middleware so they're reachable without a
 * token. They exchange email/password with Auth0 (ROPG / dbconnections signup)
 * and return an access token. The UI then stores the token and calls the
 * protected /auth/bootstrap to provision the sandbox org.
 *
 *   POST /auth/login     { email, password }            → { token, profile }
 *   POST /auth/register  { email, password, name }       → { token, profile }
 */

import { Router, type Request, type Response } from 'express';
import {
  loginWithPassword,
  signupUser,
  decodeIdToken,
  isAuth0Configured,
  Auth0Error,
} from '../services/auth0Service.js';

const router = Router();

function ensureConfigured(res: Response): boolean {
  if (!isAuth0Configured()) {
    res.status(500).json({ error: 'Authentication is not configured on the server.' });
    return false;
  }
  return true;
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  if (!ensureConfigured(res)) return;

  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const tokens  = await loginWithPassword(email.trim().toLowerCase(), password);
    const profile = decodeIdToken(tokens.id_token);
    return res.json({
      token: tokens.access_token,
      profile: {
        sub:     profile.sub,
        email:   profile.email || email,
        name:    profile.name,
        picture: profile.picture,
      },
    });
  } catch (err) {
    const e = err as Auth0Error;
    return res.status(e.status || 401).json({ error: e.message || 'Login failed.' });
  }
});

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post('/register', async (req: Request, res: Response) => {
  if (!ensureConfigured(res)) return;

  const { email, password, name } = req.body as { email?: string; password?: string; name?: string };
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const normalisedEmail = email.trim().toLowerCase();
  const displayName     = (name || normalisedEmail.split('@')[0]).trim();

  try {
    await signupUser(normalisedEmail, password, displayName);
    // Immediately log the new user in so the UI gets a token in one step.
    const tokens  = await loginWithPassword(normalisedEmail, password);
    const profile = decodeIdToken(tokens.id_token);
    return res.status(201).json({
      token: tokens.access_token,
      profile: {
        sub:     profile.sub,
        email:   profile.email || normalisedEmail,
        name:    profile.name  || displayName,
        picture: profile.picture,
      },
    });
  } catch (err) {
    const e = err as Auth0Error;
    return res.status(e.status || 400).json({ error: e.message || 'Sign up failed.' });
  }
});

export default router;
