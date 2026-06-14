import mongoose, { type Document, type Model, Schema } from 'mongoose';

export type NotificationType = 'tariff_change' | 'analysis';

/** Lifecycle status for analysis notifications (classify/analyze jobs). */
export type NotificationStatus = 'running' | 'complete' | 'error';

/** Per-country detail describing what changed, surfaced in the UI. */
export interface INotificationChangeDetail {
  country:       string;
  field:         string;
  previousValue: number | string | null;
  newValue:      number | string | null;
}

export interface INotification extends Document {
  orgId:        string;
  userId:       string;
  type:         NotificationType;
  /** Monitor that triggered this notification (tariff_change only). */
  monitorId?:   string;
  htsCode:      string;
  materialName: string;
  title:        string;
  body:         string;
  changeDetail: INotificationChangeDetail[];
  read:         boolean;
  // ── Analysis-job notifications ────────────────────────────────────────────
  /** 'running' | 'complete' | 'error' for analysis notifications. */
  status?:      NotificationStatus;
  /** The classify/analyze job this notification tracks. */
  jobId?:       string;
  jobType?:     'classify' | 'analyze';
  /** MaterialSearch record to open when the notification is clicked. */
  searchId?:    string;
  createdAt:    Date;
  updatedAt:    Date;
}

const changeDetailSchema = new Schema<INotificationChangeDetail>(
  {
    country:       { type: String, required: true },
    field:         { type: String, required: true },
    previousValue: { type: Schema.Types.Mixed, default: null },
    newValue:      { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const notificationSchema = new Schema<INotification>(
  {
    orgId:        { type: String, required: true },
    userId:       { type: String, required: true },
    type:         { type: String, enum: ['tariff_change', 'analysis'], default: 'tariff_change' },
    monitorId:    { type: String },
    htsCode:      { type: String, default: '' },
    materialName: { type: String, default: '' },
    title:        { type: String, required: true },
    body:         { type: String, default: '' },
    changeDetail: { type: [changeDetailSchema], default: [] },
    read:         { type: Boolean, default: false },
    status:       { type: String, enum: ['running', 'complete', 'error'] },
    jobId:        { type: String },
    jobType:      { type: String, enum: ['classify', 'analyze'] },
    searchId:     { type: String },
  },
  { timestamps: true },
);

// Unread badge + paginated inbox per user, newest first
notificationSchema.index({ orgId: 1, userId: 1, read: 1, createdAt: -1 });
// Fast lookup of an analysis notification by its job for status updates
notificationSchema.index({ orgId: 1, jobId: 1 });
// Auto-expire notifications after 180 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const Notification =
  (mongoose.models.Notification as Model<INotification>) ||
  mongoose.model<INotification>('Notification', notificationSchema, 'notifications');
