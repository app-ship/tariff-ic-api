/**
 * usage.ts — monthly analysis-usage accounting for the Free/Pro paywall.
 *
 * A "completed analysis" is a MaterialSearch row that reached status 'analyzed'
 * in the current calendar month, scoped by orgId. Counting dynamically means the
 * quota self-resets on the 1st of each month with no cron/reset job required.
 */

import { MaterialSearch } from '../models/MaterialSearch.js';
import { Organization, isProPlan } from '../models/Organization.js';
import { isDBConnected } from '../db.js';

/** Free tier allowance, per calendar month, per org. */
export const FREE_ANALYSIS_LIMIT = 5;

export interface UsageSummary {
  plan:        string;
  isPro:       boolean;
  used:        number;
  /** null = unlimited (Pro) */
  limit:       number | null;
  remaining:   number | null;
  canRun:      boolean;
  periodStart: string;   // ISO
  periodEnd:   string;   // ISO (exclusive — first instant of next month)
}

/** First instant of the current month (server local → UTC ISO). */
function startOfMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Resolve the current usage summary for an org. Looks up the org's plan if not
 * provided. Falls back to an unlimited/dev-safe summary when the DB is down.
 */
export async function getUsage(orgId: string, plan?: string): Promise<UsageSummary> {
  const periodStart = startOfMonth();
  const periodEnd   = startOfNextMonth();

  // Resolve plan if the caller didn't pass it.
  let resolvedPlan = plan;
  if (resolvedPlan === undefined && isDBConnected() && orgId) {
    const org = await Organization.findById(orgId).select('plan').lean();
    resolvedPlan = org?.plan ?? 'sandbox';
  }
  const pro = isProPlan(resolvedPlan);

  let used = 0;
  if (isDBConnected() && orgId) {
    // Count every MaterialSearch row created this month that wasn't an error —
    // a material is "used" the moment it is first submitted, not when it completes.
    used = await MaterialSearch.countDocuments({
      orgId,
      status:    { $nin: ['error'] },
      createdAt: { $gte: periodStart, $lt: periodEnd },
    });
  }

  const limit     = pro ? null : FREE_ANALYSIS_LIMIT;
  const remaining = pro ? null : Math.max(0, FREE_ANALYSIS_LIMIT - used);
  const canRun    = pro || used < FREE_ANALYSIS_LIMIT;

  return {
    plan:        resolvedPlan ?? 'sandbox',
    isPro:       pro,
    used,
    limit,
    remaining,
    canRun,
    periodStart: periodStart.toISOString(),
    periodEnd:   periodEnd.toISOString(),
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
