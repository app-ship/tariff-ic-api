/**
 * GET /searches       — paginated list of material searches for the tenant org
 * GET /searches/:id   — full detail for a single search
 *
 * Both endpoints require a valid bearer token (enforced by the global authMiddleware
 * in index.ts before this router is mounted).
 */

import { Router } from 'express';
import { MaterialSearch } from '../models/MaterialSearch.js';
import { isDBConnected } from '../db.js';

export const searchesRouter = Router();

// ── List ──────────────────────────────────────────────────────────────────────
searchesRouter.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    const limit  = Math.min(Math.max(Number(req.query.limit)  || 20, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (!isDBConnected()) {
      return res.json({ items: [], total: 0, limit, offset });
    }

    const [items, total] = await Promise.all([
      MaterialSearch
        .find({ orgId })
        .select('_id materialName casNumber htsCode confidence status countries createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      MaterialSearch.countDocuments({ orgId }),
    ]);

    res.json({ items, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
searchesRouter.get('/:id', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    const { id }    = req.params;

    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const doc = await MaterialSearch.findOne({ _id: id, orgId }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    res.json(doc);
  } catch (err) {
    next(err);
  }
});
