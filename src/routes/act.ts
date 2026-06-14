/**
 * Act routes — living, grounded action plans.
 *
 *   POST  /act/from-recommendation  → generate (idempotent) a plan from a rec
 *   GET   /act                       → list plans for the org (pipeline)
 *   GET   /act/:id                   → single plan
 *   PATCH /act/:id                   → case fields (status/owner/dueDate/realized)
 *   PUT   /act/:id/blocks            → persist living-document block edits
 *
 * Generation is the only place that touches deep-research: it hydrates the
 * deterministic template (actionTemplates.ts) with the real stored analysis and
 * slots in prose drafted by /material/action-plan. All endpoints require a valid
 * bearer token (global authMiddleware).
 */

import { Router } from 'express';
import { ActionPlan, type ActionPlanStatus, type Block } from '../models/ActionPlan.js';
import { PortfolioInsight } from '../models/PortfolioInsight.js';
import { MaterialSearch } from '../models/MaterialSearch.js';
import { drClient } from '../deepResearchClient.js';
import { extractGrounding, extractAnalysisSlices, buildActionPlanBlocks, type DraftSections } from '../services/actionTemplates.js';
import { isDBConnected } from '../db.js';

export const actRouter = Router();

// ── Generate a plan from an accepted recommendation ──────────────────────────
actRouter.post('/from-recommendation', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const insightId = String(req.body?.insightId ?? '').trim();

    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });
    if (!insightId) return res.status(400).json({ error: 'insightId is required' });

    const rec = await PortfolioInsight.findOne({ _id: insightId, orgId }).lean();
    if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

    // Idempotent: reuse an existing plan for this recommendation
    const existing = await ActionPlan.findOne({ orgId, insightId }).lean();
    if (existing) {
      await PortfolioInsight.updateOne({ _id: insightId, orgId }, { $set: { status: 'accepted', acceptedAt: new Date() } });
      return res.json(existing);
    }

    const search = rec.searchId
      ? await MaterialSearch.findOne({ _id: rec.searchId, orgId }).lean()
      : null;

    const kind = rec.kind;
    // For sourcing shifts the rec.country is the TARGET origin; current origin
    // comes from the analyzed material.
    const currentOrigin = (search?.origin || (kind === 'sourcing_shift' ? '' : rec.country) || rec.country || '').trim();
    const bestCountry = kind === 'sourcing_shift' ? rec.country : undefined;
    const annualSpend = search?.annualSpend ?? rec.annualSpend;
    const potentialSavings = rec.potentialSavings ?? rec.exposureDelta;

    const grounding = extractGrounding({
      materialName: rec.materialName,
      htsCode: rec.htsCode || search?.htsCode || '',
      country: currentOrigin,
      bestCountry,
      annualSpend,
      potentialSavings,
      classifyResult: search?.classifyResult,
      analyzeResult: search?.analyzeResult,
    });

    // Draft prose via deep-research (best-effort: never block plan creation on it)
    let draft: DraftSections = {};
    try {
      const slices = extractAnalysisSlices({
        country: currentOrigin,
        classifyResult: search?.classifyResult,
        analyzeResult: search?.analyzeResult,
      });
      const { data } = await drClient.post(
        '/material/action-plan',
        {
          recommendation_kind: kind,
          material_name: rec.materialName,
          hts_code: grounding.htsCode,
          import_country: currentOrigin,
          best_country: bestCountry,
          annual_spend: annualSpend != null ? String(annualSpend) : undefined,
          potential_savings: potentialSavings != null ? String(potentialSavings) : undefined,
          tariff_analysis: slices.tariff_analysis,
          classification_analysis: slices.classification_analysis,
        },
        { timeout: 60_000 },
      );
      draft = (data?.sections ?? {}) as DraftSections;
    } catch (err) {
      console.error('[act] action-plan drafting failed, using template-only:', (err as Error).message);
    }

    const blocks = buildActionPlanBlocks(kind, grounding, draft);

    const plan = await ActionPlan.create({
      orgId,
      userId,
      insightId,
      recKey: rec.recKey,
      searchId: rec.searchId,
      kind,
      title: rec.title || rec.materialName,
      materialName: rec.materialName,
      htsCode: grounding.htsCode,
      country: currentOrigin,
      status: 'not_started',
      projectedSavings: typeof potentialSavings === 'number' ? potentialSavings : undefined,
      blocks,
      generatedModel: draft ? 'gpt-4o-mini' : undefined,
    });

    await PortfolioInsight.updateOne({ _id: insightId, orgId }, { $set: { status: 'accepted', acceptedAt: new Date() } });

    res.status(201).json(plan.toObject());
  } catch (err) {
    next(err);
  }
});

// ── List plans ───────────────────────────────────────────────────────────────
actRouter.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    if (!isDBConnected()) return res.json({ plans: [] });

    const plans = await ActionPlan
      .find({ orgId })
      .select('-blocks')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ plans });
  } catch (err) {
    next(err);
  }
});

// ── Single plan ────────────────────────────────────────────────────────────────
actRouter.get('/:id', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });

    const plan = await ActionPlan.findOne({ _id: req.params.id, orgId }).lean();
    if (!plan) return res.status(404).json({ error: 'Not found' });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

// ── Update case fields ─────────────────────────────────────────────────────────
actRouter.patch('/:id', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });

    const allowedStatus: ActionPlanStatus[] = ['not_started', 'in_progress', 'blocked', 'completed', 'abandoned'];
    const update: Record<string, unknown> = {};
    if (req.body?.status && allowedStatus.includes(req.body.status)) update.status = req.body.status;
    if (typeof req.body?.owner === 'string') update.owner = req.body.owner;
    if (req.body?.dueDate !== undefined) update.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : undefined;
    if (req.body?.projectedSavings !== undefined) update.projectedSavings = Number(req.body.projectedSavings);
    if (req.body?.realizedSavings !== undefined) update.realizedSavings = Number(req.body.realizedSavings);

    if (!Object.keys(update).length) return res.status(400).json({ error: 'No valid fields to update' });

    const plan = await ActionPlan.findOneAndUpdate(
      { _id: req.params.id, orgId },
      { $set: update },
      { new: true },
    ).lean();

    if (!plan) return res.status(404).json({ error: 'Not found' });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

// ── Persist living-document block edits ──────────────────────────────────────
actRouter.put('/:id/blocks', async (req, res, next) => {
  try {
    const { orgId } = req.tenant;
    if (!isDBConnected()) return res.status(503).json({ error: 'Database unavailable' });

    const blocks = req.body?.blocks;
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'blocks must be an array' });

    const plan = await ActionPlan.findOneAndUpdate(
      { _id: req.params.id, orgId },
      { $set: { blocks: blocks as Block[] } },
      { new: true },
    ).lean();

    if (!plan) return res.status(404).json({ error: 'Not found' });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});
