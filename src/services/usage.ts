/**
 * usage.ts — analysis-usage accounting for the Free/Pro/Enterprise paywall.
 *
 * A "completed analysis" is a MaterialSearch row that was submitted (any
 * non-error status) — counting dynamically means the quota is always derived
 * from source-of-truth data with no cron/reset job required.
 *
 * Tiers:
 *  - Free (sandbox/starter): 5 analyses LIFETIME, counted from org.usageResetAt
 *    (or the beginning of time if never reset). An admin can reset this from
 *    the Admin page to grant a fresh allotment.
 *  - Pro: 100 analyses per CALENDAR MONTH — self-resets on the 1st.
 *  - Enterprise: unlimited.
 */

import { MaterialSearch } from '../models/MaterialSearch.js';
import { Organization, isPaidPlan, PLAN_LIMITS, type OrgPlan } from '../models/Organization.js';
import { isDBConnected } from '../db.js';

/** Free tier lifetime allowance (resettable by an admin). */
export const FREE_ANALYSIS_LIMIT = PLAN_LIMITS.sandbox as number;
/** Pro tier monthly allowance. */
export const PRO_ANALYSIS_LIMIT = PLAN_LIMITS.pro as number;

export type UsageTier = 'free' | 'pro' | 'enterprise';

export interface UsageSummary {
  plan:        string;
  tier:        UsageTier;
  isPro:       boolean;
  used:        number;
  /** null = unlimited (Enterprise) */
  limit:       number | null;
  remaining:   number | null;
  canRun:      boolean;
  /** Which tier the user should be pointed to when they hit their limit. */
  upsellTier:  'pro' | 'enterprise' | null;
  periodStart: string;   // ISO
  periodEnd:   string;   // ISO — exclusive; empty string when the window is lifetime (free tier)
}

function tierForPlan(plan?: string | null): UsageTier {
  if (plan === 'enterprise') return 'enterprise';
  if (plan === 'pro') return 'pro';
  return 'free';
}

/** First instant of the current month (server local → UTC ISO). */
function startOfMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Resolve the current usage summary for an org. Looks up the org's plan (and,
 * for free orgs, the usage-reset anchor) if not provided. Falls back to an
 * unlimited/dev-safe summary when the DB is down.
 */
export async function getUsage(orgId: string, plan?: string): Promise<UsageSummary> {
  let resolvedPlan = plan;
  let usageResetAt: Date | undefined;

  if (isDBConnected() && orgId) {
    if (resolvedPlan === undefined) {
      const org = await Organization.findById(orgId).select('plan usageResetAt').lean();
      resolvedPlan = org?.plan ?? 'sandbox';
      usageResetAt = org?.usageResetAt;
    } else {
      const org = await Organization.findById(orgId).select('usageResetAt').lean();
      usageResetAt = org?.usageResetAt;
    }
  }

  const tier  = tierForPlan(resolvedPlan);
  const limit = PLAN_LIMITS[(resolvedPlan as OrgPlan) ?? 'sandbox'] ?? null;

  let used = 0;
  let periodStart = '';
  let periodEnd   = '';

  if (tier === 'pro') {
    // Monthly window, auto-resets on the 1st.
    const monthStart = startOfMonth();
    const monthEnd   = startOfNextMonth();
    periodStart = monthStart.toISOString();
    periodEnd   = monthEnd.toISOString();
    if (isDBConnected() && orgId) {
      used = await MaterialSearch.countDocuments({
        orgId,
        status:    { $nin: ['error'] },
        createdAt: { $gte: monthStart, $lt: monthEnd },
      });
    }
  } else if (tier === 'free') {
    // Lifetime window, anchored at usageResetAt (or all-time if never reset).
    const anchor = usageResetAt ?? new Date(0);
    periodStart = anchor.toISOString();
    periodEnd   = '';
    if (isDBConnected() && orgId) {
      used = await MaterialSearch.countDocuments({
        orgId,
        status:    { $nin: ['error'] },
        createdAt: { $gte: anchor },
      });
    }
  }
  // Enterprise: used stays 0 for quota purposes — unlimited, no gating.

  const remaining = limit === null ? null : Math.max(0, limit - used);
  const canRun    = limit === null || used < limit;
  const upsellTier: UsageSummary['upsellTier'] =
    canRun ? null : (tier === 'free' ? 'pro' : tier === 'pro' ? 'enterprise' : null);

  return {
    plan: resolvedPlan ?? 'sandbox',
    tier,
    isPro: isPaidPlan(resolvedPlan),
    used,
    limit,
    remaining,
    canRun,
    upsellTier,
    periodStart,
    periodEnd,
  };
}

/**
 * Guard used by the classify/analyze routes. Returns null if the org may run a
 * new analysis, or a UsageSummary describing the exceeded limit otherwise.
 */
export async function checkCanRun(orgId: string, plan?: string): Promise<UsageSummary | null> {
  const usage = await getUsage(orgId, plan);
  return usage.canRun ? null : usage;
}
