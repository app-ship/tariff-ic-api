/**
 * POST /intel
 *
 * Quick, material-agnostic high-level understanding of ANY material or product.
 * Proxies to deep-research POST /material/quick-intel (small/fast LLM).
 *
 * The response includes `is_chemical` so the frontend knows whether to run the
 * deeper chemistry (PubChem) resolution step.
 *
 * Body: { query: string, material_name?: string }
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';

export const intelRouter = Router();

intelRouter.post('/', async (req, res, next) => {
  try {
    const { query, material_name } = req.body as { query?: string; material_name?: string };
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: '"query" is required' });
      return;
    }

    const { data } = await drClient.post(
      '/material/quick-intel',
      { query: query.trim(), material_name },
      { timeout: 30_000 }, // quick call — fail fast
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
});
