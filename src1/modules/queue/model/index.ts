import { JobDocument } from '@/modules/queue/types';
import { model, Schema } from 'mongoose';

const JobSchema = new Schema<JobDocument>({
  consumer: { type: String, required: true, index: true },
  processAfter: { type: Number, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  payload: { type: Schema.Types.Mixed, required: true },
  uniqueId: { type: String },
});

JobSchema.index({ consumer: 1, processAfter: 1 });
JobSchema.index(
  { consumer: 1, uniqueId: 1 },
  { unique: true, partialFilterExpression: { uniqueId: { $exists: true } } }
);

export const Job = model<JobDocument>('Job', JobSchema);
