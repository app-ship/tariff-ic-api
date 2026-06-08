/**
 * Sample analysis fixture
 *
 * Seeded for every new sandbox org so the empty state shows a realistic demo
 * result immediately. Stored in Mongo as a lightweight record; surfaced through
 * the history route as isSample:true so the UI can render it read-only.
 *
 * This canned result is for a precision steel ball bearing imported from China.
 */

import mongoose, { type Document, type Model, Schema } from 'mongoose';

// ── Minimal in-process storage model ─────────────────────────────────────────

export interface ISampleEntry extends Document {
  orgId:     string;
  userId:    string;
  isSample:  true;
  createdAt: Date;
  result:    Record<string, unknown>;
}

const sampleSchema = new Schema<ISampleEntry>(
  {
    orgId:    { type: String, required: true },
    userId:   { type: String, required: true },
    isSample: { type: Boolean, default: true },
    result:   { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

export const SampleEntry =
  (mongoose.models.SampleEntry as Model<ISampleEntry>) ||
  mongoose.model<ISampleEntry>('SampleEntry', sampleSchema);

// ── Canned tariff result ──────────────────────────────────────────────────────

export function buildSampleResult(): Record<string, unknown> {
  return {
    isSample:         true,
    material_name:    'Precision Steel Ball Bearing',
    cas_number:       null,
    hts_code:         '8482.10.5028',
    hts_description:  'Ball bearings, with integral shafts, precision ground',
    classification_confidence: 0.94,
    usage_context:    'Used in electric motors for industrial automation equipment',
    origin_country:   'China',
    destination_country: 'United States',
    tariff_breakdown: {
      base_duty_rate:     0.044,   // 4.4% MFN
      section_301_rate:   0.25,    // 25% Section 301
      effective_total:    0.294,   // 29.4%
      notes: 'Subject to Section 301 List 3 tariffs. HTS 9903.88.03 applies.',
    },
    alternative_origins: [
      {
        country:        'Vietnam',
        effective_rate: 0.044,
        annual_savings_estimate_usd: 18600,
        feasibility:    'High — active supplier base',
        risk_score:     22,
      },
      {
        country:        'India',
        effective_rate: 0.044,
        annual_savings_estimate_usd: 17200,
        feasibility:    'Medium — growing precision mfg capacity',
        risk_score:     31,
      },
      {
        country:        'Taiwan',
        effective_rate: 0.044,
        annual_savings_estimate_usd: 16800,
        feasibility:    'High — established precision parts exporter',
        risk_score:     28,
      },
    ],
    searched_at: new Date().toISOString(),
  };
}

// ── Seed helper ───────────────────────────────────────────────────────────────

export async function seedSampleAnalysis(orgId: string, userId: string): Promise<void> {
  const existing = await SampleEntry.findOne({ orgId });
  if (existing) return;               // idempotent

  await SampleEntry.create({
    orgId,
    userId,
    isSample: true,
    result:   buildSampleResult(),
  });

  console.log(`[sample-seed] seeded sample for org=${orgId}`);
}
