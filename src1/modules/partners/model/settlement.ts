import { Schema, model, Model } from 'mongoose';

/** §7a: whoever earns through the platform (a partner, or a doctor as the service provider). */
export interface ISettlementAccount {
  _id?: string;
  ownerKind: 'partner' | 'doctor';
  /** partnerId or specialistId */
  ownerId: string;
  beneficiaryName: string;
  bankDetails?: { accountName?: string; accountNumberLast4?: string; ifsc?: string; upiId?: string };
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const settlementAccountSchema = new Schema<ISettlementAccount>(
  {
    ownerKind: { type: String, required: true, enum: ['partner', 'doctor'] },
    ownerId: { type: String, required: true },
    beneficiaryName: { type: String, required: true, trim: true },
    bankDetails: {
      accountName: { type: String, trim: true },
      accountNumberLast4: { type: String, trim: true },
      ifsc: { type: String, trim: true },
      upiId: { type: String, trim: true },
    },
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
