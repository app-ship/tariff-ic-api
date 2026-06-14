/**
 * Action-plan templates — the deterministic, grounded skeleton for each
 * recommendation kind.
 *
 * Anti-slop split of responsibility:
 *   - This file owns the PROCEDURE (real steps, agencies, form numbers, portal
 *     URLs, statutory timelines) and the REAL DATA hydration (HTS, rates,
 *     dollar figures, legal citations, AD/CVD case numbers) read straight from
 *     the stored analysis blobs.
 *   - deep-research (/material/action-plan) only DRAFTS PROSE (summary, the draft
 *     letter/email body, short step notes), which we slot in but never trust for
 *     facts/citations.
 */

import { randomUUID } from 'crypto';
import type { Block, Citation, ChecklistItem, Kpi } from '../models/ActionPlan.js';

export interface DraftSections {
  summary?: string;
  draft_body?: string;
  step_notes?: string[];
}

export interface Grounding {
  materialName: string;
  htsCode: string;
  country: string;
  bestCountry?: string;
  annualSpend?: number;
  potentialSavings?: number;
  // rates (best-effort, percentage points)
  mfnRate?: number;
  s301Rate?: number;
  ieepaRate?: number;
  s232Rate?: number;
  adCvdRate?: number;
  totalRate?: number;
  s301List?: string;
  adCvdCases: string[];
  classificationConfidence?: string;
  classificationReasoning?: string;
  citations: Citation[];
}

function bid(): string { return randomUUID(); }
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function fmtMoney(v?: number): string {
  if (v == null) return '[n/a]';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPct(v?: number): string { return v == null ? '[n/a]' : `${v.toFixed(2)}%`; }

// ── Grounding extraction from the stored MaterialSearch blobs ────────────────
function asRecord(v: unknown): Record<string, unknown> { return (v && typeof v === 'object') ? v as Record<string, unknown> : {}; }

function findOriginData(analyzeResult: unknown, country: string): Record<string, unknown> | undefined {
  if (!Array.isArray(analyzeResult)) return undefined;
  const rows = analyzeResult as Array<Record<string, unknown>>;
  const match =
    rows.find((r) => !r.error && r.data && String(r.country).toLowerCase() === country.toLowerCase()) ??
    rows.find((r) => !r.error && r.data);
  return match ? asRecord(match.data) : undefined;
}

function collectCitations(ca: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const sections = ['foundation_analysis', 'section_301_analysis', 'section_232_analysis', 'ieepa_analysis', 'anti_dumping_analysis', 'countervailing_analysis', 'final_calculation'];
  for (const key of sections) {
    const sec = asRecord(ca[key]);
    const cites = Array.isArray(sec.legal_citations) ? sec.legal_citations as Array<Record<string, unknown>> : [];
    for (const c of cites) {
      const number = String(c.citation_number ?? '').trim();
      const title = String(c.title ?? c.citation_type ?? '').trim();
      const label = [title, number].filter(Boolean).join(' — ') || number || title;
      if (!label) continue;
      const dedupe = `${label}|${c.url ?? ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ label, url: c.url ? String(c.url) : undefined, detail: String(c.citation_type ?? '') || undefined });
    }
  }
  return out.slice(0, 12);
}

export function extractGrounding(input: {
  materialName: string;
  htsCode: string;
  country: string;
  bestCountry?: string;
  annualSpend?: number;
  potentialSavings?: number;
  classifyResult?: unknown;
  analyzeResult?: unknown;
}): Grounding {
  const originData = findOriginData(input.analyzeResult, input.country) ?? {};
  const ca = asRecord(originData.comprehensive_analysis);
  const rb = asRecord(originData.rate_breakdown ?? asRecord(ca.final_calculation).component_breakdown);

  const s301 = asRecord(ca.section_301_analysis);
  const ieepa = asRecord(ca.ieepa_analysis);
  const s232 = asRecord(ca.section_232_analysis);
  const adcvd = asRecord(originData.adcvd_enhanced);

  const classify = asRecord(input.classifyResult);
  const finalClass = asRecord(classify.final_classification);
  const htsClass = asRecord(finalClass.hts_classification);
  const primaryClass = asRecord(finalClass.primary_classification);
  const reasoning = asRecord(primaryClass.hts_classification);

  const adCvdCases = Array.isArray(adcvd.case_numbers)
    ? (adcvd.case_numbers as unknown[]).map(String).filter(Boolean)
    : [];

  return {
    materialName: input.materialName,
    htsCode: input.htsCode,
    country: input.country,
    bestCountry: input.bestCountry,
    annualSpend: input.annualSpend,
    potentialSavings: input.potentialSavings,
    mfnRate: num(rb['Base MFN'] ?? rb.base_mfn_rate ?? asRecord(asRecord(ca.foundation_analysis).mfn_duty_rate).ad_valorem_rate),
    s301Rate: num(rb['Section 301'] ?? rb.section_301_rate ?? asRecord(s301.duty_rate).ad_valorem_rate ?? s301.duty_rate),
    ieepaRate: num(rb['IEEPA'] ?? ieepa.current_rate ?? ieepa.country_specific_rate),
    s232Rate: num(rb['Section 232'] ?? asRecord(s232.duty_rate).ad_valorem_rate),
    adCvdRate: num(adcvd.ad_rate) != null || num(adcvd.cvd_rate) != null
      ? (num(adcvd.ad_rate) ?? 0) + (num(adcvd.cvd_rate) ?? 0)
      : num(rb['AD/CVD']),
    totalRate: num(originData.final_tariff_rate ?? originData.total_rate ?? originData.total_effective_rate),
    s301List: s301.list_designation ? String(s301.list_designation) : undefined,
    adCvdCases,
    classificationConfidence: htsClass.confidence_level ? String(htsClass.confidence_level) : undefined,
    classificationReasoning: reasoning.classification_logic ? String(reasoning.classification_logic) : undefined,
    citations: collectCitations(ca),
  };
}

// Returns the trimmed analysis subtrees the deep-research drafting prompt needs.
export function extractAnalysisSlices(input: {
  country: string;
  classifyResult?: unknown;
  analyzeResult?: unknown;
}): { tariff_analysis?: Record<string, unknown>; classification_analysis?: Record<string, unknown> } {
  const originData = findOriginData(input.analyzeResult, input.country) ?? {};
  const ca = asRecord(originData.comprehensive_analysis);
  const classify = asRecord(input.classifyResult);
  const finalClass = asRecord(classify.final_classification);
  return {
    tariff_analysis: Object.keys(ca).length ? ca : undefined,
    classification_analysis: Object.keys(finalClass).length ? finalClass : undefined,
  };
}

// ── Block builders ───────────────────────────────────────────────────────────
function heading(text: string, level = 2): Block { return { id: bid(), type: 'heading', text, level }; }
function text(t: string, aiGenerated = false): Block { return { id: bid(), type: 'text', text: t, aiGenerated }; }
function callout(t: string, variant: 'info' | 'warning' = 'info'): Block { return { id: bid(), type: 'callout', text: t, variant }; }
function kpiRow(kpis: Kpi[]): Block { return { id: bid(), type: 'kpi', kpis }; }
function checklist(items: string[]): Block {
  const list: ChecklistItem[] = items.map((t) => ({ id: bid(), text: t, checked: false }));
  return { id: bid(), type: 'checklist', items: list };
}
function citationsBlock(citations: Citation[]): Block { return { id: bid(), type: 'citations', citations }; }
function draftBlock(t: string): Block { return { id: bid(), type: 'draft', text: t, aiGenerated: true }; }
function linkButton(label: string, url: string): Block { return { id: bid(), type: 'actionButton', label, buttonKind: 'external', url }; }
function mailButton(label: string, mailto: { to?: string; subject?: string; body?: string }): Block {
  return { id: bid(), type: 'actionButton', label, buttonKind: 'mailto', mailto };
}

const REVIEW_CALLOUT = 'This is an AI-assisted draft grounded in your analysis. Before filing or sending, have a licensed customs broker or trade attorney review it. This is not legal advice.';

function usitcLink(hts: string): Block | null {
  if (!hts) return null;
  return linkButton('View HTS on USITC', `https://hts.usitc.gov/?query=${encodeURIComponent(hts)}`);
}

function summaryBlocks(title: string, g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = [heading(title, 1)];
  if (draft.summary) blocks.push(text(draft.summary, true));
  return blocks;
}

function stepNotesBlock(draft: DraftSections): Block[] {
  if (!draft.step_notes?.length) return [];
  return [heading('Notes', 3), { id: bid(), type: 'checklist', items: draft.step_notes.map((t) => ({ id: bid(), text: t, checked: false })) }];
}

// ── Per-kind templates ───────────────────────────────────────────────────────
export function buildActionPlanBlocks(kind: string, g: Grounding, draft: DraftSections): Block[] {
  switch (kind) {
    case 'binding_ruling':   return bindingRuling(g, draft);
    case 'exclusion_301':    return exclusion301(g, draft);
    case 'sourcing_shift':   return sourcingShift(g, draft);
    case 'ieepa_mitigation': return ieepaMitigation(g, draft);
    case 'fta_optimization': return ftaOptimization(g, draft);
    default:                 return generic(g, draft);
  }
}

function bindingRuling(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`Binding Ruling Request — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'HTS Code', value: g.htsCode || '[n/a]' },
    { label: 'AI Confidence', value: g.classificationConfidence || '[n/a]' },
    { label: 'Current Rate', value: fmtPct(g.totalRate), hint: `from ${g.country}` },
  ]));
  blocks.push(heading('Procedure (CBP eRulings, 19 CFR Part 177)'));
  blocks.push(checklist([
    'Confirm the product description, composition, and intended use are complete and accurate.',
    `Verify the proposed classification HTS ${g.htsCode || '[n/a]'} against chapter/section notes.`,
    'Gather supporting docs: spec sheet, SDS/CoA, photos, and any prior CBP rulings (search CROSS).',
    'Submit the ruling request via the CBP eRulings (CROSS) portal.',
    'Track the request; expect a written ruling typically within ~30-90 days.',
    'On receipt, update your classification of record and apply going forward.',
  ]));
  const draftBody = draft.draft_body || `To whom it may concern,\n\nWe respectfully request a binding classification ruling under 19 CFR Part 177 for ${g.materialName}.\n\nProposed classification: HTS ${g.htsCode || '[not available in analysis]'}.\n\n[Describe the product, its composition, and intended use here.]`;
  blocks.push(heading('Draft ruling request'));
  blocks.push(draftBlock(draftBody));
  const buttons: Block[] = [
    linkButton('Open CBP eRulings (CROSS)', 'https://rulings.cbp.gov/'),
    linkButton('CBP eRulings submission', 'https://erulings.cbp.gov/'),
  ];
  const u = usitcLink(g.htsCode); if (u) buttons.push(u);
  blocks.push(...buttons);
  blocks.push(...stepNotesBlock(draft));
  if (g.citations.length) { blocks.push(heading('Sources from your analysis', 3)); blocks.push(citationsBlock(g.citations)); }
  blocks.push(callout(REVIEW_CALLOUT, 'warning'));
  return blocks;
}

function exclusion301(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`Section 301 Exclusion Request — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'Section 301 Rate', value: fmtPct(g.s301Rate) },
    { label: 'List', value: g.s301List || '[n/a]' },
    { label: 'Annual Exposure', value: fmtMoney(g.annualSpend != null && g.s301Rate != null ? (g.annualSpend * g.s301Rate) / 100 : undefined) },
  ]));
  blocks.push(heading('Procedure (USTR Section 301 exclusion)'));
  blocks.push(checklist([
    'Confirm the product is covered by an active Section 301 list and check for any open exclusion docket.',
    'Document why the product is available only from the covered origin and the economic harm of the duty.',
    'Prepare the exclusion request narrative and supporting evidence.',
    'Submit through the USTR exclusion portal during an open comment/exclusion window.',
    'Monitor the docket for the determination; apply refunds retroactively if granted.',
  ]));
  const draftBody = draft.draft_body || `To the Office of the United States Trade Representative,\n\nWe request a product exclusion from the Section 301 tariffs applicable to ${g.materialName} (HTS ${g.htsCode || '[not available in analysis]'}), currently subject to an additional ${fmtPct(g.s301Rate)} duty.\n\n[Explain product specifics, sourcing constraints, and economic impact here.]`;
  blocks.push(heading('Draft exclusion narrative'));
  blocks.push(draftBlock(draftBody));
  blocks.push(linkButton('USTR Section 301 portal', 'https://comments.ustr.gov/'));
  const u = usitcLink(g.htsCode); if (u) blocks.push(u);
  blocks.push(...stepNotesBlock(draft));
  if (g.citations.length) { blocks.push(heading('Sources from your analysis', 3)); blocks.push(citationsBlock(g.citations)); }
  blocks.push(callout(REVIEW_CALLOUT, 'warning'));
  return blocks;
}

function sourcingShift(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`Sourcing Shift — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'Current Origin', value: g.country || '[n/a]', hint: fmtPct(g.totalRate) },
    { label: 'Target Origin', value: g.bestCountry || '[n/a]' },
    { label: 'Projected Savings', value: fmtMoney(g.potentialSavings), hint: 'per year' },
  ]));
  blocks.push(heading('Supplier qualification plan'));
  blocks.push(checklist([
    `Identify and shortlist qualified suppliers in ${g.bestCountry || 'the target origin'}.`,
    'Send the RFQ below and request samples, lead times, MOQs, and certifications.',
    'Run incoming QC / lab testing on samples against your spec.',
    'Recompute total landed cost (duty + freight + qualification) vs current sourcing.',
    'Negotiate terms and execute a supply agreement.',
    'Confirm the new duty rate with a fresh tariff analysis before first shipment.',
  ]));
  const draftBody = draft.draft_body || `Dear Supplier,\n\nWe are evaluating new suppliers for ${g.materialName} (HTS ${g.htsCode || '[not available in analysis]'}) and would like to request a quotation.\n\nPlease provide: unit price (FOB and landed), MOQ, lead time, available certifications, and capacity.\n\n[Add your spec / volume details here.]\n\nThank you.`;
  blocks.push(heading('Draft supplier RFQ'));
  blocks.push(draftBlock(draftBody));
  blocks.push(mailButton('Email supplier RFQ', {
    subject: `RFQ — ${g.materialName} (HTS ${g.htsCode || ''})`.trim(),
    body: draftBody,
  }));
  blocks.push(...stepNotesBlock(draft));
  blocks.push(callout('Validate the projected savings with a fresh tariff analysis on the target origin before committing — rates change.', 'info'));
  return blocks;
}

function ieepaMitigation(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`IEEPA Duty Mitigation — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'IEEPA Rate', value: fmtPct(g.ieepaRate) },
    { label: 'Origin', value: g.country || '[n/a]' },
    { label: 'Annual Exposure', value: fmtMoney(g.annualSpend != null && g.ieepaRate != null ? (g.annualSpend * g.ieepaRate) / 100 : undefined) },
  ]));
  blocks.push(heading('Monitoring & mitigation plan'));
  blocks.push(checklist([
    'Set up a monitor on this HTS + origin to catch IEEPA rate changes and truce updates.',
    'Track USTR/CBP guidance and Federal Register notices for HTS-specific exclusions.',
    'Evaluate whether an exclusion or legal-challenge path is available.',
    'Model the exposure under plausible IEEPA scenarios in Simulate.',
  ]));
  if (draft.draft_body) { blocks.push(heading('Draft internal memo')); blocks.push(draftBlock(draft.draft_body)); }
  blocks.push(...stepNotesBlock(draft));
  if (g.citations.length) { blocks.push(heading('Sources from your analysis', 3)); blocks.push(citationsBlock(g.citations)); }
  blocks.push(callout(REVIEW_CALLOUT, 'warning'));
  return blocks;
}

function ftaOptimization(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`FTA / Preferential Rate — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'HTS Code', value: g.htsCode || '[n/a]' },
    { label: 'Origin', value: g.country || '[n/a]' },
    { label: 'Current Rate', value: fmtPct(g.totalRate) },
  ]));
  blocks.push(heading('Qualification plan'));
  blocks.push(checklist([
    'Determine which trade agreement / preference program could apply for this origin.',
    'Verify the product meets the rule-of-origin requirements (tariff shift / regional value content).',
    'Collect supporting documentation and certificates of origin.',
    'Confirm the preferential rate and claim it on entry.',
  ]));
  if (draft.draft_body) { blocks.push(heading('Draft memo')); blocks.push(draftBlock(draft.draft_body)); }
  blocks.push(...stepNotesBlock(draft));
  if (g.citations.length) { blocks.push(heading('Sources from your analysis', 3)); blocks.push(citationsBlock(g.citations)); }
  blocks.push(callout(REVIEW_CALLOUT, 'warning'));
  return blocks;
}

function generic(g: Grounding, draft: DraftSections): Block[] {
  const blocks: Block[] = summaryBlocks(`Action Plan — ${g.materialName}`, g, draft);
  blocks.push(kpiRow([
    { label: 'HTS Code', value: g.htsCode || '[n/a]' },
    { label: 'Origin', value: g.country || '[n/a]' },
    { label: 'Current Rate', value: fmtPct(g.totalRate) },
  ]));
  blocks.push(heading('Next steps'));
  blocks.push(checklist([
    'Review the recommendation rationale and confirm the opportunity.',
    'Assign an owner and a target date.',
    'Validate the numbers with a fresh analysis if the data is stale.',
  ]));
  if (draft.draft_body) { blocks.push(heading('Draft')); blocks.push(draftBlock(draft.draft_body)); }
  blocks.push(...stepNotesBlock(draft));
  if (g.citations.length) { blocks.push(heading('Sources from your analysis', 3)); blocks.push(citationsBlock(g.citations)); }
  return blocks;
}
