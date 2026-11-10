import { Schema, model, Model } from 'mongoose';
import { INotification } from '@/modules/notification/types';

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    }, // User who will receive this notification
    type: {
      type: String,
      enum: [
        'login',
        'booking_created',
        'booking_confirmed',
        'booking_cancelled',
        'wallet_credit',
        'wallet_debit',
        'payment_success',
        'payment_failed',
        'reminder',
        'general',
        'specialist_login',
        'specialist_new_booking',
        'specialist_upcoming_appointment',
        'specialist_appointment_cancelled',
        'specialist_appointment_confirmed',
        'specialist_appointment_completed',
        'specialist_general',
      ],
      required: true,
      index: true,
    }, // Type of notification
    title: {
      type: String,
      required: true,
      trim: true,
    }, // Notification title
    message: {
      type: String,
      required: true,
      trim: true,
    }, // Notification message/content
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    }, // Whether notification has been read
    readAt: {
      type: Date,
    }, // When notification was read
    data: {
      type: Schema.Types.Mixed,
      default: {},
    }, // Additional data (e.g., bookingId, transactionId, amount, etc.)
    referenceType: {
      type: String,
      trim: true,
      index: true,
    }, // Type of reference: 'booking', 'wallet_transaction', 'payment', etc.
    referenceId: {
      type: String,
      trim: true,
      index: true,
    }, // ID of the reference entity
    idempotencyKey: { type: String, trim: true },
    fcmSentAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, type: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 }); // For recent notifications
notificationSchema.index({ referenceType: 1, referenceId: 1 });
notificationSchema.index({ createdAt: -1 }); // For sorting by creation date
notificationSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } },
  }
);

const NotificationModel: Model<INotification> = model<INotification>(
  'Notification',
  notificationSchema
);

export { NotificationModel };
export default NotificationModel;
