import { Schema, model, Model } from 'mongoose';

/**
 * Assisted booking (§6.1): audit of assisted actions by pharmacies and doctors (partner members use PartnerAuditEvent),
 * written in the action's own transaction. Ids and codes only: no names, phones or clinical text.
 * Phase 0 writes `rx_order.created` (a medicine order made from a booking's prescription).
 */
/** Phase 0: rx_order.created. Phase 1a: the assisted booking actions (each audited in its own transaction). */
export const ASSISTED_AUDIT_ACTIONS = ['rx_order.created', 'patient.lookup', 'booking.attempted', 'booking.created', 'booking.cancelled', 'booking.rescheduled',
  'booking.not_mine', 'booking.moved', 'review.dismissed', 'wallet.frozen', 'wallet.unfrozen', 'wallet.chargeback', 'customer.typed_name',
  /** r9: an admin closed a pharmacy card top-up as already compensated by hand (never credited). */
  'wallet.closed_compensated',
  /** Phase 1b: a card payment confirmed the booking; a late capture was sent back; a card dispute was recorded; an admin
   *  moved a failed card refund to the partner's wallet with its recorded agreement. */
  'booking.paid', 'booking.late_capture', 'booking.card_chargeback', 'card_refund.to_wallet'] as const;
export type AssistedAuditAction = typeof ASSISTED_AUDIT_ACTIONS[number];

export interface IAssistedAuditEvent {
  at: Date;
  actorKind: 'pharmacy' | 'doctor' | 'admin' | 'customer';
  actorId: string;
  orgKind: 'pharmacy' | 'lab' | 'doctor';
  orgId: string;
  action: AssistedAuditAction;
  bookingId?: string;
  orderId?: string;
  requestKey?: string;
  detail?: Record<string, unknown>;
}

const auditSchema = new Schema<IAssistedAuditEvent>({
  at: { type: Date, required: true },
  actorKind: { type: String, required: true, enum: ['pharmacy', 'doctor', 'admin', 'customer'] },
  actorId: { type: String, required: true },
  orgKind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] },
  orgId: { type: String, required: true },
  action: { type: String, required: true, enum: ASSISTED_AUDIT_ACTIONS },
  bookingId: { type: String },
  orderId: { type: String },
  requestKey: { type: String },
  detail: { type: Schema.Types.Mixed },
}, { versionKey: false, strict: 'throw' });
auditSchema.index({ orgKind: 1, orgId: 1, at: -1 });
auditSchema.index({ bookingId: 1, at: -1 });

export const AssistedAuditEventModel: Model<IAssistedAuditEvent> = model<IAssistedAuditEvent>(
  'AssistedAuditEvent', auditSchema, 'assisted_audit_events');

export default AssistedAuditEventModel;

/**
 * Phase 1a (§6.2, §8.7, P7): fixed-window counters per organisation, phone or booker–doctor pair, shared by every API
 * instance (atomic `$inc`, the O1 pattern). Keys hold ids and HMAC'd phones only. Expired windows are removed by TTL.
 */
export interface IAssistedCounter { _id: string; count: number; expireAt: Date }
const counterSchema = new Schema<IAssistedCounter>({
  _id: { type: String, required: true },
  count: { type: Number, required: true },
  expireAt: { type: Date, required: true },
}, { versionKey: false, strict: 'throw' });
counterSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const AssistedCounterModel: Model<IAssistedCounter> = model<IAssistedCounter>('AssistedCounter', counterSchema, 'assisted_counters');

/**
 * Phase 1a (§8.7, P10): alerts for admins (abuse thresholds, reconciliation mismatches). One row per `key` (an alert
 * is raised once per subject and day); admins read them with the daily reconciliation report.
 */
export interface IAssistedAlert {
  key: string; kind: string; bookerKind?: string; bookerId?: string; day: string; detail?: Record<string, unknown>;
  at: Date; acknowledgedAt?: Date; acknowledgedBy?: string;
}
const alertSchema = new Schema<IAssistedAlert>({
  key: { type: String, required: true },
  kind: { type: String, required: true },
  bookerKind: { type: String },
  bookerId: { type: String },
  day: { type: String, required: true },
  detail: { type: Schema.Types.Mixed },
  at: { type: Date, required: true },
  acknowledgedAt: { type: Date },
  acknowledgedBy: { type: String },
}, { versionKey: false, strict: 'throw' });
alertSchema.index({ key: 1 }, { unique: true });
alertSchema.index({ day: -1, at: -1 });
export const AssistedAlertModel: Model<IAssistedAlert> = model<IAssistedAlert>('AssistedAlert', alertSchema, 'assisted_alerts');

/** Phase 1a (§17.5): the admins' "this isn't mine" queue. One open item per booking. */
export interface IAssistedReviewItem {
  kind: 'not_mine'; bookingKind: 'booking' | 'lab_booking'; bookingId: string; reportedBy: string; note?: string;
  state: 'open' | 'moved' | 'dismissed'; at: Date; resolvedAt?: Date; resolvedBy?: string; resolution?: string;
}
const reviewSchema = new Schema<IAssistedReviewItem>({
  kind: { type: String, required: true, enum: ['not_mine'] },
  bookingKind: { type: String, required: true, enum: ['booking', 'lab_booking'] },
  bookingId: { type: String, required: true },
  reportedBy: { type: String, required: true },
  note: { type: String },
  state: { type: String, required: true, enum: ['open', 'moved', 'dismissed'] },
  at: { type: Date, required: true },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
  resolution: { type: String },
}, { versionKey: false, strict: 'throw' });
reviewSchema.index({ bookingKind: 1, bookingId: 1 }, { unique: true });
reviewSchema.index({ state: 1, at: -1 });
export const AssistedReviewItemModel: Model<IAssistedReviewItem> = model<IAssistedReviewItem>('AssistedReviewItem', reviewSchema, 'assisted_review_items');

/** Phase 1a (§8.8): the stored daily reconciliation report (one per IST day; the admin route can also run it live). */
export interface IAssistedReconciliationReport { day: string; at: Date; ok: boolean; checks: Record<string, unknown>; stuck: Record<string, unknown> }
const reportSchema = new Schema<IAssistedReconciliationReport>({
  day: { type: String, required: true },
  at: { type: Date, required: true },
  ok: { type: Boolean, required: true },
  checks: { type: Schema.Types.Mixed, required: true },
  stuck: { type: Schema.Types.Mixed, required: true },
}, { versionKey: false, strict: 'throw' });
reportSchema.index({ day: 1 }, { unique: true });
export const AssistedReconciliationReportModel: Model<IAssistedReconciliationReport> = model<IAssistedReconciliationReport>(
  'AssistedReconciliationReport', reportSchema, 'assisted_reconciliation_reports');

/**
 * Phase 1b (§6.4, §8.4): one row per card capture that goes back to its payer — the cancellation refund of a card-paid
 * booking, or a late capture (on a booking that expired, was cancelled or could not take it). Unique per payment record,
 * so a capture is returned at most once whatever path finds it. `method: 'razorpay'` rows are sent by the refund worker
 * (fenced attempts, lookup before resubmit, `pharmacyOrders/prescriptionRefund.ts` pattern); `wallet` rows (the partner's
 * choice at its own cancel) post a non-withdrawable wallet credit in the creating transaction. `failed` and `manual_review`
 * rows (and pending rows over the attempt cap) are the operator queue.
 */
export interface IAssistedCardRefund {
  _id: unknown;
  bookingId: string;
  paymentRecordId: string;
  razorpayPaymentId?: string;
  amountMinor: number;
  /** booker | patient | doctor | admin | late_capture */
  cause: string;
  payerKind: 'pharmacy';
  payerId: string;
  method: 'razorpay' | 'wallet';
  state: 'pending' | 'processed' | 'failed' | 'manual_review';
  walletEntryId?: string;
  attemptId?: string;
  leaseUntil?: Date;
  attempts: number;
  submissions: number;
  razorpayRefundId?: string;
  razorpayStatus?: string;
  lastError?: string;
  processedAt?: Date;
  /** An admin moved a failed card refund to the partner's wallet (with the partner's recorded agreement). */
  resolution?: { by: string; agreement: string; at: Date; walletEntryId: string };
  createdAt?: Date;
  updatedAt?: Date;
}
const cardRefundSchema = new Schema<IAssistedCardRefund>({
  _id: { type: Schema.Types.ObjectId, required: true },
  bookingId: { type: String, required: true },
  paymentRecordId: { type: String, required: true },
  razorpayPaymentId: { type: String },
  amountMinor: { type: Number, required: true, min: 1 },
  cause: { type: String, required: true },
  payerKind: { type: String, required: true, enum: ['pharmacy'] },
  payerId: { type: String, required: true },
  method: { type: String, required: true, enum: ['razorpay', 'wallet'] },
  state: { type: String, required: true, enum: ['pending', 'processed', 'failed', 'manual_review'] },
  walletEntryId: { type: String },
  attemptId: { type: String },
  leaseUntil: { type: Date },
  attempts: { type: Number, required: true, default: 0 },
  submissions: { type: Number, required: true, default: 0 },
  razorpayRefundId: { type: String },
  razorpayStatus: { type: String },
  lastError: { type: String },
  processedAt: { type: Date },
  resolution: { type: new Schema({ by: { type: String, required: true }, agreement: { type: String, required: true }, at: { type: Date, required: true },
    walletEntryId: { type: String, required: true } }, { _id: false }), default: undefined },
}, { versionKey: false, strict: 'throw', timestamps: true });
cardRefundSchema.index({ paymentRecordId: 1 }, { unique: true });
cardRefundSchema.index({ bookingId: 1 });
cardRefundSchema.index({ state: 1, updatedAt: 1 });
export const AssistedCardRefundModel: Model<IAssistedCardRefund> = model<IAssistedCardRefund>('AssistedCardRefund', cardRefundSchema, 'assisted_card_refunds');
