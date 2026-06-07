/**
 * POST /classify
 *
 * Proxies to deep-research: POST /material/classification/parallel/fast
 *
 * Stamps org_id + user_id from the authenticated tenant.
 * Accepts the full ClassifyPayload from the tariffy-ai frontend.
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const classifyRouter = Router();

classifyRouter.post('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;

    const { data } = await drClient.post(
      '/material/classification/parallel/fast',
      req.body,
      {
        params: {
          org_id:  orgId,
          user_id: userId,
        },
      },
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
});
