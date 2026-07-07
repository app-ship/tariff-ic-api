import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type EnterpriseLeadStatus = 'new' | 'contacted' | 'closed';

export interface IEnterpriseLead extends Document {
  companyName:     string;
  companySize:     string;
  useCase:         string;
  expectedVolume:  string;
  contactName:     string;
  email:           string;
  /** orgId of the logged-in org the lead was submitted from, if any (visitors can be logged out). */
  orgId?:          string;
  source:          string;
  status:          EnterpriseLeadStatus;
  createdAt:       Date;
  updatedAt:       Date;
}

const enterpriseLeadSchema = new Schema<IEnterpriseLead>(
  {
    companyName:    { type: String, required: true },
    companySize:    { type: String, default: '' },
    useCase:        { type: String, default: '' },
    expectedVolume: { type: String, default: '' },
    contactName:    { type: String, required: true },
    email:          { type: String, required: true, lowercase: true, trim: true, index: true },
    orgId:          { type: String, index: true },
    source:         { type: String, default: 'pricing' },
    status:         { type: String, enum: ['new', 'contacted', 'closed'], default: 'new' },
  },
  { timestamps: true },
);

enterpriseLeadSchema.index({ createdAt: -1 });

export const EnterpriseLead =
  (mongoose.models.EnterpriseLead as Model<IEnterpriseLead>) ||
  mongoose.model<IEnterpriseLead>('EnterpriseLead', enterpriseLeadSchema, 'enterprise_leads');
