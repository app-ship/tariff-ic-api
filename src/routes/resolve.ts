/**
 * POST /resolve
 *
 * Resolves a CAS number or material name to a normalized chemical record.
 *
 * Resolution strategy (in order):
 *   1. deep-research /material/resolve — Python service with built-in caching,
 *      token-bucket rate limiting, and aiohttp (avoids GCP IP blocks on PubChem).
 *   2. Direct PubChem via pubchemService (fallback when deep-research is down).
 *
 * Always returns HTTP 200 — network failures are surfaced as { resolved: false }
 * so the frontend can show a graceful "lookup unavailable" message rather than
 * treating the whole form as broken.
 */

import { Router } from 'express';
import { drClient } from '../deepResearchClient.js';
import { resolveMaterial } from '../services/pubchemService.js';

export const resolveRouter = Router();

resolveRouter.post('/', async (req, res) => {
  const { query, material_name } = req.body as { query?: string; material_name?: string };
  if (!query || typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: '"query" is required' });
    return;
  }

  const start = Date.now();

  // ── 1. Try deep-research (primary) ───────────────────────────────────────────
  try {
    const { data } = await drClient.post(
      '/material/resolve',
      { query: query.trim(), material_name },
      { timeout: 25_000 },
    );
    res.json(data);
    return;
  } catch (drErr: unknown) {
    // Log so we can track how often deep-research is unavailable
    const status = (drErr as any)?.response?.status;
    console.warn(
      `[resolve] deep-research unavailable (${status ?? 'network error'}), trying direct PubChem`,
    );
  }

  // ── 2. Fall back to direct PubChem ────────────────────────────────────────────
  try {
    const result = await resolveMaterial({ query, material_name });
    res.json(result);
    return;
  } catch (pubchemErr: unknown) {
    const status = (pubchemErr as any)?.response?.status;
    console.error(`[resolve] direct PubChem also failed (${status ?? 'unknown'})`);
  }

  // ── 3. Both paths failed — return graceful not-resolved response ─────────────
  const ms = Date.now() - start;
  const queryType = /^\d{2,7}-\d{2}-\d$/.test(query.trim()) ? 'cas' : 'name';
  res.json({
    query:              query.trim(),
    query_type:         queryType,
    resolved:           false,
    source:             'none',
    cas_numbers:        [],
    synonyms:           [],
    confidence_score:   0,
    confidence_reason:  'Chemical lookup service temporarily unavailable',
    resolution_time_ms: ms,
    resolved_at:        new Date().toISOString(),
    error:              'Chemical lookup service temporarily unavailable',
  });
});
