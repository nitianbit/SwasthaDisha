import { model, Schema } from 'mongoose';

/**
 * Phase 5 (ASSISTED_BOOKING_DESIGN.md §27.5.1): the SMS outbox. One row is one SMS and is also its exactly-once marker:
 * unique on (bookingKind, bookingId, event, version). Rows hold ids and codes only — never a phone number, a name, the
 * text or a template variable; the text is built when the drain sends it, from the booking as it is then.
 * `bookingKind: 'admin_test'` rows record an admin's test send (bookingId = the admin), so test sends are traceable.
 */
export type SmsBookingKind = 'booking' | 'lab_booking' | 'admin_test';
export type SmsEvent = 'booked' | 'rx_ready' | 'report_ready' | 'reminder' | 'cancelled' | 'moved' | 'moved_off' | 'test';
export type SmsState = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface ISmsNotice {
  _id?: unknown;
  bookingKind: SmsBookingKind;
  bookingId: string;
  event: SmsEvent;
  version: string;
  /** Only `moved_off` (the previous holder); otherwise the booking's holder when it is sent. */
  recipientUserId?: string;
  state: SmsState;
  dueAt: Date;
  leaseUntil?: Date;
  /** Claims made (each claim is at most one gateway call). */
  attempts: number;
  message?: string;
  lang?: string;
  reason?: string;
  providerStatus?: number;
  sentAt?: Date;
  finishedAt?: Date;
  expireAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export const SMS_EVENTS: SmsEvent[] = ['booked', 'rx_ready', 'report_ready', 'reminder', 'cancelled', 'moved', 'moved_off', 'test'];

const schema = new Schema<ISmsNotice>({
  bookingKind: { type: String, required: true, enum: ['booking', 'lab_booking', 'admin_test'] },
  bookingId: { type: String, required: true },
  event: { type: String, required: true, enum: SMS_EVENTS },
  version: { type: String, required: true },
  recipientUserId: { type: String },
  state: { type: String, required: true, enum: ['queued', 'sending', 'sent', 'failed', 'skipped'] },
  dueAt: { type: Date, required: true },
  leaseUntil: { type: Date },
  attempts: { type: Number, required: true, default: 0 },
  message: { type: String },
  lang: { type: String },
  reason: { type: String },
  providerStatus: { type: Number },
  sentAt: { type: Date },
  finishedAt: { type: Date },
  expireAt: { type: Date },
}, { collection: 'sms_notices', timestamps: true, versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });

/** The marker: one SMS per booking, event and version (checked fail-closed by the enqueue and the drain). */
export const SMS_NOTICE_KEY = { bookingKind: 1, bookingId: 1, event: 1, version: 1 } as const;
schema.index(SMS_NOTICE_KEY, { unique: true });
schema.index({ state: 1, dueAt: 1 });
/** Finished rows are kept 180 days (`expireAt` is set when a row finishes). */
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const SmsNoticeModel = model<ISmsNotice>('SmsNotice', schema);

/** The fields of a row that has finished at `at` (kept 180 days). */
export const finishedFields = (at: Date) => ({ finishedAt: at, expireAt: new Date(at.getTime() + 180 * 24 * 3_600_000) });
