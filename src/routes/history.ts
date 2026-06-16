/**
 * GET /history
 *
 * Proxies to deep-research: GET /material/tariff/searches
 * For sandbox orgs (or dev mode) prepends the synthetic isSample fixture
 * so the UI always has at least one demo result to show.
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';
import { SampleEntry } from '../fixtures/sampleAnalysis.js';
import { User } from '../models/User.js';
import { isDBConnected } from '../db.js';

export const historyRouter = Router();

historyRouter.get('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const { limit = 20, sort_by = 'updatedAt', sort_order = -1 } = req.query;

    // Fetch real history from deep-research
    let realHistory: unknown[] = [];
    try {
      const { data } = await drClient.get('/material/tariff/searches', {
        params: {
          org_id:      orgId || 'tariffic-dev-org',
          user_id:     userId || 'tariffic-dev-user',
          limit,
          sort_by,
          sort_order,
          search_type: 'tax_rate_calculation',
        },
      });
      realHistory = Array.isArray(data?.searches) ? data.searches
                  : Array.isArray(data)            ? data
                  : [];
    } catch {
      // deep-research unavailable — degrade gracefully
      realHistory = [];
    }

    // Determine if sandbox org (include sample card)
    let isSandbox = !isDBConnected();   // dev mode always shows sample
    let sampleEntry: Record<string, unknown> | null = null;

    if (isDBConnected() && orgId) {
      const user = await User.findById(userId).lean();
      if (!user || user.onboardingStep < 2) {
        // Show sample until onboarding is complete
        isSandbox = true;
      }
      const se = await SampleEntry.findOne({ orgId }).lean();
      if (se) {
        sampleEntry = {
          _id:       String(se._id),
          isSample:  true,
          createdAt: se.createdAt,
          ...(se.result as object),
        };
      }
    }

    if (isSandbox && !sampleEntry) {
      // Build in-memory sample when DB not available
      const { buildSampleResult } = await import('../fixtures/sampleAnalysis.js');
      sampleEntry = { isSample: true, ...buildSampleResult() };
    }

    // Only prepend the sample when the user has no real searches yet.
    // Once they have at least one real result the sample card disappears automatically.
    const history = (sampleEntry && realHistory.length === 0)
      ? [sampleEntry, ...realHistory]
      : realHistory;

    res.json({ searches: history, total: history.length });
  } catch (err) {
    next(err);
  }
});
