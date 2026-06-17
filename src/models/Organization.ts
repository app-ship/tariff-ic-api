import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';

export interface IOrganization extends Document {
  name:                 string;
  slug:                 string;
  ownerUserId:          string;      // auth0Sub of the owner
  plan:                 'sandbox' | 'starter' | 'pro';
  industry?:            string;      // collected during onboarding
  annualSpend?:         string;      // collected during onboarding
  // ── Billing (Stripe) ──────────────────────────────────────────────────────
  stripeCustomerId?:    string;
  stripeSubscriptionId?:string;
  subscriptionStatus?:  SubscriptionStatus;
  currentPeriodEnd?:    Date;
  createdAt:            Date;
  updatedAt:            Date;
}

const orgSchema = new Schema<IOrganization>(
  {
    name:                 { type: String, required: true },
    slug:                 { type: String, required: true, unique: true, lowercase: true, index: true },
    ownerUserId:          { type: String, required: true, index: true },
    plan:                 { type: String, enum: ['sandbox', 'starter', 'pro'], default: 'sandbox' },
    industry:             { type: String, default: '' },
    annualSpend:          { type: String, default: '' },
    stripeCustomerId:     { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true },
    subscriptionStatus:   { type: String, enum: ['active', 'past_due', 'canceled'] },
    currentPeriodEnd:     { type: Date },
  },
  { timestamps: true },
);

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

orgSchema.statics.uniqueSlug = async function (base: string): Promise<string> {
  const slug = slugify(base);
  const exists = await (this as Model<IOrganization>).findOne({ slug });
  if (!exists) return slug;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${rand}`;
};

interface OrgModel extends Model<IOrganization> {
  uniqueSlug(base: string): Promise<string>;
}

export const Organization =
  (mongoose.models.Organization as OrgModel) ||
  mongoose.model<IOrganization, OrgModel>('Organization', orgSchema);

/** A paid org is one whose plan is 'pro'. Everything else is treated as free. */
export function isProPlan(plan?: string | null): boolean {
  return plan === 'pro';
}
