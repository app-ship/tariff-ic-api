import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type MonitorFrequency = 'daily' | 'weekly';
export type MonitorStatus    = 'active' | 'paused';

/** Snapshot of the deterministic tariff baseline for one origin country. */
export interface IMonitorBaselineEntry {
  country:           string;
  baseMfnRate:       number | null;   // base MFN ad-valorem rate (%)
  effectiveRate:     number | null;   // best-known effective rate (%) incl. add'l duties
  ruleSignature:     string;          // hash of active rule ids + rates
  applicableRuleIds: string[];
  capturedAt:        Date;
}

/** An observed change appended to the monitor's history. */
export interface IMonitorChange {
  detectedAt:    Date;
  country:       string;
  field:         'baseMfnRate' | 'effectiveRate' | 'rules';
  previousValue: number | string | null;
  newValue:      number | string | null;
  source:        'baseline' | 'analysis';   // which check stage detected it
  note?:         string;
}

export interface ITariffMonitor extends Document {
  orgId:        string;
  userId:       string;
  materialName: string;
  htsCode:      string;
  casNumber?:   string;
  destination:  string;            // import destination, defaults to 'USA'
  countries:    string[];          // origin countries being monitored
  sourceSearchId?: string;         // MaterialSearch this monitor was created from

  frequency:    MonitorFrequency;
  channels:     { inApp: boolean; email: boolean };
  emailAddress?: string;

  baseline:      IMonitorBaselineEntry[];
  changeHistory: IMonitorChange[];

  status:        MonitorStatus;
  lastCheckedAt?: Date;
  lastFullCheckAt?: Date;          // last time a full re-analysis ran
  nextCheckAt:   Date;
  lastError?:    string;

  createdAt: Date;
  updatedAt: Date;
}

const baselineEntrySchema = new Schema<IMonitorBaselineEntry>(
  {
    country:           { type: String, required: true },
    baseMfnRate:       { type: Number, default: null },
    effectiveRate:     { type: Number, default: null },
    ruleSignature:     { type: String, default: '' },
    applicableRuleIds: { type: [String], default: [] },
    capturedAt:        { type: Date, default: Date.now },
  },
  { _id: false },
);

const changeSchema = new Schema<IMonitorChange>(
  {
    detectedAt:    { type: Date, default: Date.now },
    country:       { type: String, required: true },
    field:         { type: String, enum: ['baseMfnRate', 'effectiveRate', 'rules'], required: true },
    previousValue: { type: Schema.Types.Mixed, default: null },
    newValue:      { type: Schema.Types.Mixed, default: null },
    source:        { type: String, enum: ['baseline', 'analysis'], required: true },
    note:          { type: String },
  },
  { _id: false },
);

const tariffMonitorSchema = new Schema<ITariffMonitor>(
  {
    orgId:          { type: String, required: true },
    userId:         { type: String, required: true },
    materialName:   { type: String, required: true },
    htsCode:        { type: String, required: true },
    casNumber:      { type: String },
    destination:    { type: String, default: 'USA' },
    countries:      { type: [String], default: [] },
    sourceSearchId: { type: String },

    frequency:    { type: String, enum: ['daily', 'weekly'], default: 'daily' },
    channels:     {
      inApp: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
    },
    emailAddress: { type: String },

    baseline:      { type: [baselineEntrySchema], default: [] },
    changeHistory: { type: [changeSchema], default: [] },

    status:          { type: String, enum: ['active', 'paused'], default: 'active' },
    lastCheckedAt:   { type: Date },
    lastFullCheckAt: { type: Date },
    nextCheckAt:     { type: Date, default: Date.now },
    lastError:       { type: String },
  },
  { timestamps: true },
);

// Tenant-scoped listing, newest first
tariffMonitorSchema.index({ orgId: 1, userId: 1, createdAt: -1 });
// Scheduler scan: due active monitors
tariffMonitorSchema.index({ status: 1, nextCheckAt: 1 });
// Dedupe / lookup by material
tariffMonitorSchema.index({ orgId: 1, htsCode: 1 });

export const TariffMonitor =
  (mongoose.models.TariffMonitor as Model<ITariffMonitor>) ||
  mongoose.model<ITariffMonitor>('TariffMonitor', tariffMonitorSchema, 'tariff_monitors');
