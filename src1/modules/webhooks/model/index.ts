import { model, Model, Schema } from 'mongoose';
import { IWebhook } from '@/modules/webhooks/types';

const webhookSchema = new Schema<IWebhook>(
  {
    webhookType: {
      type: String,
      enum: ['booking'],
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    headers: {
      type: Schema.Types.Mixed,
      default: {},
    },
    queryParams: {
      type: Schema.Types.Mixed,
      default: {},
    },
    method: {
      type: String,
      trim: true,
    },
    path: {
      type: String,
      trim: true,
    },
    sourceIp: {
      type: String,
      trim: true,
      index: true,
    },
    userAgent: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

webhookSchema.index({ webhookType: 1, createdAt: -1 });
webhookSchema.index({ sourceIp: 1, createdAt: -1 });

const WebhookModel: Model<IWebhook> = model<IWebhook>('Webhook', webhookSchema);

export { WebhookModel };
export default WebhookModel;
