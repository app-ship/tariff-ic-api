/**
 * POST /analyze
 *
 * Creates a single analyze Job for the full multi-country batch and returns
 * 202 { jobId }. The fan-out over countries is handled server-side by the
 * job runner — the browser no longer fires N parallel requests.
 *
 * Expected body (from tariffy-ai analyzeCountries):
 *   {
 *     htscode:     string,          // HTS code
 *     countries:   string[],        // all origin countries in this batch
 *     annual_spend:string,
 *     material_name?, cas_number?,
 *     additional_details?,
 *     total_shipment_value?,
 *     entry_date?, date_of_loading?,
 *     manufacturer_name?, product_status?, item_type?,
 *     material_product_details_images?: string[],
 *     additional_details_images?: string[],
 *     batch_id?,
 *   }
 */

import { Router } from 'express';
import { Job } from '../models/Job.js';
import { onAnalyzeStart } from '../services/analysisLifecycle.js';
import { startJobExecution } from '../services/jobRunner.js';
import { checkCanRun } from '../services/usage.js';

export const analyzeRouter = Router();

analyzeRouter.post('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;
    const countries = req.body.countries as string[] | undefined;

    if (!Array.isArray(countries) || countries.length === 0) {
      res.status(400).json({ error: '"countries" must be a non-empty array' });
      return;
    }

    // ── Free-tier usage gate (covers the direct-HTS path that skips classify) ─
    const exceeded = await checkCanRun(orgId);
    if (exceeded) {
      res.status(402).json({
        error: 'usage_limit_reached',
        used:  exceeded.used,
        limit: exceeded.limit,
        plan:  exceeded.plan,
      });
      return;
    }

    // Normalise HTS aliases so the runner always sees htscode + hts_code
    const request = {
      ...req.body,
      htscode:        req.body.htscode        ?? req.body.hts_code ?? req.body.htsCode,
      hts_code:       req.body.hts_code       ?? req.body.htscode  ?? req.body.htsCode,
      origin_country: req.body.origin_country ?? req.body.originCountry,
      orgId,
      userId,
    };

    const job = await Job.create({
      type:    'analyze',
      orgId:   orgId  || 'dev',
      userId:  userId || 'dev',
      request,
      progress: { total: countries.length, completed: 0, message: 'Queued' },
    });

    // Attach/record the in-progress search + raise a 'running' notification
    // before responding so the job is recoverable from History / the inbox.
    await onAnalyzeStart(job);

    res.status(202).json({ jobId: String(job._id) });

    // Drive execution server-side so it completes even if the user leaves.
    void startJobExecution(String(job._id));
  } catch (err) {
    next(err);
  }
});
