/**
 * Job runner — drives deep-research work for classify and analyze jobs.
 *
 * Design principles:
 *  - All state lives in Mongo; the runner is safe to run on any Cloud Run instance.
 *  - The runner is fire-and-forget from the SSE route: the deep-research work is NOT
 *    cancelled when the client socket closes. The result is always persisted.
 *  - Atomic leases prevent duplicate execution across concurrent stream requests.
 *  - Per-country error isolation: one failing country doesn't abort the batch.
 *  - Concurrency cap of 4 per analyze job avoids overwhelming deep-research.
 */

import { randomUUID } from 'crypto';
import { Job, type IJob } from '../models/Job.js';
import { drClient } from '../deepResearchClient.js';
import {
  onClassifyComplete, onAnalyzeComplete, onJobError,
} from './analysisLifecycle.js';

export type ProgressEvent = { type: 'progress'; completed: number; total: number; message: string };
export type CompleteEvent = { type: 'complete'; result: unknown };
export type ErrorEvent    = { type: 'error';    message: string };
export type JobEvent      = ProgressEvent | CompleteEvent | ErrorEvent;
export type EmitFn        = (event: JobEvent) => void;

const LEASE_TTL_MS     = 90_000;  // 90s — renewed by heartbeat every 30s
const HEARTBEAT_MS     = 30_000;
const ANALYZE_CONCURRENCY = 4;

// ── Lease management ─────────────────────────────────────────────────────────

/**
 * Atomically claim a job for this worker.
 * Claims if: status=queued, OR status=running but the lease has expired (crash recovery).
 * Returns the claimed job doc, or null if another worker holds a valid lease.
 */
export async function claimJob(jobId: string, workerId: string): Promise<IJob | null> {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      _id: jobId,
      $or: [
        { status: 'queued' },
        { status: 'running', 'lease.expiresAt': { $lte: now } },
      ],
    },
    {
      $set: {
        status:            'running',
        'lease.workerId':  workerId,
        'lease.expiresAt': new Date(Date.now() + LEASE_TTL_MS),
      },
    },
    { new: true },
  );
}

/** Extend the lease so long-running jobs aren't reclaimed mid-flight. */
function startLeaseHeartbeat(jobId: string, workerId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await Job.updateOne(
        { _id: jobId, 'lease.workerId': workerId },
        { $set: { 'lease.expiresAt': new Date(Date.now() + LEASE_TTL_MS) } },
      );
    } catch {
      // Non-fatal — lease will expire naturally and crash recovery takes over
    }
  }, HEARTBEAT_MS);
}

// ── Classify runner ───────────────────────────────────────────────────────────

export async function runClassify(job: IJob, emit: EmitFn): Promise<void> {
  const hb = startLeaseHeartbeat(String(job._id), randomUUID());
  try {
    await Job.updateOne({ _id: job._id }, {
      $set: { 'progress.total': 1, 'progress.message': 'Running HTS classification…' },
    });
    emit({ type: 'progress', completed: 0, total: 1, message: 'Running HTS classification…' });

    const { orgId, userId, bypass_cache, ...payload } = job.request as {
      orgId: string; userId: string; bypass_cache?: boolean; [k: string]: unknown
    };

    const { data } = await drClient.post(
      '/material/classification/parallel/fast',
      payload,
      {
        params: {
          org_id: orgId,
          user_id: userId,
          ...(bypass_cache && { bypass_cache: true }),
        },
        timeout: 300_000,
      },
    );

    await Job.findByIdAndUpdate(job._id, {
      $set: {
        status:             'complete',
        result:             data,
        'progress.completed': 1,
        'progress.message': 'Classification complete',
      },
    });
    emit({ type: 'progress', completed: 1, total: 1, message: 'Classification complete' });
    emit({ type: 'complete', result: data });

    // Persist search record — fire-and-forget, never crash the job
    let htsCode = '';
    try {
      const { MaterialSearch } = await import('../models/MaterialSearch.js');
      const d = data as Record<string, unknown>;
      const fc = (d.final_classification ?? {}) as Record<string, unknown>;
      htsCode = String(fc.primary_hts_code ?? d.primary_hts_code ?? d.hts_code ?? '').trim();
      await MaterialSearch.findOneAndUpdate(
        { classifyJobId: String(job._id) },
        {
          $setOnInsert: {
            orgId:         String(orgId ?? ''),
            userId:        String(userId ?? ''),
            materialName:  String((job.request as Record<string, unknown>).material_name ?? (job.request as Record<string, unknown>).cas_number ?? 'Unknown'),
            casNumber:     (job.request as Record<string, unknown>).cas_number ? String((job.request as Record<string, unknown>).cas_number) : undefined,
            classifyJobId: String(job._id),
          },
          $set: {
            htsCode:        htsCode || undefined,
            confidence:     String(fc.confidence ?? d.confidence_level ?? d.confidence ?? '').trim() || undefined,
            status:         'classified' as const,
            classifyResult: d,
          },
        },
        { upsert: true, new: true },
      );
    } catch (saveErr) {
      console.error('[jobRunner] Failed to save MaterialSearch (classify):', saveErr);
    }

    // Increment durable classifyCount on the user — fire-and-forget
    if (userId) {
      try {
        const { User } = await import('../models/User.js');
        await User.updateOne({ _id: userId }, { $inc: { classifyCount: 1 } });
      } catch { /* non-fatal */ }
    }

    // In-app completion notification
    await onClassifyComplete(job, htsCode);
  } catch (err) {
    const message = (err as Error).message ?? 'Classification failed';
    await Job.findByIdAndUpdate(job._id, {
      $set: { status: 'error', error: message },
    });
    // Mark the in-progress history row as errored so it doesn't hang as 'pending'
    try {
      const { MaterialSearch } = await import('../models/MaterialSearch.js');
      await MaterialSearch.updateOne(
        { classifyJobId: String(job._id), status: 'pending' },
        { $set: { status: 'error' } },
      );
    } catch { /* non-fatal */ }
    await onJobError(job, message);
    emit({ type: 'error', message });
  } finally {
    clearInterval(hb);
  }
}

// ── Analyze runner ────────────────────────────────────────────────────────────

interface AnalyzeRequest {
  orgId:    string;
  userId:   string;
  htscode:  string;
  countries: string[];
  annual_spend: string;
  [k: string]: unknown;
}

type PartialRow = { country: string; data?: unknown; error?: string };

export async function runAnalyze(job: IJob, emit: EmitFn): Promise<void> {
  const hb = startLeaseHeartbeat(String(job._id), randomUUID());
  const req = job.request as AnalyzeRequest;
  const { orgId, userId, countries, ...shared } = req;
  const total = countries.length;

  try {
    await Job.updateOne({ _id: job._id }, {
      $set: {
        'progress.total':   total,
        'progress.message': `Analyzing ${total} ${total === 1 ? 'country' : 'countries'}…`,
      },
    });
    emit({ type: 'progress', completed: 0, total, message: `Analyzing ${total} countries…` });

    const results: PartialRow[] = new Array(total);
    let completedCount = 0;

    // Simple semaphore — no external dep needed
    let active = 0;
    let idx = 0;

    await new Promise<void>((resolve, reject) => {
      const next = () => {
        if (idx >= total && active === 0) { resolve(); return; }

        while (active < ANALYZE_CONCURRENCY && idx < total) {
          const i   = idx++;
          const country = countries[i];
          active++;

          const body = {
            ...shared,
            htscode:        (shared.htscode as string) || (shared.hts_code as string),
            import_country: country,   // deep-research requires `import_country`, not origin_country
            org_id:         orgId,
            user_id:        userId,
            async_mode:     false,
          };

          drClient.post('/material/tax-rate/parallel/fast', body, {
            params:  { bypass_cache: true },
            timeout: 300_000,
          })
            .then(({ data }) => {
              results[i] = { country, data };
            })
            .catch((err) => {
              results[i] = { country, error: (err as Error).message ?? 'Analysis failed' };
            })
            .finally(async () => {
              active--;
              completedCount++;
              const partial = results[i];
              const msg = `Analyzed ${completedCount}/${total} countries`;

              try {
                await Job.updateOne({ _id: job._id }, {
                  $push: { partials: partial },
                  $set: {
                    'progress.completed': completedCount,
                    'progress.message':   msg,
                  },
                });
              } catch {
                // Non-fatal — progress update failed, job will still complete
              }

              emit({ type: 'progress', completed: completedCount, total, message: msg });

              if (idx >= total && active === 0) resolve();
              else { try { next(); } catch (e) { reject(e); } }
            });
        }
      };

      try { next(); } catch (e) { reject(e); }
    });

    // All countries done — store final result
    const finalResult = results.filter(Boolean);
    await Job.findByIdAndUpdate(job._id, {
      $set: {
        status:               'complete',
        result:               finalResult,
        'progress.completed': total,
        'progress.message':   'Analysis complete',
      },
    });
    emit({ type: 'progress', completed: total, total, message: 'Analysis complete' });
    emit({ type: 'complete', result: finalResult });

    // Only mark 'analyzed' when at least one country returned real data.
    // If every country errored, fall back to 'classified' so the history
    // list/detail stay honest and the broken tariff view stays hidden.
    const successCount = finalResult.filter((r) => !(r as PartialRow).error && (r as PartialRow).data).length;
    const hasSuccess = successCount > 0;

    // Persist analyze data onto the row claimed at analyze-start (keyed by analyzeJobId).
    try {
      const { MaterialSearch } = await import('../models/MaterialSearch.js');
      const annualSpendNum = Number(String(req.annual_spend ?? '').replace(/[^0-9.]/g, ''));

      await MaterialSearch.updateOne(
        { analyzeJobId: String(job._id) },
        {
          $set: {
            analyzeResult: finalResult,
            countries,
            ...(Number.isFinite(annualSpendNum) && annualSpendNum > 0 ? { annualSpend: annualSpendNum } : {}),
            ...(req.total_shipment_value != null ? { shipmentValue: Number(req.total_shipment_value) } : {}),
            ...(req.origin ? { origin: String(req.origin) } : {}),
            ...(req.destination ? { destination: String(req.destination) } : {}),
            status: hasSuccess ? ('analyzed' as const) : ('classified' as const),
          },
        },
      );
    } catch (saveErr) {
      console.error('[jobRunner] Failed to save MaterialSearch (analyze):', saveErr);
    }

    // Increment durable analyzeCount on the user (only when at least one country succeeded)
    if (hasSuccess && userId) {
      try {
        const { User } = await import('../models/User.js');
        await User.updateOne({ _id: userId }, { $inc: { analyzeCount: 1 } });
      } catch { /* non-fatal */ }
    }

    // In-app completion notification
    await onAnalyzeComplete(job, successCount, total);
  } catch (err) {
    const message = (err as Error).message ?? 'Analysis failed';
    await Job.findByIdAndUpdate(job._id, {
      $set: { status: 'error', error: message },
    });
    // Don't leave the history row stuck as 'analyzing'. Keep it 'classified'
    // if the classification is still valid, otherwise mark it errored.
    try {
      const { MaterialSearch } = await import('../models/MaterialSearch.js');
      await MaterialSearch.updateOne(
        { analyzeJobId: String(job._id), status: 'analyzing' },
        { $set: { status: 'classified' } },
      );
    } catch { /* non-fatal */ }
    await onJobError(job, message);
    emit({ type: 'error', message });
  } finally {
    clearInterval(hb);
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function runJob(job: IJob, emit: EmitFn): Promise<void> {
  if (job.type === 'classify') return runClassify(job, emit);
  if (job.type === 'analyze')  return runAnalyze(job, emit);
  throw new Error(`Unknown job type: ${job.type}`);
}

/**
 * Kick off a job server-side, immediately at creation time, so it runs to
 * completion in the background even if the client never opens (or quickly
 * closes) the SSE stream. Execution is fire-and-forget: the result is always
 * persisted to Mongo and a completion notification is raised.
 *
 * Safe to call alongside the SSE stream's own claim — claimJob is atomic, so
 * only one worker ever runs a given job; a second caller becomes a no-op tail.
 */
export async function startJobExecution(jobId: string): Promise<void> {
  try {
    const claimed = await claimJob(jobId, newWorkerId());
    if (!claimed) return; // already running elsewhere
    // Background no-op emitter — live progress is tailed from Mongo by the stream.
    runJob(claimed, () => { /* background */ }).catch((err) => {
      console.error(`[startJobExecution] job ${jobId} crashed:`, err);
    });
  } catch (err) {
    console.error(`[startJobExecution] failed to start job ${jobId}:`, err);
  }
}

/** Generate a unique worker ID for lease tracking. */
export const newWorkerId = () => randomUUID();
