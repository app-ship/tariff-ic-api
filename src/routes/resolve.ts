/**
 * POST /resolve
 *
 * Proxies to deep-research: POST /material/resolve
 *
 * Resolves a CAS number or material name via PubChem.
 * Body: { query: string, material_name?: string }
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const resolveRouter = Router();

resolveRouter.post('/', async (req, res, next) => {
  try {
    const { data } = await drClient.post('/material/resolve', req.body);
    res.json(data);
  } catch (err) {
    next(err);
  }
});
