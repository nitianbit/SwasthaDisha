import { Document } from 'mongoose';

export enum ConsumerType {
  BOOKING_REMINDER = 'bookingReminder',
  PHARMACY_ORDER_SIDE_EFFECT = 'pharmacyOrderSideEffect',
}

export type ReminderType = 'one_day' | 'thirty_minutes';
export type PharmacyOrderSideEffectType = 'subscription_sync' | 'notification';

export interface JobPayload {
  [key: string]: unknown;
}

export interface BookingReminderPayload extends JobPayload {
  bookingId: string;
  userId: string;
  reminderType: ReminderType;
}

export interface PharmacyOrderSideEffectPayload extends JobPayload {
  orderId: string;
  effect: PharmacyOrderSideEffectType;
  trigger:
    | 'order_created'
    | 'order_updated'
    | 'payment_completed'
    | 'status_changed'
    | 'order_marked_paid'
    | 'order_abandoned';
}

export interface JobDocument extends Document {
  consumer: string;
  processAfter: number;
  createdAt: Date;
  payload: JobPayload;
  uniqueId?: string;
}
