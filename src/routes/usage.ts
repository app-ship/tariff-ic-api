/**
 * GET /usage
 *
 * Returns the current org's monthly analysis usage + plan, used by the frontend
 * to render the sidebar meter, inline paywall, and proactive upgrade banner.
 */

import { Router } from 'express';
import { getUsage } from '../services/usage.js';

export const usageRouter = Router();

usageRouter.get('/', async (req, res, next) => {
  try {
    const usage = await getUsage(req.tenant.orgId);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});
