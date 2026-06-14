/**
 * Recommend routes — persistent, actionable portfolio recommendations.
 *
 *   POST  /recommend/sync   → upsert client-computed derived recs (preserve status)
 *   GET   /recommend        → list recs for the org (filter by ?status=)
 *   PATCH /recommend/:id     → accept / snooze / dismiss a recommendation
 *
 * Recommendations live in the same `portfolio_insights` collection as the
 * monitor-fired alerts. Derived recs (source === 'derived') are deduped by
 * `recKey`; their generation happens on the client (reusing the trusted tariff
 * parsers) — this router only persists, merges status, and lists them.
 *
 * All endpoints require a valid bearer token (enforced by the global
 * authMiddleware before this router is mounted).
 */

import { Router } from 'express';
import { PortfolioInsight, type InsightStatus } from '../models/PortfolioInsight.js';
import { isDBConnected } from '../db.js';

export const recommendRouter = Router();

interface IncomingRec {
  recKey:        string;
  kind:          string;
  searchId?:     string;
  htsCode?:      string;
  materialName?: string;
  country?:      string;
  title?:        string;
  recommendedAction?: string;
  potentialSavings?:  number;
  confidence?:   number;
  timeline?:     string;
  complexity?:   string;
  severity?:     'high' | 'medium' | 'low';
}

const ALLOWED_KINDS = new Set([
  'sourcing_shift', 'exclusion_301', 'ieepa_mitigation', 'binding_ruling', 'fta_optimization',
]);

// ── Sync derived recommendations ─────────────────────────────────────────────
// Upsert each by { orgId, recKey }. New recs are inserted as 'open'; existing
// recs keep their user-set status (accepted/snoozed/dismissed) so re-syncing
// never resurfaces something the user already actioned. Auto-reopens a snoozed
// rec once its snoozedUntil has passed.
recommendRouter.post('/sync', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;

    if (!isDBConnected()) {
      return res.json({ recommendations: [] });
    }

    const incoming: IncomingRec[] = Array.isArray(req.body?.recommendations)
      ? req.body.recommendations
      : [];

    const now = new Date();
    const validKeys: string[] = [];

    for (const rec of incoming) {
      if (!rec?.recKey || !ALLOWED_KINDS.has(rec.kind)) continue;
      validKeys.push(rec.recKey);

      const existing = await PortfolioInsight.findOne({ orgId, recKey: rec.recKey }).lean();

      // Reopen a snoozed rec whose snooze window has elapsed
      let statusUpdate: Partial<{ status: InsightStatus; snoozedUntil: Date | undefined }> = {};
      if (existing?.status === 'snoozed' && existing.snoozedUntil && new Date(existing.snoozedUntil) <= now) {
        statusUpdate = { status: 'open', snoozedUntil: undefined };
      }

      await PortfolioInsight.updateOne(
        { orgId, recKey: rec.recKey },
        {
          // Refresh the computed economics on every sync
          $set: {
            orgId,
            userId,
            source:       'derived',
            recKey:       rec.recKey,
            kind:         rec.kind,
            searchId:     rec.searchId,
            htsCode:      rec.htsCode ?? '',
            materialName: rec.materialName ?? '',
            country:      rec.country ?? '',
            title:        rec.title,
            recommendedAction: rec.recommendedAction ?? rec.title ?? '',
            potentialSavings:  rec.potentialSavings ?? 0,
            confidence:   rec.confidence,
            timeline:     rec.timeline,
            complexity:   rec.complexity,
            severity:     rec.severity ?? 'medium',
            ...statusUpdate,
          },
          // Only set on insert so we never clobber a user-actioned status
          $setOnInsert: {
            status:        'open',
            previousRate:  null,
            newRate:       null,
            rateDelta:     0,
            exposureDelta: 0,
          },
        },
        { upsert: true },
      );
    }

    // Return the authoritative merged list (derived + monitor), excluding
    // dismissed. Stale derived recs no longer produced by the client are kept
    // (they expire via TTL) but won't be re-synced.
    const recommendations = await PortfolioInsight
      .find({ orgId, status: { $ne: 'dismissed' } })
      .sort({ createdAt: -1 })
      .lean();

    void validKeys;
    res.json({ recommendations });
  } catch (err) {
    next(err);
  }
});

// ── List recommendations ─────────────────────────────────────────────────────
recommendRouter.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;

    if (!isDBConnected()) {
      return res.json({ recommendations: [] });
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const filter: Record<string, unknown> = { orgId };
    if (status) filter.status = status;
    else filter.status = { $ne: 'dismissed' };

    const recommendations = await PortfolioInsight
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ recommendations });
  } catch (err) {
    next(err);
  }
});

// ── Accept / snooze / dismiss ────────────────────────────────────────────────
recommendRouter.patch('/:id', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    const { id }    = req.params;

    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const requested = req.body?.status as InsightStatus | undefined;
    const allowed: InsightStatus[] = ['open', 'accepted', 'snoozed', 'dismissed', 'resolved'];
    if (!requested || !allowed.includes(requested)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const update: Record<string, unknown> = { status: requested };
    if (requested === 'accepted') update.acceptedAt = new Date();
    if (requested === 'snoozed') {
      const days = Number(req.body?.snoozeDays) > 0 ? Number(req.body.snoozeDays) : 14;
      update.snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    } else {
      update.snoozedUntil = undefined;
    }

    const result = await PortfolioInsight.findOneAndUpdate(
      { _id: id, orgId },
      { $set: update },
      { new: true },
    ).lean();

    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
