/**
 * Public auth routes — custom consumer login/signup (no bearer token required).
 *
 * These are mounted BEFORE the auth middleware so they're reachable without a
 * token. They exchange email/password with Auth0 (ROPG / dbconnections signup)
 * and return an access token. The UI then stores the token and calls the
 * protected /auth/bootstrap to provision the sandbox org.
 *
 *   POST /auth/login              { email, password }  → { token, profile }
 *   POST /auth/register           { email, password, name } → { token, profile }
 *   GET  /auth/social/:provider   → redirect to Auth0 authorize URL
 *   GET  /auth/social/callback    → exchange Auth0 code → token, redirect to frontend
 */

import { Router, type Request, type Response } from 'express';
import {
  loginWithPassword,
  signupUser,
  decodeIdToken,
  exchangeCodeForToken,
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

// ── GET /auth/social/:provider — redirect to Auth0 authorize URL ──────────────
// provider: 'google' | 'microsoft'
const PROVIDER_CONNECTION: Record<string, string> = {
  google:    'google-oauth2',
  microsoft: 'windowslive',
};

router.get('/social/:provider', (req: Request, res: Response) => {
  if (!ensureConfigured(res)) return;

  const { domain, clientId } = auth0Config();
  const provider = String(req.params['provider'] || '');
  const connection = PROVIDER_CONNECTION[provider];
  if (!connection) {
    return res.status(400).json({ error: 'Unknown provider.' });
  }

  const callbackUrl = `${process.env.API_BASE_URL || `https://${req.headers.host}`}/auth/social/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  callbackUrl,
    connection,
    scope:         'openid profile email',
    state:         req.query.state as string || '',
  });

  return res.redirect(`https://${domain}/authorize?${params.toString()}`);
});

// ── GET /auth/social/callback — exchange code, redirect to frontend ───────────
router.get('/social/callback', async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://tariffic.infis.ai';
  const errorRedirect = `${frontendUrl}/login?error=social_auth_failed`;

  const code  = req.query.code  as string | undefined;
  const error = req.query.error as string | undefined;

  if (error || !code) {
    return res.redirect(errorRedirect);
  }

  try {
    const callbackUrl = `${process.env.API_BASE_URL || `https://${req.headers.host}`}/auth/social/callback`;
    const tokens  = await exchangeCodeForToken(code, callbackUrl);
    const profile = decodeIdToken(tokens.id_token);

    // Pass token to the frontend via query param (short-lived; frontend stores it immediately)
    const params = new URLSearchParams({ token: tokens.access_token });
    if (profile.email)   params.set('email',   profile.email);
    if (profile.name)    params.set('name',     profile.name);
    if (profile.picture) params.set('picture',  profile.picture);

    return res.redirect(`${frontendUrl}/auth/callback?${params.toString()}`);
  } catch {
    return res.redirect(errorRedirect);
  }
});

function auth0Config() {
  const issuer = process.env.AUTH0_ISSUER_BASE_URL || '';
  return {
    domain:   process.env.AUTH0_DOMAIN || issuer.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    clientId: process.env.AUTH0_CLIENT_ID || '',
  };
}

export default router;
