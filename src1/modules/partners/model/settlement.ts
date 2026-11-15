import { Schema, model, Model } from 'mongoose';

/**
 * Where an account's money is sent (Q5). The full account number is stored because an admin must transfer to it; it is
 * returned only to admins (see services/finance.ts projections), owners see the last four digits.
 */
export interface IPayoutDetails {
  method: 'bank' | 'upi';
  accountName?: string;
  accountNumber?: string;
  accountNumberLast4?: string;
  ifsc?: string;
  bankName?: string;
  upiId?: string;
}

/** §7a: whoever earns through the platform (a partner, or a doctor as the service provider). */
export interface ISettlementAccount {
  _id?: string;
  ownerKind: 'partner' | 'doctor';
  /** partnerId or specialistId */
  ownerId: string;
  beneficiaryName: string;
  /** Q5: current payout destination; every change bumps the version and clears verification. */
  payoutDetails?: IPayoutDetails;
  payoutDetailsVersion: number;
  payoutDetailsState: 'none' | 'unverified' | 'verified';
  payoutDetailsChangedAt?: Date;
  payoutDetailsVerifiedAt?: Date;
  payoutDetailsVerifiedBy?: string;
  /**
   * Q5 serialization point for everything that spends or corrects the balance (payout, void, adjustment, details
   * change): each bumps it inside its transaction, so two of them never decide on the same balance.
   */
  financeVersion: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const settlementAccountSchema = new Schema<ISettlementAccount>(
  {
    ownerKind: { type: String, required: true, enum: ['partner', 'doctor'] },
    ownerId: { type: String, required: true },
    beneficiaryName: { type: String, required: true, trim: true },
    payoutDetails: {
      type: new Schema<IPayoutDetails>({
        method: { type: String, required: true, enum: ['bank', 'upi'] },
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        accountNumberLast4: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        bankName: { type: String, trim: true },
        upiId: { type: String, trim: true, lowercase: true },
      }, { _id: false }),
      default: undefined,
    },
    payoutDetailsVersion: { type: Number, required: true, default: 0 },
    payoutDetailsState: { type: String, required: true, enum: ['none', 'unverified', 'verified'], default: 'none' },
    payoutDetailsChangedAt: Date,
    payoutDetailsVerifiedAt: Date,
    payoutDetailsVerifiedBy: String,
    financeVersion: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

settlementAccountSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });

export const SettlementAccountModel: Model<ISettlementAccount> = model<ISettlementAccount>(
  'SettlementAccount', settlementAccountSchema, 'settlement_accounts'
);

export type LedgerEntryKind = 'earning' | 'reversal' | 'payout' | 'adjustment';

/** §7: append-only; balance = Σ amountMinor (earning +, reversal −, payout −, adjustment ±). */
export interface ILedgerEntry {
  _id?: string;
  settlementAccountId: string;
  kind: LedgerEntryKind;
  /** Signed paise. */
  amountMinor: number;
  grossMinor: number;
  commissionMinor: number;
  /** What produced the entry, e.g. 'partner_lab_booking', 'consultation', 'admin_payout'. */
  source: string;
  sourceId: string;
  reference?: string;
  note?: string;
  at: Date;
  by: string;
  byKind: 'system' | 'admin';
}

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    settlementAccountId: { type: String, required: true },
    kind: { type: String, required: true, enum: ['earning', 'reversal', 'payout', 'adjustment'] },
    amountMinor: { type: Number, required: true, validate: Number.isSafeInteger },
    grossMinor: { type: Number, required: true, validate: Number.isSafeInteger },
    commissionMinor: { type: Number, required: true, default: 0, validate: Number.isSafeInteger },
    source: { type: String, required: true },
    sourceId: { type: String, required: true },
    reference: { type: String, trim: true },
    note: { type: String, trim: true },
    at: { type: Date, required: true },
    by: { type: String, required: true },
    byKind: { type: String, required: true, enum: ['system', 'admin'] },
  },
  { versionKey: false }
);

ledgerEntrySchema.index({ settlementAccountId: 1, source: 1, sourceId: 1, kind: 1 }, { unique: true });
ledgerEntrySchema.index({ settlementAccountId: 1, at: -1 });

export const LedgerEntryModel: Model<ILedgerEntry> = model<ILedgerEntry>('LedgerEntry', ledgerEntrySchema, 'ledger_entries');

/** §7a step 4: legacy payout history shown for context; never part of the balance and never payable. */
export interface ILedgerHistoryRef {
  _id?: string;
  settlementAccountId: string;
  source: 'legacy_import';
  legacyKind: 'billing' | 'disbursal';
  legacyId: string;
  periodLabel?: string;
  amountMinor: number;
  at: Date;
}

const ledgerHistoryRefSchema = new Schema<ILedgerHistoryRef>(
  {
    settlementAccountId: { type: String, required: true },
    source: { type: String, required: true, enum: ['legacy_import'] },
    legacyKind: { type: String, required: true, enum: ['billing', 'disbursal'] },
    legacyId: { type: String, required: true },
    periodLabel: { type: String },
    amountMinor: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false }
);

ledgerHistoryRefSchema.index({ legacyKind: 1, legacyId: 1 }, { unique: true });
ledgerHistoryRefSchema.index({ settlementAccountId: 1, at: -1 });

export const LedgerHistoryRefModel: Model<ILedgerHistoryRef> = model<ILedgerHistoryRef>(
  'LedgerHistoryRef', ledgerHistoryRefSchema, 'ledger_history_refs'
);

/**
 * Q5: a transfer an admin made outside the platform and recorded here (automated bank payouts are out of scope). The
 * ledger `payout` entry (source 'payout', sourceId = this id) is what moves the balance; voiding posts a compensating
 * `adjustment` (source 'payout_void') — nothing is deleted.
 */
export interface ISettlementPayout {
  _id?: string;
  settlementAccountId: string;
  amountMinor: number;
  method: 'bank_transfer' | 'upi' | 'other';
  /** Bank UTR / UPI reference; unique per account among recorded payouts. */
  reference: string;
  /** India date the money was sent, YYYY-MM-DD. */
  paidOn: string;
  note?: string;
  /** The destination it was sent to (masked) and the details version the admin confirmed. */
  destination: { method: 'bank' | 'upi'; label: string; detailsVersion: number };
  state: 'recorded' | 'voided';
  voidReason?: string;
  voidedAt?: Date;
  voidedBy?: string;
  by: string;
  requestKey: string;
  requestHash: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const settlementPayoutSchema = new Schema<ISettlementPayout>(
  {
    settlementAccountId: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    method: { type: String, required: true, enum: ['bank_transfer', 'upi', 'other'] },
    reference: { type: String, required: true, trim: true },
    paidOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    note: { type: String, trim: true },
    destination: {
      method: { type: String, required: true, enum: ['bank', 'upi'] },
      label: { type: String, required: true },
      detailsVersion: { type: Number, required: true },
    },
    state: { type: String, required: true, enum: ['recorded', 'voided'], default: 'recorded' },
    voidReason: { type: String, trim: true },
    voidedAt: Date,
    voidedBy: String,
    by: { type: String, required: true },
    requestKey: { type: String, required: true },
    requestHash: { type: String, required: true },
  },
  { timestamps: true }
);

settlementPayoutSchema.index({ by: 1, requestKey: 1 }, { unique: true });
settlementPayoutSchema.index({ settlementAccountId: 1, reference: 1 }, { unique: true, partialFilterExpression: { state: 'recorded' } });
settlementPayoutSchema.index({ settlementAccountId: 1, createdAt: -1 });
settlementPayoutSchema.index({ paidOn: -1 });

export const SettlementPayoutModel: Model<ISettlementPayout> = model<ISettlementPayout>(
  'SettlementPayout', settlementPayoutSchema, 'settlement_payouts'
);

/** Q5 finance audit for every settlement account (doctor accounts have no partner audit log). */
export interface ISettlementEvent {
  _id?: string;
  settlementAccountId: string;
  action: string;
  byKind: 'admin' | 'member' | 'doctor';
  by: string;
  detail?: Record<string, unknown>;
  at: Date;
}

const settlementEventSchema = new Schema<ISettlementEvent>(
  {
    settlementAccountId: { type: String, required: true },
    action: { type: String, required: true },
    byKind: { type: String, required: true, enum: ['admin', 'member', 'doctor'] },
    by: { type: String, required: true },
    detail: { type: Schema.Types.Mixed },
    at: { type: Date, required: true },
  },
  { versionKey: false }
);
settlementEventSchema.index({ settlementAccountId: 1, at: -1 });

export const SettlementEventModel: Model<ISettlementEvent> = model<ISettlementEvent>(
  'SettlementEvent', settlementEventSchema, 'settlement_events'
);
