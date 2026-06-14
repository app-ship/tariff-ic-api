/**
 * Monitor cron route — invoked by Cloud Scheduler (every 6 hours).
 *
 * Mounted at /monitor/cron BEFORE the global authMiddleware, so it does NOT use
 * an Auth0 bearer token. Instead it is guarded by a shared secret passed in the
 * `X-CRON-SECRET` header (set CRON_SECRET in the environment).
 *
 * Each invocation processes all monitors whose nextCheckAt is due, honoring each
 * monitor's per-material daily/weekly cadence.
 */

import { Router } from 'express';
import { isDBConnected } from '../db.js';
import { runDueMonitors } from '../services/monitorChecker.js';

export const monitorCronRouter = Router();

monitorCronRouter.post('/run', async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET ?? '';
    const provided = req.header('X-CRON-SECRET') ?? '';

    // If a secret is configured, require it. (In dev with no secret set, allow.)
    if (secret && provided !== secret) {
      return res.status(401).json({ error: 'Invalid cron secret' });
    }

    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const summary = await runDueMonitors(limit);

    res.json({
      ok: true,
      processed: summary.processed,
      changed: summary.changed,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
