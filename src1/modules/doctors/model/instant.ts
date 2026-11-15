import { Schema, model, Model } from 'mongoose';

export type InstantMode = 'video' | 'call' | 'chat';

/** §5: a doctor's "available now" switch. Online = available + heartbeat within 2 minutes + no interval held now. */
export interface IDoctorPresence {
  _id?: string;
  doctorId: string;
  available: boolean;
  modes: InstantMode[];
  instantFeeMinor: number;
  specialization?: string;
  lastSeenAt?: Date;
  updatedAt?: Date;
}

const presenceSchema = new Schema<IDoctorPresence>(
  {
    doctorId: { type: String, required: true },
    available: { type: Boolean, required: true, default: false },
    modes: { type: [{ type: String, enum: ['video', 'call', 'chat'] }], default: [] },
    instantFeeMinor: { type: Number, required: true, min: 0 },
    specialization: { type: String },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);
presenceSchema.index({ doctorId: 1 }, { unique: true });
presenceSchema.index({ available: 1, specialization: 1, lastSeenAt: -1 });

export const DoctorPresenceModel: Model<IDoctorPresence> = model<IDoctorPresence>('DoctorPresence', presenceSchema, 'doctor_presence');

export type InstantStatus = 'pending_payment' | 'offered' | 'accepted' | 'refunded' | 'expired_unpaid';
export type FundingState = 'awaiting' | 'held' | 'allocated' | 'refunded';
export interface MoneySplit { couponMinor: number; walletMinor: number; gatewayMinor: number; totalMinor: number }

/**
 * §5 instant consultation request. The customer pays the quoted amount upfront (coupon + wallet + gateway). Acceptance
 * and refund are mutually exclusive on `fundingState` (held → allocated | refunded), both compare-and-set.
 */
export interface IInstantRequest {
  _id?: string;
  userId: string;
  createRequestKey: string;
  createRequestHash: string;
  patient: { kind: 'self' | 'dependent'; dependentId?: string; name: string; age?: number; gender?: string };
  specialization: string;
  mode: InstantMode;
  target: { kind: 'specific' | 'any'; doctorId?: string };
  quotedAmountMinor: number;
  couponCode?: string;
  discountMinor: number;
  /** What the customer put in (set when the funding is held): total == quotedAmountMinor. */
  funding?: MoneySplit;
  fundingState: FundingState;
  /** Used for the consultation (fee), coupon → wallet → gateway. */
  allocated?: MoneySplit;
  /** Quote minus fee, returned at acceptance: gateway → wallet; coupon remainder voided (not money). */
  returned?: { couponVoidedMinor: number; walletMinor: number; gatewayMinor: number; totalMinor: number };
  /** Refunded later against the allocation (never more than allocated wallet + gateway). */
  refunded?: { walletMinor: number; gatewayMinor: number; totalMinor: number };
  status: InstantStatus;
  statusVersion: number;
  /** Mirrors for the shared wallet-funding ledger (bookingWalletFunding.ts). */
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentTransactionId?: string;
  walletFunding?: unknown;
  paymentDeadline: Date;
  expiryNextAt?: Date;
  expiryChecks?: number;
  offerGeneration: number;
  offerExpiresAt?: Date;
  offeredTo: string[];
  inactivityRefundAt?: Date;
  acceptedBy?: string;
  acceptedFeeMinor?: number;
  bookingId?: string;
  refundReason?: 'customer' | 'inactivity' | 'doctor_cancelled';
  createdAt?: Date;
  updatedAt?: Date;
}

const split = { couponMinor: Number, walletMinor: Number, gatewayMinor: Number, totalMinor: Number };

const instantSchema = new Schema<IInstantRequest>(
  {
    userId: { type: String, required: true },
    createRequestKey: { type: String, required: true },
    createRequestHash: { type: String, required: true },
    patient: {
      kind: { type: String, required: true, enum: ['self', 'dependent'] },
      dependentId: String, name: { type: String, required: true }, age: Number, gender: String,
    },
    specialization: { type: String, required: true },
    mode: { type: String, required: true, enum: ['video', 'call', 'chat'] },
    target: { kind: { type: String, required: true, enum: ['specific', 'any'] }, doctorId: String },
    quotedAmountMinor: { type: Number, required: true, min: 0 },
    couponCode: String,
    discountMinor: { type: Number, required: true, default: 0, min: 0 },
    funding: split,
    fundingState: { type: String, required: true, enum: ['awaiting', 'held', 'allocated', 'refunded'] },
    allocated: split,
    returned: { couponVoidedMinor: Number, walletMinor: Number, gatewayMinor: Number, totalMinor: Number },
    refunded: { walletMinor: Number, gatewayMinor: Number, totalMinor: Number },
    status: { type: String, required: true, enum: ['pending_payment', 'offered', 'accepted', 'refunded', 'expired_unpaid'] },
    statusVersion: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, required: true, enum: ['pending', 'paid', 'refunded'] },
    paymentTransactionId: String,
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
        updatedAt: Date,
      }, { _id: false }),
      default: undefined,
    },
    paymentDeadline: { type: Date, required: true },
    expiryNextAt: Date,
    expiryChecks: Number,
    offerGeneration: { type: Number, required: true, default: 0 },
    offerExpiresAt: Date,
    offeredTo: { type: [String], default: [] },
    inactivityRefundAt: Date,
    acceptedBy: String,
    acceptedFeeMinor: Number,
    bookingId: String,
    refundReason: { type: String, enum: ['customer', 'inactivity', 'doctor_cancelled'] },
  },
  { timestamps: true }
);
instantSchema.index({ userId: 1, createRequestKey: 1 }, { unique: true });
instantSchema.index({ bookingId: 1 }, { unique: true, partialFilterExpression: { bookingId: { $type: 'string' } } });
instantSchema.index({ status: 1, offeredTo: 1, offerExpiresAt: 1 });
instantSchema.index({ status: 1, fundingState: 1, inactivityRefundAt: 1 });
instantSchema.index({ status: 1, paymentStatus: 1, paymentDeadline: 1 });

/** Model name is load-bearing for the payment/wallet ledgers that resolve it. */
export const InstantRequestModel: Model<IInstantRequest> = model<IInstantRequest>('InstantRequest', instantSchema, 'instant_requests');
