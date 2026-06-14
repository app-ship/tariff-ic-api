/**
 * POST /resolve
 *
 * Resolves a CAS number or material name via PubChem's public REST API.
 * Handled directly in tariff-ic-api — no deep-research dependency.
 * Body: { query: string, material_name?: string }
 */

import { Router } from 'express';
import { resolveMaterial } from '../services/pubchemService.js';

export const resolveRouter = Router();

resolveRouter.post('/', async (req, res, next) => {
  try {
    const { query, material_name } = req.body as { query?: string; material_name?: string };
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '"query" is required' });
      return;
    }
    const result = await resolveMaterial({ query, material_name });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
