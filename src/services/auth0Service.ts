/**
 * Auth0 service — server-side calls for the custom (consumer) login flow.
 *
 * The browser never talks to Auth0 directly. The UI posts email/password to
 * this API, and we exchange them with Auth0 using the Resource Owner Password
 * Grant (ROPG). Signup uses Auth0's public dbconnections/signup endpoint.
 */

const DOMAIN        = process.env.AUTH0_DOMAIN        || (process.env.AUTH0_ISSUER_BASE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLIENT_ID     = process.env.AUTH0_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET || '';
const AUDIENCE      = process.env.AUTH0_AUDIENCE      || '';
const DB_CONNECTION = process.env.AUTH0_DB_CONNECTION || 'Username-Password-Authentication';

export interface Auth0Tokens {
  access_token: string;
  id_token?:    string;
  expires_in?:  number;
  token_type?:  string;
}

export interface Auth0Profile {
  sub?:     string;
  email?:   string;
  name?:    string;
  picture?: string;
}

export function isAuth0Configured(): boolean {
  return Boolean(DOMAIN && CLIENT_ID && CLIENT_SECRET);
}

/** Map an Auth0 error body to a friendly, consumer-facing message. */
function friendlyAuthError(status: number, body: { error?: string; error_description?: string; description?: string; code?: string }): string {
  const code = body.error || body.code || '';
  const desc = body.error_description || body.description || '';

  if (code === 'invalid_grant' || /wrong email or password/i.test(desc)) {
    return 'Incorrect email or password.';
  }
  if (code === 'too_many_attempts') {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (code === 'invalid_signup' || /already exists|user already/i.test(desc)) {
    return 'An account with this email already exists.';
  }
  if (code === 'invalid_password' || /password/i.test(desc)) {
    return desc || 'Password does not meet the requirements.';
  }
  if (status === 429) {
    return 'Too many requests. Please try again shortly.';
  }
  return desc || 'Authentication failed. Please try again.';
}

export class Auth0Error extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'Auth0Error';
  }
}

/** Resource Owner Password Grant — exchange email/password for tokens. */
export async function loginWithPassword(email: string, password: string): Promise<Auth0Tokens> {
  const res = await fetch(`https://${DOMAIN}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'password',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience:      AUDIENCE,
      username:      email,
      password,
      scope:         'openid profile email',
      connection:    DB_CONNECTION,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Auth0Error(friendlyAuthError(res.status, data), res.status === 429 ? 429 : 401);
  }
  return data as Auth0Tokens;
}

/** Create a new database user via Auth0's public signup endpoint. */
export async function signupUser(email: string, password: string, name: string): Promise<void> {
  const res = await fetch(`https://${DOMAIN}/dbconnections/signup`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:  CLIENT_ID,
      connection: DB_CONNECTION,
      email,
      password,
      name,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Auth0Error(friendlyAuthError(res.status, data), res.status);
  }
}

/** Decode an Auth0 ID token payload without verifying (we trust the token endpoint response). */
export function decodeIdToken(idToken?: string): Auth0Profile {
  if (!idToken) return {};
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json) as Auth0Profile;
  } catch {
    return {};
  }
}
