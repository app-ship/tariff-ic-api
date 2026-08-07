/**
 * monitorChecker — hybrid tariff-change detection for the Monitor feature.
 *
 * Two stages (per the plan):
 *   1. Cheap baseline check (runs every time a monitor is due): calls the
 *      deterministic deep-research `/material/tariff/baseline` endpoint (no AI)
 *      and diffs base MFN rate + active-rule signature against the stored snapshot.
 *   2. Full re-analysis (expensive, AI): triggered when a cheap delta is found,
 *      or on a weekly safety cadence. Calls `/material/tax-rate/parallel/fast`
 *      (rates_only) per country and diffs the effective rate.
 *
 * On a confirmed change we create an in-app Notification, append to the
 * monitor's changeHistory, and refresh its baseline snapshot.
 */

import { drClient } from '../deepResearchClient.js';
import { TariffMonitor, type ITariffMonitor, type IMonitorBaselineEntry, type IMonitorChange } from '../models/TariffMonitor.js';
import { Notification } from '../models/Notification.js';
import { MaterialSearch } from '../models/MaterialSearch.js';
import { PortfolioInsight, type InsightSeverity } from '../models/PortfolioInsight.js';

const WEEKLY_FULL_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_EPSILON = 0.01;   // ignore sub-0.01% float noise
const FULL_ANALYSIS_CONCURRENCY = 3;

interface BaselineApiEntry {
  country: string;
  country_code: string;
  base_mfn_rate: number | null;
  additional_duties_rate: number;
  applicable_rule_ids: string[];
  rule_signature: string;
  effective_rate_estimate: number | null;
}

export interface MonitorCheckResult {
  monitorId: string;
  changed: boolean;
  ranFullAnalysis: boolean;
  changes: IMonitorChange[];
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function computeNextCheckAt(frequency: 'daily' | 'weekly', from: Date = new Date()): Date {
  const days = frequency === 'weekly' ? 7 : 1;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ratesDiffer(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) >= RATE_EPSILON;
}

/**
 * Product context that changes the rate but not the HTS code. Section 232
 * pharmaceuticals swing between 0% and a 100% ceiling on productStatus alone,
 * so a baseline captured without it is not comparable to the customer's
 * Tariff Intelligence result.
 */
export interface PharmaContext {
  casNumber?:     string;
  materialName?:  string;
  productStatus?: string;
  itemType?:      string;
  companyName?:   string;
}

/** Fetch the cheap deterministic baseline for an HTS code across countries. */
export async function fetchBaseline(
  htsCode: string,
  countries: string[],
  opts: PharmaContext = {},
): Promise<BaselineApiEntry[]> {
  const { data } = await drClient.post(
    '/material/tariff/baseline',
    {
      hts_code: htsCode,
      countries,
      cas_number: opts.casNumber,
      material_name: opts.materialName,
      product_status: opts.productStatus,
      item_type: opts.itemType,
      company_name: opts.companyName,
    },
    { timeout: 60_000 },
  );
  return (data?.results ?? []) as BaselineApiEntry[];
}

/** Build an initial baseline snapshot (used when a monitor is created). */
export async function buildBaselineSnapshot(
  htsCode: string,
  countries: string[],
  opts: PharmaContext = {},
): Promise<IMonitorBaselineEntry[]> {
  const entries = await fetchBaseline(htsCode, countries, opts);
  const now = new Date();
  return entries.map((e) => ({
    country:           e.country,
    baseMfnRate:       num(e.base_mfn_rate),
    effectiveRate:     num(e.effective_rate_estimate),
    ruleSignature:     e.rule_signature ?? '',
    applicableRuleIds: e.applicable_rule_ids ?? [],
    capturedAt:        now,
  }));
}

/** Run a full (rates-only) re-analysis per country and return effective rates. */
async function runFullAnalysis(
  monitor: ITariffMonitor,
): Promise<Map<string, { effectiveRate: number | null; baseRate: number | null }>> {
  const out = new Map<string, { effectiveRate: number | null; baseRate: number | null }>();
  const countries = monitor.countries ?? [];

  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < countries.length) {
      const country = countries[idx++];
      try {
        const { data } = await drClient.post(
          '/material/tax-rate/parallel/fast',
          {
            htscode:        monitor.htsCode,
            material_name:  monitor.materialName,
            import_country: country,
            annual_spend:   '0',
            cas_number:     monitor.casNumber,
            product_status: monitor.productStatus,
            item_type:      monitor.itemType,
            company_name:   monitor.companyName,
            org_id:         monitor.orgId,
            user_id:        monitor.userId,
            async_mode:     false,
          },
          { params: { bypass_cache: true, rates_only: true }, timeout: 300_000 },
        );
        const d = (data ?? {}) as Record<string, unknown>;
        const effectiveRate =
          num(d.final_tariff_rate) ?? num(d.total_rate) ?? num(d.total_effective_rate);
        const baseRate = num(d.base_mfn_rate);
        out.set(country, { effectiveRate, baseRate });
      } catch (err) {
        console.error(`[monitorChecker] full analysis failed for ${monitor.htsCode}/${country}:`, (err as Error).message);
        out.set(country, { effectiveRate: null, baseRate: null });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FULL_ANALYSIS_CONCURRENCY, countries.length) }, () => worker()),
  );
  return out;
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Run a hybrid check on a single monitor, persisting any detected change.
 * Always refreshes lastCheckedAt / nextCheckAt.
 */
export async function checkMonitor(monitor: ITariffMonitor): Promise<MonitorCheckResult> {
  const monitorId = String(monitor._id);
  const baselineByCountry = new Map<string, IMonitorBaselineEntry>();
  for (const b of monitor.baseline ?? []) baselineByCountry.set(b.country, b);

  const now = new Date();
  const changes: IMonitorChange[] = [];

  try {
    // Stage 1 — cheap baseline diff
    const fresh = await fetchBaseline(monitor.htsCode, monitor.countries ?? [], {
      casNumber: monitor.casNumber,
      materialName: monitor.materialName,
      productStatus: monitor.productStatus,
      itemType: monitor.itemType,
      companyName: monitor.companyName,
    });
    const freshByCountry = new Map<string, BaselineApiEntry>();
    for (const e of fresh) freshByCountry.set(e.country, e);

    let baselineDelta = false;
    for (const e of fresh) {
      const prev = baselineByCountry.get(e.country);
      if (!prev) continue; // newly added country — seeded below, not an alert
      const newBase = num(e.base_mfn_rate);
      if (ratesDiffer(prev.baseMfnRate ?? null, newBase)) {
        baselineDelta = true;
        changes.push({
          detectedAt: now, country: e.country, field: 'baseMfnRate',
          previousValue: prev.baseMfnRate ?? null, newValue: newBase, source: 'baseline',
        });
      }
      if ((prev.ruleSignature ?? '') !== (e.rule_signature ?? '')) {
        baselineDelta = true;
        changes.push({
          detectedAt: now, country: e.country, field: 'rules',
          previousValue: (prev.applicableRuleIds ?? []).join(',') || null,
          newValue: (e.applicable_rule_ids ?? []).join(',') || null,
          source: 'baseline',
        });
      }
    }

    // Stage 2 — full re-analysis when a baseline delta is found or weekly cadence is due
    const fullDue =
      !monitor.lastFullCheckAt ||
      now.getTime() - new Date(monitor.lastFullCheckAt).getTime() >= WEEKLY_FULL_CHECK_MS;
    const ranFullAnalysis = baselineDelta || fullDue;

    let fullResults: Map<string, { effectiveRate: number | null; baseRate: number | null }> | null = null;
    if (ranFullAnalysis) {
      fullResults = await runFullAnalysis(monitor);
      for (const [country, r] of fullResults) {
        const prev = baselineByCountry.get(country);
        if (!prev) continue;
        if (r.effectiveRate != null && ratesDiffer(prev.effectiveRate ?? null, r.effectiveRate)) {
          changes.push({
            detectedAt: now, country, field: 'effectiveRate',
            previousValue: prev.effectiveRate ?? null, newValue: r.effectiveRate, source: 'analysis',
          });
        }
      }
    }

    // Build the refreshed baseline snapshot
    const newBaseline: IMonitorBaselineEntry[] = (monitor.countries ?? []).map((country) => {
      const fE = freshByCountry.get(country);
      const prev = baselineByCountry.get(country);
      const full = fullResults?.get(country);
      const effectiveRate =
        full && full.effectiveRate != null
          ? full.effectiveRate
          : (prev?.effectiveRate ?? num(fE?.effective_rate_estimate ?? null));
      return {
        country,
        baseMfnRate:       num(fE?.base_mfn_rate ?? null) ?? (prev?.baseMfnRate ?? null),
        effectiveRate,
        ruleSignature:     fE?.rule_signature ?? prev?.ruleSignature ?? '',
        applicableRuleIds: fE?.applicable_rule_ids ?? prev?.applicableRuleIds ?? [],
        capturedAt:        now,
      };
    });

    // Only real changes against a pre-existing baseline count as alerts
    const meaningfulChanges = changes;
    const changed = meaningfulChanges.length > 0;

    const update: Record<string, unknown> = {
      baseline:      newBaseline,
      lastCheckedAt: now,
      nextCheckAt:   computeNextCheckAt(monitor.frequency, now),
      lastError:     undefined,
    };
    if (ranFullAnalysis) update.lastFullCheckAt = now;

    const ops: Record<string, unknown> = { $set: update };
    if (changed) ops.$push = { changeHistory: { $each: meaningfulChanges } };

    await TariffMonitor.updateOne({ _id: monitor._id }, ops);

    if (changed && monitor.channels?.inApp !== false) {
      await createChangeNotification(monitor, meaningfulChanges);
    }

    // Monitor -> Assess loop: turn confirmed effective-rate changes into
    // portfolio insights (recommendations + dollar impact). Independent of the
    // in-app notification channel and never fatal to the check.
    if (changed) {
      await recordPortfolioInsights(monitor, meaningfulChanges);
    }

    return { monitorId, changed, ranFullAnalysis, changes: meaningfulChanges };
  } catch (err) {
    const message = (err as Error).message ?? 'Monitor check failed';
    console.error(`[monitorChecker] check failed for ${monitorId}:`, message);
    await TariffMonitor.updateOne(
      { _id: monitor._id },
      {
        $set: {
          lastCheckedAt: now,
          nextCheckAt:   computeNextCheckAt(monitor.frequency, now),
          lastError:     message,
        },
      },
    );
    return { monitorId, changed: false, ranFullAnalysis: false, changes: [], error: message };
  }
}

function summarizeChanges(changes: IMonitorChange[]): string {
  const parts = changes.slice(0, 4).map((c) => {
    if (c.field === 'rules') return `${c.country}: tariff rules updated`;
    const prev = c.previousValue == null ? '—' : `${c.previousValue}%`;
    const next = c.newValue == null ? '—' : `${c.newValue}%`;
    const label = c.field === 'baseMfnRate' ? 'base MFN' : 'effective rate';
    return `${c.country}: ${label} ${prev} → ${next}`;
  });
  const more = changes.length > 4 ? ` (+${changes.length - 4} more)` : '';
  return parts.join('; ') + more;
}

async function createChangeNotification(monitor: ITariffMonitor, changes: IMonitorChange[]): Promise<void> {
  try {
    await Notification.create({
      orgId:        monitor.orgId,
      userId:       monitor.userId,
      type:         'tariff_change',
      monitorId:    String(monitor._id),
      htsCode:      monitor.htsCode,
      materialName: monitor.materialName,
      title:        `Tariff change detected: ${monitor.materialName}`,
      body:         summarizeChanges(changes),
      changeDetail: changes.map((c) => ({
        country: c.country, field: c.field,
        previousValue: c.previousValue ?? null, newValue: c.newValue ?? null,
      })),
      read: false,
    });
  } catch (err) {
    console.error('[monitorChecker] failed to create notification:', (err as Error).message);
  }
}

// ── Monitor -> Assess loop ──────────────────────────────────────────────────────

function num2(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classifySeverity(exposureDelta: number, rateDelta: number): InsightSeverity {
  const absExp = Math.abs(exposureDelta);
  const absRate = Math.abs(rateDelta);
  if (absExp >= 100_000 || absRate >= 10) return 'high';
  if (absExp >= 10_000 || absRate >= 3) return 'medium';
  return 'low';
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function buildRecommendedAction(
  country: string, rateDelta: number, exposureDelta: number, hasSpend: boolean,
): string {
  const pts = `${Math.abs(rateDelta).toFixed(2)}pts`;
  if (rateDelta > 0) {
    const impact = hasSpend ? ` — est. +${fmtUsd(exposureDelta)}/yr in duty` : '';
    return `${country} effective rate rose ${pts}${impact}. Re-run analysis and evaluate alternate sourcing.`;
  }
  const relief = hasSpend ? ` — est. ${fmtUsd(exposureDelta)}/yr duty relief` : '';
  return `${country} effective rate fell ${pts}${relief}. Re-run analysis to confirm the lower landed cost.`;
}

/**
 * Persist portfolio insights for confirmed effective-rate changes on a monitor
 * that is linked to a material search. Computes a dollar impact from the linked
 * search's annualSpend. Deduped by (monitorId, country, newRate) so repeated
 * checks don't create duplicates. Never throws — best-effort.
 */
export async function recordPortfolioInsights(
  monitor: ITariffMonitor,
  changes: IMonitorChange[],
): Promise<void> {
  try {
    if (!monitor.sourceSearchId) return;

    const rateChanges = changes.filter((c) => c.field === 'effectiveRate');
    if (!rateChanges.length) return;

    const search = await MaterialSearch
      .findOne({ _id: monitor.sourceSearchId, orgId: monitor.orgId })
      .select('annualSpend origin')
      .lean();

    const annualSpend = Number(search?.annualSpend ?? 0);
    const hasSpend = Number.isFinite(annualSpend) && annualSpend > 0;

    for (const change of rateChanges) {
      const previousRate = num2(change.previousValue);
      const newRate = num2(change.newValue);
      if (newRate == null) continue;

      const rateDelta = Number((newRate - (previousRate ?? 0)).toFixed(4));
      if (rateDelta === 0) continue;

      const exposureDelta = hasSpend ? (annualSpend * rateDelta) / 100 : 0;
      const severity = classifySeverity(exposureDelta, rateDelta);
      const recommendedAction = buildRecommendedAction(change.country, rateDelta, exposureDelta, hasSpend);

      await PortfolioInsight.updateOne(
        {
          orgId:     monitor.orgId,
          monitorId: String(monitor._id),
          country:   change.country,
          newRate,
        },
        {
          $setOnInsert: {
            orgId:        monitor.orgId,
            userId:       monitor.userId,
            searchId:     monitor.sourceSearchId,
            monitorId:    String(monitor._id),
            htsCode:      monitor.htsCode,
            materialName: monitor.materialName,
            country:      change.country,
            kind:         'tariff_change',
            previousRate,
            newRate,
            rateDelta,
            ...(hasSpend ? { annualSpend } : {}),
            exposureDelta,
            severity,
            recommendedAction,
            status:       'open',
          },
        },
        { upsert: true },
      );
    }
  } catch (err) {
    console.error('[monitorChecker] failed to record portfolio insights:', (err as Error).message);
  }
}

// ── Batch runner (used by the cron endpoint) ────────────────────────────────────

/** Process all monitors that are due for a check, oldest first, capped per run. */
export async function runDueMonitors(limit = 50): Promise<{ processed: number; changed: number; results: MonitorCheckResult[] }> {
  const now = new Date();
  const due = await TariffMonitor.find({ status: 'active', nextCheckAt: { $lte: now } })
    .sort({ nextCheckAt: 1 })
    .limit(limit);

  const results: MonitorCheckResult[] = [];
  for (const monitor of due) {
    results.push(await checkMonitor(monitor));
  }
  return {
    processed: results.length,
    changed: results.filter((r) => r.changed).length,
    results,
  };
}
