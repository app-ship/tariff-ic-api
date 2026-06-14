/**
 * Assess routes — portfolio-level risk data for the Assess feature.
 *
 *   GET   /assess/portfolio      → org material searches + active monitors + open insights
 *   PATCH /assess/insights/:id   → dismiss a portfolio insight
 *
 * All endpoints require a valid bearer token (enforced by the global
 * authMiddleware before this router is mounted). Rate aggregation is done on
 * the client, reusing the trusted tariff parsers; this endpoint only ships the
 * raw projection needed.
 */

import { Router } from 'express';
import { MaterialSearch } from '../models/MaterialSearch.js';
import { TariffMonitor } from '../models/TariffMonitor.js';
import { PortfolioInsight } from '../models/PortfolioInsight.js';
import { drClient } from '../deepResearchClient.js';
import { isDBConnected } from '../db.js';

export const assessRouter = Router();

const MAX_SEARCHES = 300;

// ── Portfolio snapshot ──────────────────────────────────────────────────────
assessRouter.get('/portfolio', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;

    if (!isDBConnected()) {
      return res.json({ items: [], monitors: [], insights: [], total: 0 });
    }

    const [rawItems, total, monitors, insights] = await Promise.all([
      MaterialSearch
        .find({ orgId })
        .select('_id materialName casNumber htsCode confidence status countries origin destination annualSpend shipmentValue createdAt updatedAt analyzeResult')
        .sort({ createdAt: -1 })
        .limit(MAX_SEARCHES)
        .lean(),
      MaterialSearch.countDocuments({ orgId }),
      TariffMonitor
        .find({ orgId, status: 'active' })
        .select('_id htsCode countries sourceSearchId baseline lastCheckedAt')
        .lean(),
      PortfolioInsight
        .find({ orgId, status: 'open' })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    // Trim payload: only analyzed rows carry the (large) raw analyzeResult blob.
    const items = rawItems.map((it) => {
      if (it.status !== 'analyzed') {
        const { analyzeResult, ...rest } = it as unknown as Record<string, unknown>;
        void analyzeResult;
        return rest;
      }
      return it;
    });

    res.json({ items, monitors, insights, total });
  } catch (err) {
    next(err);
  }
});

// ── Simulate a reclassification rate ─────────────────────────────────────────
// Thin proxy to deep-research used only by the Simulate page's "reclassify to
// HTS X" lever. Returns the raw rate blob so the client parses it with the same
// trusted tariff parsers (no rate math duplicated server-side).
assessRouter.post('/simulate/rate', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const htsCode = String(req.body?.htsCode ?? '').trim();
    const country = String(req.body?.country ?? '').trim();

    if (!htsCode || !country) {
      return res.status(400).json({ error: 'htsCode and country are required' });
    }

    const { data } = await drClient.post(
      '/material/tax-rate/parallel/fast',
      {
        htscode:        htsCode,
        material_name:  String(req.body?.materialName ?? ''),
        import_country: country,
        annual_spend:   String(req.body?.annualSpend ?? '0'),
        org_id:         orgId,
        user_id:        userId,
        async_mode:     false,
      },
      { params: { rates_only: true }, timeout: 300_000 },
    );

    res.json({ country, data });
  } catch (err) {
    next(err);
  }
});

// ── Dismiss an insight ──────────────────────────────────────────────────────
assessRouter.patch('/insights/:id', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    const { id }    = req.params;

    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const status = req.body?.status === 'resolved' ? 'resolved' : 'dismissed';

    const result = await PortfolioInsight.findOneAndUpdate(
      { _id: id, orgId },
      { $set: { status } },
      { new: true },
    ).lean();

    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
