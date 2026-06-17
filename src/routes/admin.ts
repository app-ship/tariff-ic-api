/**
 * Admin routes — guarded by ADMIN_SECRET header, never exposed to the browser.
 *
 * POST /admin/set-plan   { email, plan }   → flip any org to 'pro' or 'sandbox'
 * GET  /admin/user       ?email=…          → look up user + org info
 *
 * All requests must include:  X-Admin-Secret: <ADMIN_SECRET env var>
 */

import { Router, type Request, type Response } from 'express';
import { User } from '../models/User.js';
import { Organization } from '../models/Organization.js';

export const adminRouter = Router();

function guardSecret(req: Request, res: Response): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'ADMIN_SECRET is not configured on this server.' });
    return false;
  }
  if (req.headers['x-admin-secret'] !== secret) {
    res.status(401).json({ error: 'Invalid admin secret.' });
    return false;
  }
  return true;
}

// ── POST /admin/set-plan ──────────────────────────────────────────────────────
adminRouter.post('/set-plan', async (req: Request, res: Response) => {
  if (!guardSecret(req, res)) return;

  const { email, plan } = req.body as { email?: string; plan?: string };
  if (!email || !plan) {
    res.status(400).json({ error: '"email" and "plan" are required.' });
    return;
  }
  if (!['sandbox', 'starter', 'pro'].includes(plan)) {
    res.status(400).json({ error: '"plan" must be one of: sandbox, starter, pro' });
    return;
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() }).lean();
  if (!user) {
    res.status(404).json({ error: `No user found with email "${email}".` });
    return;
  }

  const org = await Organization.findByIdAndUpdate(
    user.orgId,
    {
      $set: {
        plan,
        // If upgrading to pro mark it active; if downgrading, clear billing state.
        ...(plan === 'pro'
          ? { subscriptionStatus: 'active' }
          : { subscriptionStatus: 'canceled', stripeSubscriptionId: null, currentPeriodEnd: null }),
      },
    },
    { new: true },
  ).lean();

  if (!org) {
    res.status(404).json({ error: 'Organization record not found.' });
    return;
  }

  console.log(`[admin] set org ${org._id} (${email}) → plan=${plan}`);
  res.json({
    ok: true,
    email,
    orgId: String(org._id),
    plan: org.plan,
    subscriptionStatus: org.subscriptionStatus ?? null,
  });
});

// ── GET /admin/user ───────────────────────────────────────────────────────────
adminRouter.get('/user', async (req: Request, res: Response) => {
  if (!guardSecret(req, res)) return;

  const email = String(req.query.email ?? '').toLowerCase().trim();
  if (!email) {
    res.status(400).json({ error: '"email" query param is required.' });
    return;
  }

  const user = await User.findOne({ email }).lean();
  if (!user) {
    res.status(404).json({ error: `No user found with email "${email}".` });
    return;
  }

  const org = await Organization.findById(user.orgId).lean();

  res.json({
    user: {
      id:       String(user._id),
      email:    user.email,
      name:     user.name,
      role:     user.role,
      auth0Sub: user.auth0Sub,
    },
    org: org
      ? {
          id:                 String(org._id),
          name:               org.name,
          plan:               org.plan,
          subscriptionStatus: org.subscriptionStatus ?? null,
          stripeCustomerId:   org.stripeCustomerId ?? null,
          currentPeriodEnd:   org.currentPeriodEnd ?? null,
        }
      : null,
  });
});
