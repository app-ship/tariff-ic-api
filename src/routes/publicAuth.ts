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
  getUserProfile,
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

// ── POST /auth/social/exchange — exchange Auth0 code for token ────────────────
// Called by the frontend callback page (/auth/callback) after Auth0 redirects
// back to the frontend with ?code=.... The frontend passes the code + the
// redirect_uri it used so Auth0 can verify them match.
router.post('/social/exchange', async (req: Request, res: Response) => {
  const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };

  if (!code || !redirectUri) {
    return res.status(400).json({ error: 'code and redirectUri are required.' });
  }

  try {
    const tokens  = await exchangeCodeForToken(code, redirectUri);
    let profile   = decodeIdToken(tokens.id_token);

    // id_token may be absent or lack email when a custom audience is used.
    // Fall back to the /userinfo endpoint which always returns the full profile.
    if (!profile.email) {
      const userinfo = await getUserProfile(tokens.access_token);
      profile = {
        sub:     profile.sub     || userinfo.sub,
        email:   userinfo.email  || profile.email,
        name:    profile.name    || userinfo.name,
        picture: profile.picture || userinfo.picture,
      };
    }

    return res.json({
      token: tokens.access_token,
      profile: {
        sub:     profile.sub,
        email:   profile.email,
        name:    profile.name,
        picture: profile.picture,
      },
    });
  } catch {
    return res.status(401).json({ error: 'Social sign-in failed. Please try again.' });
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

  const { domain, clientId, audience } = auth0Config();
  const provider = String(req.params['provider'] || '');
  const connection = PROVIDER_CONNECTION[provider];
  if (!connection) {
    return res.status(400).json({ error: 'Unknown provider.' });
  }

  // redirect_uri goes to the frontend — the browser never leaves the real domain
  const frontendUrl = process.env.FRONTEND_URL || 'https://tariffic.infis.ai';
  const callbackUrl = `${frontendUrl}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  callbackUrl,
    connection,
    audience,                               // required — tells Auth0 to issue a signed JWT, not an opaque token
    scope:         'openid profile email',
    state:         req.query.state as string || '',
  });

  return res.redirect(`https://${domain}/authorize?${params.toString()}`);
});

function auth0Config() {
  const issuer = process.env.AUTH0_ISSUER_BASE_URL || '';
  return {
    domain:   process.env.AUTH0_DOMAIN    || issuer.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    clientId: process.env.AUTH0_CLIENT_ID || '',
    audience: process.env.AUTH0_AUDIENCE  || 'https://api.tariffic.ai',
  };
}

export default router;
