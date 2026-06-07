/**
 * GET /validate-cas/:cas
 *
 * Proxies to deep-research: GET /material/validate-cas/:cas
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const validateCasRouter = Router();

validateCasRouter.get('/:cas', async (req, res, next) => {
  try {
    const { data } = await drClient.get(`/material/validate-cas/${req.params.cas}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});
