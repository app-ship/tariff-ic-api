import mongoose, { type Document, type Model, Schema } from 'mongoose';

/**
 * ActionPlan — the "Act" stage. A living, Notion-style document generated when a
 * user accepts a recommendation and sends it to Act. It is grounded in the real
 * stored analysis (MaterialSearch.classifyResult / analyzeResult): the
 * deterministic procedural skeleton + real numbers/citations are assembled by
 * tariff-ic-api (actionTemplates.ts), while deep-research only drafts prose.
 *
 * The document is editable + stateful (checklist checks, edited draft text) and
 * doubles as a lightweight case tracker (status, owner, due date, projected vs
 * realized savings).
 */

export type ActionPlanStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'abandoned';

export type BlockType =
  | 'heading'
  | 'text'
  | 'checklist'
  | 'draft'
  | 'actionButton'
  | 'citations'
  | 'callout'
  | 'kpi';

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  owner?: string;
  dueDate?: string;
}

export interface Citation {
  label: string;
  url?: string;
  detail?: string;   // e.g. field path / case number it came from
}

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

export type ActionButtonKind = 'mailto' | 'external' | 'copy';

export interface Block {
  id: string;
  type: BlockType;
  // type-specific (only the relevant fields are populated)
  text?: string;                 // heading / text / draft / callout
  level?: number;                // heading level
  variant?: string;              // callout variant (info | warning)
  items?: ChecklistItem[];       // checklist
  citations?: Citation[];        // citations
  kpis?: Kpi[];                  // kpi row
  // actionButton
  label?: string;
  buttonKind?: ActionButtonKind;
  url?: string;
  mailto?: { to?: string; subject?: string; body?: string };
  copyFromBlockId?: string;      // actionButton 'copy' source
  aiGenerated?: boolean;         // provenance: prose drafted by the LLM
}

export interface IActionPlan extends Document {
  orgId:        string;
  userId:       string;
  insightId?:   string;   // portfolio_insights rec this came from
  recKey?:      string;
  searchId?:    string;   // MaterialSearch grounding source
  kind:         string;   // recommendation kind -> template
  title:        string;
  materialName: string;
  htsCode?:     string;
  country?:     string;
  status:       ActionPlanStatus;
  owner?:       string;
  dueDate?:     Date;
  projectedSavings?: number;
  realizedSavings?:  number;
  blocks:       Block[];
  generatedModel?: string;
  createdAt: Date;
  updatedAt: Date;
}

const actionPlanSchema = new Schema<IActionPlan>(
  {
    orgId:        { type: String, required: true, index: true },
    userId:       { type: String, required: true },
    insightId:    { type: String },
    recKey:       { type: String },
    searchId:     { type: String },
    kind:         { type: String, required: true },
    title:        { type: String, required: true },
    materialName: { type: String, required: true },
    htsCode:      { type: String },
    country:      { type: String },
    status:       { type: String, enum: ['not_started', 'in_progress', 'blocked', 'completed', 'abandoned'], default: 'not_started' },
    owner:        { type: String },
    dueDate:      { type: Date },
    projectedSavings: { type: Number },
    realizedSavings:  { type: Number },
    blocks:       { type: [Schema.Types.Mixed], default: [] },
    generatedModel: { type: String },
  },
  { timestamps: true },
);

// Auto-expire plans after 1 year
actionPlanSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

// Pipeline listing per org
actionPlanSchema.index({ orgId: 1, status: 1, updatedAt: -1 });

// One plan per accepted recommendation (idempotent generation)
actionPlanSchema.index({ orgId: 1, insightId: 1 }, { sparse: true });

export const ActionPlan =
  (mongoose.models.ActionPlan as Model<IActionPlan>) ||
  mongoose.model<IActionPlan>('ActionPlan', actionPlanSchema, 'action_plans');
