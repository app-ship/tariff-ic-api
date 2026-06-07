/**
 * GET /history
 *
 * Proxies to deep-research: GET /material/tariff/searches
 *
 * Returns the tariff analysis history for the authenticated tenant.
 * Query params forwarded: limit, sort_by, sort_order
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const historyRouter = Router();

historyRouter.get('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const { limit = 20, sort_by = 'updatedAt', sort_order = -1 } = req.query;

    const { data } = await drClient.get('/material/tariff/searches', {
      params: {
        org_id:       orgId,
        user_id:      userId,
        limit,
        sort_by,
        sort_order,
        search_type:  'tax_rate_calculation',
      },
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});
