/**
 * Job routes
 *
 * GET /jobs/:id/stream
 *   Long-lived SSE stream (fetch + Bearer auth).
 *   - Verifies the requesting tenant owns the job.
 *   - Claims and drives the job if it is queued (or its lease expired).
 *   - Tails the Mongo doc if another worker is already running it.
 *   - Heartbeat comment every 15s keeps the connection alive through proxies.
 *   - Client disconnect does NOT abort the deep-research work; the runner
 *     keeps going and persists the result so it can be recovered on reconnect.
 *
 * GET /jobs/:id
 *   Synchronous JSON snapshot of job state + result.
 *   Used for reconnect/recovery when the SSE stream can't be re-established.
 */

import { Router } from 'express';
import { Job } from '../models/Job.js';
import { claimJob, runJob, newWorkerId } from '../services/jobRunner.js';

export const jobsRouter = Router();

const HEARTBEAT_INTERVAL_MS = 15_000;
const TAIL_POLL_MS          = 1_000;

// ── SSE stream ────────────────────────────────────────────────────────────────

jobsRouter.get('/:id/stream', async (req, res, next) => {
  const { id } = req.params;
  const { orgId } = req.tenant;

  try {
    const job = await Job.findById(id).lean();
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (orgId && job.orgId !== orgId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // ── Set SSE headers ───────────────────────────────────────────────────────
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();

    // ── Helpers ───────────────────────────────────────────────────────────────
    const writeEvent = (name: string, data: object) => {
      if (!res.writableEnded) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const endStream = () => {
      if (!res.writableEnded) res.end();
    };

    // ── Heartbeat (SSE comment — keeps proxies + load balancers alive) ────────
    const hbTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    res.on('close', () => clearInterval(hbTimer));

    // ── If already complete / error — return immediately ─────────────────────
    if (job.status === 'complete') {
      writeEvent('progress', { completed: job.progress.total, total: job.progress.total, message: 'Complete' });
      writeEvent('complete',  { result: job.result });
      clearInterval(hbTimer);
      endStream();
      return;
    }
    if (job.status === 'error') {
      writeEvent('error', { message: job.error || 'Job failed' });
      clearInterval(hbTimer);
      endStream();
      return;
    }

    // ── Try to claim the job ──────────────────────────────────────────────────
    const workerId = newWorkerId();
    const claimed  = await claimJob(id, workerId);

    if (claimed) {
      // We own execution. Run the job; emit events inline (no-op if client closed).
      // Fire-and-forget — the Promise runs to completion regardless of socket state.
      runJob(claimed, (event) => {
        writeEvent(event.type, event);
        if (event.type === 'complete' || event.type === 'error') {
          clearInterval(hbTimer);
          endStream();
        }
      }).catch((err) => {
        writeEvent('error', { message: (err as Error).message ?? 'Runner crashed' });
        clearInterval(hbTimer);
        endStream();
      });

    } else {
      // Another worker is running this job. Tail the Mongo doc.
      const pollTimer = setInterval(async () => {
        try {
          const latest = await Job.findById(id).lean();
          if (!latest) {
            clearInterval(pollTimer);
            clearInterval(hbTimer);
            writeEvent('error', { message: 'Job not found during polling' });
            endStream();
            return;
          }

          writeEvent('progress', {
            completed: latest.progress.completed,
            total:     latest.progress.total,
            message:   latest.progress.message,
          });

          if (latest.status === 'complete') {
            clearInterval(pollTimer);
            clearInterval(hbTimer);
            writeEvent('complete', { result: latest.result });
            endStream();
          } else if (latest.status === 'error') {
            clearInterval(pollTimer);
            clearInterval(hbTimer);
            writeEvent('error', { message: latest.error || 'Job failed' });
            endStream();
          }
        } catch (err) {
          // Transient DB error — keep polling
          console.error('[jobs/stream] poll error:', err);
        }
      }, TAIL_POLL_MS);

      res.on('close', () => clearInterval(pollTimer));
    }
  } catch (err) {
    next(err);
  }
});

// ── Snapshot ──────────────────────────────────────────────────────────────────

jobsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { orgId } = req.tenant;

    const job = await Job.findById(id).lean();
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (orgId && job.orgId !== orgId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    res.json({
      jobId:    String(job._id),
      type:     job.type,
      status:   job.status,
      progress: job.progress,
      result:   job.status === 'complete' ? job.result : undefined,
      error:    job.status === 'error'    ? job.error  : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});
