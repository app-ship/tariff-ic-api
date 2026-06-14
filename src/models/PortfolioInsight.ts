import mongoose, { type Document, type Model, Schema } from 'mongoose';

/**
 * PortfolioInsight — an actionable alert/recommendation that affects portfolio
 * exposure.
 *
 * Two sources feed the same collection:
 *   - 'monitor'  : seeded by the Monitor -> Assess loop
 *                  (monitorChecker.recordPortfolioInsights) when a tariff
 *                  monitor detects a material change. kind === 'tariff_change'.
 *   - 'derived'  : computed client-side from analyzed materials and persisted
 *                  via POST /recommend/sync. These power the Recommend feature
 *                  (sourcing shifts, exclusion filings, binding rulings, etc.)
 *                  and are deduped by `recKey`.
 */

export type InsightKind =
  | 'tariff_change'
  | 'sourcing_shift'
  | 'exclusion_301'
  | 'ieepa_mitigation'
  | 'binding_ruling'
  | 'fta_optimization';

export type InsightSource   = 'monitor' | 'derived';
export type InsightSeverity = 'high' | 'medium' | 'low';
export type InsightStatus   = 'open' | 'accepted' | 'snoozed' | 'dismissed' | 'resolved';

export interface IPortfolioInsight extends Document {
  orgId:        string;
  userId:       string;
  source:       InsightSource;
  recKey?:      string;   // deterministic dedupe key for derived recs
  searchId?:    string;   // MaterialSearch this insight relates to
  monitorId?:   string;   // TariffMonitor that fired (monitor source only)
  htsCode:      string;
  materialName: string;
  country:      string;   // origin country whose rate changed / is targeted
  kind:         InsightKind;
  title?:       string;
  previousRate: number | null;
  newRate:      number | null;
  rateDelta:    number;   // newRate - previousRate (percentage points)
  annualSpend?: number;   // captured from the linked MaterialSearch
  exposureDelta: number;  // annualSpend * rateDelta / 100 (USD/yr); 0 when spend unknown
  potentialSavings?: number; // estimated $/yr opportunity (derived recs)
  confidence?:  number;   // 0-100 (derived recs)
  timeline?:    string;
  complexity?:  string;
  severity:     InsightSeverity;
  recommendedAction: string;
  status:       InsightStatus;
  snoozedUntil?: Date;
  acceptedAt?:   Date;
  createdAt: Date;
  updatedAt: Date;
}

const portfolioInsightSchema = new Schema<IPortfolioInsight>(
  {
    orgId:        { type: String, required: true, index: true },
    userId:       { type: String, required: true },
    source:       { type: String, enum: ['monitor', 'derived'], default: 'monitor' },
    recKey:       { type: String },
    searchId:     { type: String },
    monitorId:    { type: String },
    htsCode:      { type: String, required: true },
    materialName: { type: String, required: true },
    country:      { type: String, required: true },
    kind: {
      type: String,
      enum: ['tariff_change', 'sourcing_shift', 'exclusion_301', 'ieepa_mitigation', 'binding_ruling', 'fta_optimization'],
      default: 'tariff_change',
    },
    title:        { type: String },
    previousRate: { type: Number, default: null },
    newRate:      { type: Number, default: null },
    rateDelta:    { type: Number, default: 0 },
    annualSpend:  { type: Number },
    exposureDelta: { type: Number, default: 0 },
    potentialSavings: { type: Number },
    confidence:   { type: Number },
    timeline:     { type: String },
    complexity:   { type: String },
    severity:     { type: String, enum: ['high', 'medium', 'low'], required: true },
    recommendedAction: { type: String, required: true },
    status:       { type: String, enum: ['open', 'accepted', 'snoozed', 'dismissed', 'resolved'], default: 'open' },
    snoozedUntil: { type: Date },
    acceptedAt:   { type: Date },
  },
  { timestamps: true },
);

// Auto-expire insights after 90 days (matches material_searches retention)
portfolioInsightSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Efficient listing of insights per org, newest first
portfolioInsightSchema.index({ orgId: 1, status: 1, createdAt: -1 });

// Dedupe key — one insight per monitor+country+detected rate
portfolioInsightSchema.index({ orgId: 1, monitorId: 1, country: 1, newRate: 1 });

// Dedupe key for derived recommendations — one per org+recKey
portfolioInsightSchema.index({ orgId: 1, recKey: 1 }, { sparse: true });

export const PortfolioInsight =
  (mongoose.models.PortfolioInsight as Model<IPortfolioInsight>) ||
  mongoose.model<IPortfolioInsight>('PortfolioInsight', portfolioInsightSchema, 'portfolio_insights');
