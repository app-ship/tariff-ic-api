import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type MaterialSearchStatus =
  | 'pending'      // classify job queued/running
  | 'classified'   // classification complete
  | 'analyzing'    // tariff analysis job queued/running
  | 'analyzed'     // tariff analysis complete
  | 'error';       // failed

export interface IMaterialSearch extends Document {
  orgId:          string;
  userId:         string;
  materialName:   string;
  casNumber?:     string;
  htsCode?:       string;
  confidence?:    string;
  classifyJobId?: string;
  analyzeJobId?:  string;
  countries?:     string[];
  status:         MaterialSearchStatus;
  /** Financial context captured at analyze time so history can show dollar impact */
  annualSpend?:   number;
  shipmentValue?: number;
  origin?:        string;
  destination?:   string;
  /** Raw deep-research classification response */
  classifyResult?: Record<string, unknown>;
  /** Raw per-country analyze result rows */
  analyzeResult?:  unknown;
  createdAt: Date;
  updatedAt: Date;
}

const materialSearchSchema = new Schema<IMaterialSearch>(
  {
    orgId:         { type: String, required: true, index: true },
    userId:        { type: String, required: true },
    materialName:  { type: String, required: true },
    casNumber:     { type: String },
    htsCode:       { type: String },
    confidence:    { type: String },
    classifyJobId: { type: String },
    analyzeJobId:  { type: String },
    countries:     { type: [String] },
    status:        { type: String, enum: ['pending', 'classified', 'analyzing', 'analyzed', 'error'], required: true },
    annualSpend:   { type: Number },
    shipmentValue: { type: Number },
    origin:        { type: String },
    destination:   { type: String },
    classifyResult: { type: Schema.Types.Mixed },
    analyzeResult:  { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Auto-expire searches after 90 days
materialSearchSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Efficient paginated listing per org, newest first
materialSearchSchema.index({ orgId: 1, createdAt: -1 });

export const MaterialSearch =
  (mongoose.models.MaterialSearch as Model<IMaterialSearch>) ||
  mongoose.model<IMaterialSearch>('MaterialSearch', materialSearchSchema, 'material_searches');
