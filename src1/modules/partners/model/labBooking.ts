import { Schema, model, Model } from 'mongoose';
import type { VisitMode } from '@/modules/partners/model/slot';
import type { AssistedBlock } from '@/modules/assisted/types';

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

/**
 * r12 (§24.6.1): `walkIn` = a lab-desk walk-in tested now, with no seat: `startsAt` is the arrival time; `date` and
 * `startTime` are filled for display; `slotId` and `endTime` are absent (the schema requires them only for seat rows).
 */
export interface ILabBookingSlot { slotId: string; date: string; startTime: string; endTime: string; startsAt: Date; walkIn?: boolean }

/** r12 (§24.6.1): the lab front desk that booked a row (`source: 'lab_desk'`); paid at the lab, never through Jansetu. */
export interface ILabDeskBlock {
  memberId: string;
  branchId: string;
  /** `lab_desk:<partnerId>:<memberId>:<key>` (unique); the key namespace of the desk member at this lab. */
  requestKey: string;
  requestHash: string;
  arrivedAt?: Date;
  consent: { method: 'partner_attested'; statementVersion: string; statementLanguage: string; at: Date; actorId: string };
  preferredLanguage: string;
  payAtLab: true;
  notes?: string;
  /** The booking opened the patient's account (the desk's receipt says `newAccount`; its replay says it again). */
  newAccount?: boolean;
}

/** r11 (§24.4.1): who made the booking. Rows written before r11 have no `source`; readers derive `self`. */
export type LabBookingSource = 'self' | 'pharmacy_assisted' | 'doctor_assisted' | 'lab_desk';
export const LAB_BOOKING_SOURCES: LabBookingSource[] = ['self', 'pharmacy_assisted', 'doctor_assisted', 'lab_desk'];

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
  /** r11: written on every new row; missing on older rows (= self). */
  source?: LabBookingSource;
  /** r11 (§24.4.1): the partner-paid block (`assisted/types.ts`) without `join`; written only by the assisted writers. */
  assisted?: Omit<AssistedBlock, 'join'>;
  /** r12 (§24.6.1): written only by the lab desk create. */
  desk?: ILabDeskBlock;
  createRequestKey?: string;
  /** Hash of the create request: a resent create with a different request under the same key is refused. */
  createRequestHash?: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string; age?: number; gender?: string };
  visitMode: VisitMode;
  address?: { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
  slot: ILabBookingSlot;
  items: ILabBookingItem[];
  pricing: { subtotalMinor: number; couponCode?: string; discountMinor: number; payableMinor: number; commissionMinor: number; currency: 'INR' };
  /** r12: `lab_desk` = paid at the lab; no payment deadline, earning, payout or refund through Jansetu (§5.5). */
  settlement: { settlementAccountId: string; beneficiaryName: string; settlementSystem: 'ledger' | 'lab_desk' };
  status: LabBookingStatus;
  statusVersion: number;
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentTransactionId?: string;
  walletFunding?: unknown;
  /** Required unless `settlement.settlementSystem: 'lab_desk'` (desk rows store none). */
  paymentDeadline: Date;
  expiryNextAt?: Date;
  expiryChecks?: number;
  /** Q16a: 'admin_no_show' = a moved no-show cancelled by an admin; `refund` false = the money was kept (nobody earns it). */
  /** r11: `partner` / `booker` = the booking partner (pharmacy) cancelled an assisted booking (§24.4.4). */
  /** r12: `desk` = the lab desk cancelled its own desk booking (nothing to refund). */
  cancellation?: { reason: 'timeout' | 'customer' | 'lab_reject' | 'admin_no_show' | 'partner' | 'desk'; note?: string; by: string;
    byKind: 'customer' | 'member' | 'admin' | 'system' | 'booker'; at: Date;
    refund?: boolean; forfeitedMinor?: number };
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

/** r12: seat fields are required unless the row is a desk walk-in (no seat). */
function unlessWalkIn(this: { walkIn?: boolean } | undefined): boolean { return this?.walkIn !== true; }
const slotSnapshot = new Schema<ILabBookingSlot>(
  {
    slotId: { type: String, required: unlessWalkIn },
    date: { type: String, required: unlessWalkIn },
    startTime: { type: String, required: unlessWalkIn },
    endTime: { type: String, required: unlessWalkIn },
    startsAt: { type: Date, required: true },
    walkIn: { type: Boolean },
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
    source: { type: String, enum: LAB_BOOKING_SOURCES },
    assisted: { type: Schema.Types.Mixed },
    desk: {
      type: new Schema<ILabDeskBlock>({
        memberId: { type: String, required: true },
        branchId: { type: String, required: true },
        requestKey: { type: String, required: true },
        requestHash: { type: String, required: true },
        arrivedAt: { type: Date },
        consent: {
          method: { type: String, required: true, enum: ['partner_attested'] },
          statementVersion: { type: String, required: true },
          statementLanguage: { type: String, required: true },
          at: { type: Date, required: true },
          actorId: { type: String, required: true },
        },
        preferredLanguage: { type: String, required: true },
        payAtLab: { type: Boolean, required: true },
        notes: { type: String, trim: true },
        newAccount: { type: Boolean },
      }, { _id: false }),
      default: undefined,
    },
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
      settlementSystem: { type: String, required: true, enum: ['ledger', 'lab_desk'], default: 'ledger' },
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
    // r12 (§24.6.1): every row but a desk row (paid at the lab) has a payment deadline.
    paymentDeadline: { type: Date, required: function (this: { settlement?: { settlementSystem?: string } }) { return this?.settlement?.settlementSystem !== 'lab_desk'; } },
    expiryNextAt: { type: Date },
    expiryChecks: { type: Number },
    cancellation: {
      reason: { type: String, enum: ['timeout', 'customer', 'lab_reject', 'admin_no_show', 'partner', 'desk'] },
      note: { type: String, trim: true },
      by: { type: String },
      byKind: { type: String, enum: ['customer', 'member', 'admin', 'system', 'booker'] },
      at: { type: Date },
      refund: { type: Boolean },
      forfeitedMinor: { type: Number, min: 0 },
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
// r11 (§24.4.1): assisted rows — one per booker request key, one per short ref, and the booker's own list.
labBookingSchema.index({ 'assisted.requestKey': 1 }, { unique: true, partialFilterExpression: { 'assisted.requestKey': { $type: 'string' } } });
labBookingSchema.index({ 'assisted.shortRef': 1 }, { unique: true, partialFilterExpression: { 'assisted.shortRef': { $type: 'string' } } });
labBookingSchema.index({ 'assisted.bookedBy.kind': 1, 'assisted.bookedBy.id': 1, createdAt: -1, _id: -1 });
// r12 (§24.6.1): one desk row per desk request key; a lab's rows by source.
labBookingSchema.index({ 'desk.requestKey': 1 }, { unique: true, partialFilterExpression: { 'desk.requestKey': { $type: 'string' } } });
labBookingSchema.index({ partnerId: 1, source: 1, createdAt: -1 });

/** The model name is load-bearing: D1 file grants resolve `mongoose.models['PartnerLabBooking']`. */
export const PartnerLabBookingModel: Model<IPartnerLabBooking> = model<IPartnerLabBooking>(
  'PartnerLabBooking', labBookingSchema, 'partner_lab_bookings'
);
