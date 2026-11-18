import { Schema, model, Model } from 'mongoose';
import type { VisitMode } from '@/modules/partners/model/slot';

export type LabBookingStatus =
  | 'pending_payment' | 'confirmed' | 'sample_collected' | 'visited' | 'processing'
  | 'report_ready' | 'completed' | 'cancelled' | 'no_show';
export const LAB_BOOKING_STATUSES: LabBookingStatus[] = [
  'pending_payment', 'confirmed', 'sample_collected', 'visited', 'processing', 'report_ready', 'completed', 'cancelled', 'no_show',
];

export interface ILabBookingItem {
  catalogItemId: string;
  kind: 'test' | 'package';
  name: string;
  code?: string;
  priceMinor: number;
  mrpMinor?: number;
  gstRate: number;
  sac?: string;
  reportTatHours?: number;
}

export interface ILabBookingSlot { slotId: string; date: string; startTime: string; endTime: string; startsAt: Date }

export interface ILabReportRelease {
  path: string;
  releasedAt: Date;
  /** Whoever pressed release (member id, or `admin:<id>`). */
  releasedBy: string;
  /** The professional the report is released under (name + registration stamped on the record). */
  signer: { memberId: string; name: string; kind?: string; registrationNumber: string };
}

/** §4: an online partner-lab booking. Every state change is a compare-and-set on `status` + `statusVersion`. */
export interface IPartnerLabBooking {
  _id?: string;
  partnerId: string;
  branchId: string;
  userId: string;
  createRequestKey?: string;
  /** Hash of the create request: a resent create with a different request under the same key is refused. */
  createRequestHash?: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string; age?: number; gender?: string };
  visitMode: VisitMode;
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  slot: ILabBookingSlot;
  items: ILabBookingItem[];
  pricing: { subtotalMinor: number; couponCode?: string; discountMinor: number; payableMinor: number; commissionMinor: number; currency: 'INR' };
  settlement: { settlementAccountId: string; beneficiaryName: string; settlementSystem: 'ledger' };
  status: LabBookingStatus;
  statusVersion: number;
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentTransactionId?: string;
  walletFunding?: unknown;
  paymentDeadline: Date;
  expiryNextAt?: Date;
  expiryChecks?: number;
  cancellation?: { reason: 'timeout' | 'customer' | 'lab_reject'; note?: string; by: string; byKind: 'customer' | 'member' | 'admin' | 'system'; at: Date };
  reschedule: { version: number; pending: boolean; previousSlot?: ILabBookingSlot; reason?: string; at?: Date; by?: string };
  collector?: { memberId?: string; name: string; phone?: string };
  report: { draftFiles: string[]; releasedFiles: string[]; releases: ILabReportRelease[]; /** Q11 */ uploadKeys?: string[] };
  lifecycle: Partial<Record<'paidAt' | 'confirmedAt' | 'collectedAt' | 'visitedAt' | 'processingAt' | 'reportReadyAt' | 'completedAt' | 'cancelledAt' | 'noShowAt', Date>>;
  postPaymentCompletedFor?: string;
  /** Q14: no-shows that were rescheduled (at most one); a second no-show is final. */
  noShows?: { at?: Date; rescheduledAt: Date; by: string; byKind: 'member' | 'admin'; fromSlot: ILabBookingSlot; toSlot: ILabBookingSlot;
    requestKey: string; requestHash: string }[];
  noShowReschedules?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const slotSnapshot = new Schema<ILabBookingSlot>(
  {
    slotId: { type: String, required: true },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    startsAt: { type: Date, required: true },
  },
  { _id: false }
);

const itemSchema = new Schema<ILabBookingItem>(
  {
    catalogItemId: { type: String, required: true },
    kind: { type: String, required: true, enum: ['test', 'package'] },
    name: { type: String, required: true },
    code: { type: String },
    priceMinor: { type: Number, required: true, min: 0 },
    mrpMinor: { type: Number, min: 0 },
    gstRate: { type: Number, required: true },
    sac: { type: String },
    reportTatHours: { type: Number },
  },
  { _id: false }
);

const labBookingSchema = new Schema<IPartnerLabBooking>(
  {
    partnerId: { type: String, required: true },
    branchId: { type: String, required: true },
    userId: { type: String, required: true },
    createRequestKey: { type: String },
    createRequestHash: { type: String },
    patient: {
      kind: { type: String, required: true, enum: ['self', 'dependent'] },
      dependentId: { type: String },
      name: { type: String, required: true, trim: true },
      age: { type: Number },
      gender: { type: String },
    },
    visitMode: { type: String, required: true, enum: ['home', 'lab'] },
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      landmark: { type: String, trim: true },
    },
    slot: { type: slotSnapshot, required: true },
    items: { type: [itemSchema], required: true },
    pricing: {
      subtotalMinor: { type: Number, required: true, min: 0 },
      couponCode: { type: String },
      discountMinor: { type: Number, required: true, min: 0 },
      payableMinor: { type: Number, required: true, min: 0 },
      commissionMinor: { type: Number, required: true, default: 0 },
      currency: { type: String, required: true, default: 'INR' },
    },
    settlement: {
      settlementAccountId: { type: String, required: true },
      beneficiaryName: { type: String, required: true },
      settlementSystem: { type: String, required: true, enum: ['ledger'], default: 'ledger' },
    },
    status: { type: String, required: true, enum: [
      'pending_payment', 'confirmed', 'sample_collected', 'visited', 'processing', 'report_ready', 'completed', 'cancelled', 'no_show',
    ] },
    statusVersion: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, required: true, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
    paymentTransactionId: { type: String },
    // Same customer-money ledger as bookings (common/utils/bookingWalletFunding.ts), in rupees.
    walletFunding: {
      type: new Schema({
        total: { type: Number, required: true, min: 0 },
        revision: { type: Number, required: true, min: 0, default: 0 },
        closed: { type: Boolean, default: false },
        captures: {
          type: [new Schema({ recordId: { type: String, required: true }, amount: { type: Number, required: true, min: 0 },
            state: { type: String, required: true, enum: ['applied', 'returned'] } }, { _id: false })],
          default: [],
        },
        updatedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
    },
    paymentDeadline: { type: Date, required: true },
    expiryNextAt: { type: Date },
    expiryChecks: { type: Number },
    cancellation: {
      reason: { type: String, enum: ['timeout', 'customer', 'lab_reject'] },
      note: { type: String, trim: true },
      by: { type: String },
      byKind: { type: String, enum: ['customer', 'member', 'admin', 'system'] },
      at: { type: Date },
    },
    reschedule: {
      version: { type: Number, required: true, default: 0 },
      pending: { type: Boolean, required: true, default: false },
      previousSlot: { type: slotSnapshot },
      reason: { type: String, trim: true },
      at: { type: Date },
      by: { type: String },
    },
    collector: {
      memberId: { type: String },
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    report: {
      draftFiles: { type: [String], default: [] },
      releasedFiles: { type: [String], default: [] },
      uploadKeys: { type: [String], default: undefined },
      releases: {
        type: [new Schema({
          path: { type: String, required: true },
          releasedAt: { type: Date, required: true },
          releasedBy: { type: String, required: true },
          signer: {
            memberId: { type: String, required: true },
            name: { type: String, required: true },
            kind: { type: String },
            registrationNumber: { type: String, required: true },
          },
        }, { _id: false })],
        default: [],
      },
    },
    lifecycle: {
      paidAt: Date, confirmedAt: Date, collectedAt: Date, visitedAt: Date, processingAt: Date,
      reportReadyAt: Date, completedAt: Date, cancelledAt: Date, noShowAt: Date,
    },
    postPaymentCompletedFor: { type: String },
    noShows: {
      type: [new Schema({
        at: { type: Date }, rescheduledAt: { type: Date, required: true }, by: { type: String, required: true },
        byKind: { type: String, required: true, enum: ['member', 'admin'] }, fromSlot: { type: slotSnapshot, required: true },
        toSlot: { type: slotSnapshot, required: true }, requestKey: { type: String, required: true }, requestHash: { type: String, required: true },
      }, { _id: false })],
      default: undefined,
    },
    noShowReschedules: { type: Number },
  },
  { timestamps: true }
);

labBookingSchema.index({ userId: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });
labBookingSchema.index({ userId: 1, createdAt: -1 });
labBookingSchema.index({ partnerId: 1, branchId: 1, 'slot.startsAt': 1 });
labBookingSchema.index({ partnerId: 1, status: 1, 'slot.startsAt': 1 });
labBookingSchema.index({ status: 1, paymentStatus: 1, paymentDeadline: 1, expiryNextAt: 1 });

/** The model name is load-bearing: D1 file grants resolve `mongoose.models['PartnerLabBooking']`. */
export const PartnerLabBookingModel: Model<IPartnerLabBooking> = model<IPartnerLabBooking>(
  'PartnerLabBooking', labBookingSchema, 'partner_lab_bookings'
);
