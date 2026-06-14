/**
 * Auth0 service — server-side calls for the custom (consumer) login flow.
 *
 * The browser never talks to Auth0 directly. The UI posts email/password to
 * this API, and we exchange them with Auth0 using the Resource Owner Password
 * Grant (ROPG). Signup uses Auth0's public dbconnections/signup endpoint.
 */

function auth0Config() {
  const issuer = process.env.AUTH0_ISSUER_BASE_URL || '';
  return {
    domain:       process.env.AUTH0_DOMAIN || issuer.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    clientId:     process.env.AUTH0_CLIENT_ID     || '',
    clientSecret: process.env.AUTH0_CLIENT_SECRET || '',
    audience:     process.env.AUTH0_AUDIENCE      || '',
    dbConnection: process.env.AUTH0_DB_CONNECTION || 'Username-Password-Authentication',
  };
}

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
  const { domain, clientId, clientSecret } = auth0Config();
  return Boolean(domain && clientId && clientSecret);
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
  const { domain, clientId, clientSecret, audience, dbConnection } = auth0Config();
  const res = await fetch(`https://${domain}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'password',
      client_id:     clientId,
      client_secret: clientSecret,
      audience,
      username:      email,
      password,
      scope:         'openid profile email',
      connection:    dbConnection,
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
  const { domain, clientId, dbConnection } = auth0Config();
  const res = await fetch(`https://${domain}/dbconnections/signup`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:  clientId,
      connection: dbConnection,
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
