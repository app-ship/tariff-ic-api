/**
 * POST /classify
 *
 * Creates a classify Job in Mongo and returns 202 { jobId }.
 * The actual deep-research call is driven by GET /jobs/:id/stream.
 *
 * Accepts the full ClassifyPayload from the tariffy-ai frontend.
 */

import { Router } from 'express';
import { Job } from '../models/Job.js';
import { onClassifyStart } from '../services/analysisLifecycle.js';
import { startJobExecution } from '../services/jobRunner.js';

export const classifyRouter = Router();

classifyRouter.post('/', async (req, res, next) => {
  try {
    const { orgId, userId } = req.tenant;

    const job = await Job.create({
      type:   'classify',
      orgId:  orgId  || 'dev',
      userId: userId || 'dev',
      // Store tenant IDs alongside the payload so the runner can inject them
      request: { ...req.body, orgId, userId },
    });

    // Record the in-progress search + raise a 'running' notification before we
    // respond, so the job is immediately recoverable from History / the inbox.
    await onClassifyStart(job);

    res.status(202).json({ jobId: String(job._id) });

    // Drive execution server-side so it completes even if the user leaves.
    void startJobExecution(String(job._id));
  } catch (err) {
    next(err);
  }
});
