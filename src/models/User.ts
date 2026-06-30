import mongoose, { type Document, type Model, Schema } from 'mongoose';

export interface IUser extends Document {
  auth0Sub:          string;
  email:             string;
  name:              string;
  picture?:          string;
  orgId:             mongoose.Types.ObjectId;
  role:              'owner' | 'member' | 'admin';
  // Onboarding answers (collected during the welcome wizard)
  jobRole?:          string;   // e.g. "Procurement"
  importCategories?: string[]; // e.g. ["electronics", "chemicals"]
  annualSpend?:      string;   // e.g. "1m-5m"
  newsletterOptIn?:  boolean;  // marketing email consent
  // Progress tracking
  onboardingStep:    number;   // 0 = not started, 1 = wizard done, 2 = tour done
  tourCompleted:     boolean;
  tourProgress:      Map<string, boolean>;
  sampleSeeded:      boolean;
  // Usage counters — incremented at runtime, durable lifetime totals
  lastLoginAt?:      Date;
  loginCount:        number;
  classifyCount:     number;
  analyzeCount:      number;
  createdAt:         Date;
  updatedAt:         Date;
}

const userSchema = new Schema<IUser>(
  {
    auth0Sub:          { type: String, required: true, unique: true, index: true },
    email:             { type: String, required: true, unique: true, index: true },
    name:              { type: String, default: '' },
    picture:           { type: String, default: '' },
    orgId:             { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    role:              { type: String, enum: ['owner', 'member', 'admin'], default: 'owner' },
    jobRole:           { type: String, default: '' },
    importCategories:  { type: [String], default: [] },
    annualSpend:       { type: String, default: '' },
    newsletterOptIn:   { type: Boolean, default: false },
    onboardingStep:    { type: Number, default: 0 },
    tourCompleted:     { type: Boolean, default: false },
    tourProgress:      { type: Map, of: Boolean, default: {} },
    sampleSeeded:      { type: Boolean, default: false },
    lastLoginAt:       { type: Date },
    loginCount:        { type: Number, default: 0 },
    classifyCount:     { type: Number, default: 0 },
    analyzeCount:      { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const User =
  (mongoose.models.User as Model<IUser>) ||
  mongoose.model<IUser>('User', userSchema);
