/**
 * Admin routes — JWT-authenticated, role === 'admin' required on every request.
 *
 * GET  /admin/users              → paginated user list (joined with org plan)
 * GET  /admin/user?email=…       → single user + org detail
 * POST /admin/set-plan           → flip any org's plan (sandbox | starter | pro)
 * POST /admin/set-role           → change a user's role (owner | member | admin)
 *
 * All routes require a valid Bearer token AND req.tenant.role === 'admin'.
 * Mount this router AFTER authMiddleware in index.ts.
 */

import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { User } from '../models/User.js';
import { Organization } from '../models/Organization.js';
import { MaterialSearch } from '../models/MaterialSearch.js';

export const adminRouter = Router();

// Apply admin guard to every route in this router
adminRouter.use(requireAdmin);

// ── GET /admin/users ──────────────────────────────────────────────────────────
adminRouter.get('/users', async (req: Request, res: Response) => {
  const limit      = Math.min(200, Math.max(1, parseInt(String(req.query.limit  ?? 50))));
  const offset     = Math.max(0,               parseInt(String(req.query.offset ?? 0)));
  const search     = String(req.query.search ?? '').trim();
  const planFilter = String(req.query.plan   ?? '').trim();

  const userQuery: Record<string, unknown> = {};
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    userQuery.$or = [{ email: re }, { name: re }];
  }

  const [users, total] = await Promise.all([
    User.find(userQuery).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    User.countDocuments(userQuery),
  ]);

  const orgIds = [...new Set(users.map((u) => String(u.orgId)))];
  const orgs   = await Organization.find({ _id: { $in: orgIds } })
    .select('_id name plan subscriptionStatus stripeCustomerId currentPeriodEnd')
    .lean();
  const orgMap = Object.fromEntries(orgs.map((o) => [String(o._id), o]));

  let rows = users.map((u) => {
    const org = orgMap[String(u.orgId)] ?? null;
    return {
      userId:             String(u._id),
      email:              u.email,
      name:               u.name,
      role:               u.role,
      jobRole:            u.jobRole ?? '',
      signedUpAt:         u.createdAt,
      lastLoginAt:        u.lastLoginAt ?? null,
      loginCount:         u.loginCount  ?? 0,
      classifyCount:      u.classifyCount ?? 0,
      analyzeCount:       u.analyzeCount  ?? 0,
      orgId:              String(u.orgId),
      orgName:            org?.name ?? '',
      plan:               org?.plan ?? 'sandbox',
      subscriptionStatus: org?.subscriptionStatus ?? null,
      currentPeriodEnd:   org?.currentPeriodEnd ?? null,
      stripeCustomerId:   org?.stripeCustomerId ?? null,
    };
  });

  if (planFilter) rows = rows.filter((r) => r.plan === planFilter);

  res.json({ users: rows, total, limit, offset });
});

// ── GET /admin/user?email=… ───────────────────────────────────────────────────
adminRouter.get('/user', async (req: Request, res: Response) => {
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
    org: org ? {
      id:                 String(org._id),
      name:               org.name,
      plan:               org.plan,
      subscriptionStatus: org.subscriptionStatus ?? null,
      stripeCustomerId:   org.stripeCustomerId ?? null,
      currentPeriodEnd:   org.currentPeriodEnd ?? null,
    } : null,
  });
});

// ── POST /admin/set-plan ──────────────────────────────────────────────────────
adminRouter.post('/set-plan', async (req: Request, res: Response) => {
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

  console.log(`[admin] ${req.tenant.userId} set org ${org._id} (${email}) → plan=${plan}`);
  res.json({
    ok: true,
    email,
    orgId: String(org._id),
    plan:               org.plan,
    subscriptionStatus: org.subscriptionStatus ?? null,
  });
});

// ── POST /admin/set-role ──────────────────────────────────────────────────────
adminRouter.post('/set-role', async (req: Request, res: Response) => {
  const { email, role } = req.body as { email?: string; role?: string };
  if (!email || !role) {
    res.status(400).json({ error: '"email" and "role" are required.' });
    return;
  }
  if (!['owner', 'member', 'admin'].includes(role)) {
    res.status(400).json({ error: '"role" must be one of: owner, member, admin' });
    return;
  }

  // Prevent an admin from accidentally stripping their own admin role
  const self = await User.findById(req.tenant.userId).select('email').lean();
  if (self?.email.toLowerCase() === email.toLowerCase().trim() && role !== 'admin') {
    res.status(400).json({ error: 'You cannot remove your own admin role.' });
    return;
  }

  const updated = await User.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    { $set: { role } },
    { new: true },
  ).lean();

  if (!updated) {
    res.status(404).json({ error: `No user found with email "${email}".` });
    return;
  }

  console.log(`[admin] ${req.tenant.userId} set user ${updated._id} (${email}) → role=${role}`);
  res.json({ ok: true, email, userId: String(updated._id), role: updated.role });
});

// ── GET /admin/users/:userId/usage ────────────────────────────────────────────
adminRouter.get('/users/:userId/usage', async (req: Request, res: Response) => {
  const { userId } = req.params;

  const user = await User.findById(userId).lean();
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const [org, recentSearches] = await Promise.all([
    Organization.findById(user.orgId)
      .select('name plan subscriptionStatus')
      .lean(),
    MaterialSearch.find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('materialName htsCode status createdAt')
      .lean(),
  ]);

  res.json({
    userId:             String(user._id),
    email:              user.email,
    name:               user.name,
    signedUpAt:         user.createdAt,
    lastLoginAt:        user.lastLoginAt ?? null,
    loginCount:         user.loginCount   ?? 0,
    classifyCount:      user.classifyCount ?? 0,
    analyzeCount:       user.analyzeCount  ?? 0,
    plan:               org?.plan ?? 'sandbox',
    subscriptionStatus: org?.subscriptionStatus ?? null,
    recentSearches:     recentSearches.map((s) => ({
      materialName: s.materialName,
      htsCode:      s.htsCode ?? null,
      status:       s.status,
      createdAt:    s.createdAt,
    })),
  });
});
