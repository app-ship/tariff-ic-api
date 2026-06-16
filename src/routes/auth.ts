/**
 * Auth routes — provisioning, user info, tour progress
 *
 * POST /auth/bootstrap
 *   Called by the UI on every login. Idempotent: returns existing user if found,
 *   otherwise creates org + user + seeds sample analysis, returns needsOnboarding=true.
 *
 * GET  /auth/me
 *   Returns current user + org + onboarding state.
 *
 * PUT  /auth/tour-progress
 *   Persists which tour steps/wizard steps have been completed.
 */

import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { Organization } from '../models/Organization.js';
import { User } from '../models/User.js';
import { isDBConnected } from '../db.js';
import { seedSampleAnalysis } from '../fixtures/sampleAnalysis.js';

const router = Router();

// ── POST /auth/bootstrap ──────────────────────────────────────────────────────
router.post('/bootstrap', async (req: Request, res: Response) => {
  const { auth0Sub } = req.tenant;

  // If DB not connected, return a minimal dev response
  if (!isDBConnected()) {
    return res.json({
      user: { id: 'dev', auth0Sub, email: 'dev@local', name: 'Dev User', role: 'owner', onboardingStep: 2, tourCompleted: true },
      org:  { id: 'dev', name: 'Dev Sandbox', slug: 'dev-sandbox', plan: 'sandbox' },
      needsOnboarding: false,
    });
  }

  // Body params from Auth0 ID token claims forwarded by UI
  const { email = '', name = '', picture = '' } = req.body as {
    email?: string;
    name?: string;
    picture?: string;
  };

  // ── Idempotent: look up by auth0Sub first, then by email (account linking) ──
  let existing = await User.findOne({ auth0Sub }).populate<{ orgId: { name: string; slug: string; plan: string } }>('orgId');

  // Social login: the Google/Microsoft sub differs from the password-login sub.
  // If not found by sub but email matches an existing account, link them.
  if (!existing && email) {
    const byEmail = await User.findOne({ email }).populate<{ orgId: { name: string; slug: string; plan: string } }>('orgId');
    if (byEmail) {
      // Attach the new social sub to the existing account
      await User.updateOne({ _id: byEmail._id }, { $set: { auth0Sub } });
      byEmail.auth0Sub = auth0Sub;
      existing = byEmail;
    }
  }

  if (existing) {
    const orgDoc = existing.orgId as unknown as { _id: mongoose.Types.ObjectId; name: string; slug: string; plan: string };
    return res.json({
      user: {
        id:             String(existing._id),
        auth0Sub:       existing.auth0Sub,
        email:          existing.email,
        name:           existing.name,
        picture:        existing.picture,
        role:           existing.role,
        onboardingStep: existing.onboardingStep,
        tourCompleted:  existing.tourCompleted,
        tourProgress:   Object.fromEntries(existing.tourProgress || []),
        sampleSeeded:   existing.sampleSeeded,
      },
      org: {
        id:   String(orgDoc._id),
        name: orgDoc.name,
        slug: orgDoc.slug,
        plan: orgDoc.plan,
      },
      needsOnboarding: existing.onboardingStep < 1,
    });
  }

  // ── New user — create org, user, seed sample ─────────────────────────────
  if (!email) {
    return res.status(400).json({ error: 'Email is required to create a new account.' });
  }

  const baseName = name || email.split('@')[0] || 'My Sandbox';
  const orgSlug  = await Organization.uniqueSlug(baseName);
  const org = await Organization.create({
    name:        `${baseName}'s Sandbox`,
    slug:        orgSlug,
    ownerUserId: auth0Sub,
    plan:        'sandbox',
  });

  const user = await User.create({
    auth0Sub,
    email,
    name,
    picture,
    orgId:          org._id,
    role:           'owner',
    onboardingStep: 0,
    tourCompleted:  false,
    tourProgress:   {},
    sampleSeeded:   false,
  });

  // Seed sample analysis — fire-and-forget, update sampleSeeded flag when done
  seedSampleAnalysis(String(org._id), String(user._id))
    .then(() => User.updateOne({ _id: user._id }, { sampleSeeded: true }))
    .catch((err: Error) => console.error('[bootstrap] sample seed failed:', err));

  return res.status(201).json({
    user: {
      id:             String(user._id),
      auth0Sub:       user.auth0Sub,
      email:          user.email,
      name:           user.name,
      picture:        user.picture,
      role:           user.role,
      onboardingStep: user.onboardingStep,
      tourCompleted:  user.tourCompleted,
      tourProgress:   {},
      sampleSeeded:   false,
    },
    org: {
      id:   String(org._id),
      name: org.name,
      slug: org.slug,
      plan: org.plan,
    },
    needsOnboarding: true,
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', async (req: Request, res: Response) => {
  if (!isDBConnected()) {
    return res.json({
      user: { id: 'dev', auth0Sub: req.tenant.auth0Sub, email: 'dev@local', name: 'Dev User', role: 'owner', onboardingStep: 2, tourCompleted: true },
      org:  { id: 'dev', name: 'Dev Sandbox', slug: 'dev-sandbox', plan: 'sandbox' },
    });
  }

  const user = await User.findOne({ auth0Sub: req.tenant.auth0Sub });
  if (!user) return res.status(404).json({ error: 'User not provisioned — call /auth/bootstrap first' });

  const org = await Organization.findById(user.orgId);

  return res.json({
    user: {
      id:             String(user._id),
      auth0Sub:       user.auth0Sub,
      email:          user.email,
      name:           user.name,
      picture:        user.picture,
      role:           user.role,
      onboardingStep: user.onboardingStep,
      tourCompleted:  user.tourCompleted,
      tourProgress:   Object.fromEntries(user.tourProgress || []),
      sampleSeeded:   user.sampleSeeded,
    },
    org: org
      ? { id: String(org._id), name: org.name, slug: org.slug, plan: org.plan }
      : null,
  });
});

// ── PUT /auth/tour-progress ───────────────────────────────────────────────────
router.put('/tour-progress', async (req: Request, res: Response) => {
  const {
    step, completed, tourProgress,
    jobRole, importCategories, annualSpend, newsletterOptIn,
  } = req.body as {
    step?:             number;
    completed?:        boolean;
    tourProgress?:     Record<string, boolean>;
    jobRole?:          string;
    importCategories?: string[];
    annualSpend?:      string;
    newsletterOptIn?:  boolean;
  };

  if (!isDBConnected()) {
    return res.json({ ok: true });
  }

  const update: Record<string, unknown> = {};

  // Progress fields
  if (typeof step === 'number')       update.onboardingStep = step;
  if (typeof completed === 'boolean') update.tourCompleted  = completed;
  if (tourProgress) {
    for (const [k, v] of Object.entries(tourProgress)) {
      update[`tourProgress.${k}`] = v;
    }
  }

  // Onboarding wizard answers
  if (jobRole)                          update.jobRole          = jobRole;
  if (Array.isArray(importCategories))  update.importCategories = importCategories;
  if (annualSpend)                      update.annualSpend      = annualSpend;
  if (typeof newsletterOptIn === 'boolean') update.newsletterOptIn = newsletterOptIn;

  await User.updateOne({ auth0Sub: req.tenant.auth0Sub }, { $set: update });

  // Also denormalise spend/industry onto the org for analytics queries
  if (annualSpend || importCategories?.length) {
    const user = await User.findOne({ auth0Sub: req.tenant.auth0Sub }).select('orgId').lean();
    if (user) {
      const orgUpdate: Record<string, unknown> = {};
      if (annualSpend)              orgUpdate.annualSpend = annualSpend;
      if (importCategories?.length) orgUpdate.industry    = importCategories[0];
      await Organization.updateOne({ _id: user.orgId }, { $set: orgUpdate });
    }
  }

  return res.json({ ok: true });
});

export default router;
