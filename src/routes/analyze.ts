/**
 * POST /analyze
 *
 * Proxies to deep-research: POST /material/tax-rate/parallel/fast
 *
 * Stamps org_id + user_id, always sets bypass_cache=true and async_mode=false
 * to mirror the proven infis-client call pattern.
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const analyzeRouter = Router();

analyzeRouter.post('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;

    // Merge tenant IDs into body; honour aliases the frontend may send
    const body = {
      ...req.body,
      org_id:  orgId,
      user_id: userId,
      async_mode: false,
      // Normalise field aliases — deep-research accepts both names
      hts_code:       req.body.hts_code       ?? req.body.htscode ?? req.body.htsCode,
      origin_country: req.body.origin_country ?? req.body.originCountry,
    };

    const { data } = await drClient.post(
      '/material/tax-rate/parallel/fast',
      body,
      {
        params: { bypass_cache: true },
      },
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
});
