/**
 * Analysis lifecycle — keeps the durable record of every classify/analyze job so
 * the user never loses work they started:
 *
 *  - On START:  a MaterialSearch row is created/attached immediately (status
 *               'pending' | 'analyzing') so the job shows up in Analysis History
 *               right away, and a 'running' Notification is created so it shows
 *               up in the in-app notifications inbox.
 *  - On FINISH: the same Notification is flipped to 'complete' / 'error' (and
 *               marked unread) so the user gets an in-app completion alert.
 *
 * All functions are defensive — a lifecycle failure must never break the job.
 */

import type { IJob } from '../models/Job.js';
import { MaterialSearch } from '../models/MaterialSearch.js';
import { Notification } from '../models/Notification.js';

type Rec = Record<string, unknown>;

function ctx(job: IJob) {
  const req = job.request as Rec;
  return {
    jobId:  String(job._id),
    orgId:  String(req.orgId ?? job.orgId ?? ''),
    userId: String(req.userId ?? job.userId ?? ''),
    req,
  };
}

/** Extract financial/trade context captured at analyze time. */
function financialContext(req: Rec): Rec {
  const annualSpendNum = Number(String(req.annual_spend ?? '').replace(/[^0-9.]/g, ''));
  return {
    ...(Number.isFinite(annualSpendNum) && annualSpendNum > 0 ? { annualSpend: annualSpendNum } : {}),
    ...(req.total_shipment_value != null ? { shipmentValue: Number(req.total_shipment_value) } : {}),
    ...(req.origin ? { origin: String(req.origin) } : {}),
    ...(req.destination ? { destination: String(req.destination) } : {}),
  };
}

// ── Notification helpers ──────────────────────────────────────────────────────

async function createRunningNotification(args: {
  orgId: string; userId: string; jobId: string;
  jobType: 'classify' | 'analyze'; materialName: string; htsCode: string; searchId?: string;
}): Promise<void> {
  const { jobType, materialName } = args;
  const title = jobType === 'classify'
    ? `Classifying ${materialName}…`
    : `Analyzing tariffs for ${materialName}…`;
  const body = jobType === 'classify'
    ? 'HTS classification is running. We\u2019ll notify you when it\u2019s ready.'
    : 'Tariff analysis is running. We\u2019ll notify you when it\u2019s ready.';

  try {
    await Notification.findOneAndUpdate(
      { orgId: args.orgId, jobId: args.jobId },
      {
        $setOnInsert: {
          orgId: args.orgId, userId: args.userId, type: 'analysis',
          jobId: args.jobId, jobType, materialName, htsCode: args.htsCode,
          searchId: args.searchId,
        },
        $set: { status: 'running', title, body, read: false },
      },
      { upsert: true },
    );
  } catch (e) {
    console.error('[lifecycle] createRunningNotification failed:', e);
  }
}

/** Flip the job's notification to a terminal state and re-surface it (unread). */
async function finishNotification(
  jobId: string, orgId: string,
  patch: { status: 'complete' | 'error'; title: string; body: string; searchId?: string },
): Promise<void> {
  try {
    await Notification.updateOne(
      { orgId, jobId },
      { $set: { ...patch, read: false } },
    );
  } catch (e) {
    console.error('[lifecycle] finishNotification failed:', e);
  }
}

// ── Public: job START ───────────────────────────────────────────────────────

/** Classify job started — create the pending history row + running notification. */
export async function onClassifyStart(job: IJob): Promise<void> {
  const { jobId, orgId, userId, req } = ctx(job);
  const materialName = String(req.material_name ?? req.cas_number ?? 'Unknown material');
  const casNumber = req.cas_number ? String(req.cas_number) : undefined;

  let searchId: string | undefined;
  try {
    const doc = await MaterialSearch.findOneAndUpdate(
      { classifyJobId: jobId },
      {
        $setOnInsert: {
          orgId, userId, materialName, casNumber, classifyJobId: jobId, status: 'pending',
        },
      },
      { upsert: true, new: true },
    );
    searchId = String(doc._id);
  } catch (e) {
    console.error('[lifecycle] onClassifyStart search failed:', e);
  }

  await createRunningNotification({ orgId, userId, jobId, jobType: 'classify', materialName, htsCode: '', searchId });
}

/** Analyze job started — attach (or create) the history row + running notification. */
export async function onAnalyzeStart(job: IJob): Promise<void> {
  const { jobId, orgId, userId, req } = ctx(job);
  const htsCode = String(req.htscode ?? req.hts_code ?? '').trim();
  const materialName = String(req.material_name ?? 'Material');
  const countries = Array.isArray(req.countries) ? (req.countries as string[]) : [];

  let searchId: string | undefined;
  try {
    // Attach to the most recent classify search for this org+HTS that has no
    // analyze job yet, so one row carries both classification + tariff.
    let doc = await MaterialSearch
      .findOne({ orgId, htsCode, analyzeJobId: { $exists: false } })
      .sort({ createdAt: -1 });

    if (!doc) {
      doc = await MaterialSearch.create({ orgId, userId, materialName, htsCode, status: 'analyzing' });
    }

    await MaterialSearch.updateOne(
      { _id: doc._id },
      { $set: { analyzeJobId: jobId, countries, status: 'analyzing', ...financialContext(req) } },
    );
    searchId = String(doc._id);
  } catch (e) {
    console.error('[lifecycle] onAnalyzeStart search failed:', e);
  }

  await createRunningNotification({ orgId, userId, jobId, jobType: 'analyze', materialName, htsCode, searchId });
}

// ── Public: job FINISH (notifications only — MaterialSearch data is written by the runner) ──

export async function onClassifyComplete(job: IJob, htsCode: string): Promise<void> {
  const { jobId, orgId, req } = ctx(job);
  const materialName = String(req.material_name ?? req.cas_number ?? 'Material');
  await finishNotification(jobId, orgId, {
    status: 'complete',
    title: `Classification ready: ${materialName}`,
    body: htsCode ? `Classified as HTS ${htsCode}. Tap to view.` : 'HTS classification complete. Tap to view.',
  });
}

export async function onAnalyzeComplete(job: IJob, successCount: number, total: number): Promise<void> {
  const { jobId, orgId, req } = ctx(job);
  const materialName = String(req.material_name ?? 'Material');
  const ok = successCount > 0;
  await finishNotification(jobId, orgId, {
    status: ok ? 'complete' : 'error',
    title: ok ? `Tariff analysis ready: ${materialName}` : `Tariff analysis failed: ${materialName}`,
    body: ok
      ? `Analyzed ${successCount} of ${total} ${total === 1 ? 'country' : 'countries'}. Tap to view.`
      : 'No country returned usable tariff data. Tap to re-run.',
  });
}

export async function onJobError(job: IJob, message: string): Promise<void> {
  const { jobId, orgId, req } = ctx(job);
  const materialName = String(req.material_name ?? req.cas_number ?? 'Material');
  await finishNotification(jobId, orgId, {
    status: 'error',
    title: `Analysis failed: ${materialName}`,
    body: message || 'The job failed. Tap to try again.',
  });
}
