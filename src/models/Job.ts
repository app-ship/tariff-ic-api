import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type JobType   = 'classify' | 'analyze';
export type JobStatus = 'queued' | 'running' | 'complete' | 'error';

export interface IJob extends Document {
  type:     JobType;
  status:   JobStatus;
  orgId:    string;
  userId:   string;
  /** Raw request payload — opaque, stored as Mixed. */
  request:  Record<string, unknown>;
  progress: {
    completed: number;
    total:     number;
    message:   string;
  };
  /** Per-country intermediate results (analyze jobs only). */
  partials: Array<{ country: string; data?: unknown; error?: string }>;
  /** Final result blob — classify: raw DR JSON; analyze: array of per-country rows. */
  result:   unknown;
  error:    string;
  lease: {
    workerId:  string;
    expiresAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<IJob>(
  {
    type:   { type: String, enum: ['classify', 'analyze'], required: true },
    status: { type: String, enum: ['queued', 'running', 'complete', 'error'], default: 'queued', index: true },
    orgId:  { type: String, required: true, index: true },
    userId: { type: String, required: true },
    request: { type: Schema.Types.Mixed, required: true },
    progress: {
      completed: { type: Number, default: 0 },
      total:     { type: Number, default: 0 },
      message:   { type: String, default: '' },
    },
    partials: { type: [Schema.Types.Mixed], default: [] },
    result:   { type: Schema.Types.Mixed, default: null },
    error:    { type: String,  default: '' },
    lease: {
      workerId:  { type: String,  default: '' },
      expiresAt: { type: Date,    default: () => new Date(0) },
    },
  },
  { timestamps: true },
);

// Auto-expire jobs after 7 days
jobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Fast lookup for the stream endpoint
jobSchema.index({ _id: 1, orgId: 1 });

export const Job =
  (mongoose.models.Job as Model<IJob>) ||
  mongoose.model<IJob>('Job', jobSchema);
