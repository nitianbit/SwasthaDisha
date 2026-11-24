import { Schema, model, Model } from 'mongoose';

/**
 * r13 (round 2d, §24.7.1, L2): the wallet store of labs (and, from phase 3, doctors). A parallel store beside the
 * pharmacy's (`pharmacy_wallets`, untouched): integer paise only, one wallet per owner, every movement one signed
 * entry. The money rules are the shared ones (`pharmacyWallet/walletCore.ts`): balance = Σ `amountMinor` of the entries,
 * withdrawable = Σ eligible lots (`wallet_topup_lots`, `walletRef.kind: 'lab'`), a receivable only while frozen.
 */
export type PartnerWalletOwnerKind = 'lab' | 'doctor';

export interface IPartnerWallet {
  _id?: string;
  ownerKind: PartnerWalletOwnerKind;
  /** The partner (lab) id, lower-cased. */
  ownerId: string;
  balanceMinor: number;
  withdrawableMinor: number;
  receivableMinor: number;
  frozen: boolean;
  frozenReason?: string;
  frozenAt?: Date;
  isActive: boolean;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PartnerWalletEntryKind = 'credit' | 'booking_debit' | 'refund_credit' | 'chargeback' | 'receivable_setoff' | 'adjustment';

export interface IPartnerWalletEntry {
  _id?: string;
  walletId: string;
  ownerKind: PartnerWalletOwnerKind;
  ownerId: string;
  kind: PartnerWalletEntryKind;
  /** Signed paise. */
  amountMinor: number;
  balanceAfterMinor: number;
  withdrawableDeltaMinor: number;
  receivableDeltaMinor: number;
  /** Exactly once per wallet. */
  operationKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  notes?: string;
  lotAllocations?: { lotId: string; amountPaise: number }[];
  /** Admin top-ups: the content hash under the Idempotency-Key. */
  requestHash?: string;
  actor?: { kind: 'admin' | 'member'; id: string };
  at: Date;
}

const walletSchema = new Schema<IPartnerWallet>({
  ownerKind: { type: String, required: true, enum: ['lab', 'doctor'] },
  ownerId: { type: String, required: true },
  balanceMinor: { type: Number, required: true, min: 0, default: 0 },
  withdrawableMinor: { type: Number, required: true, min: 0, default: 0 },
  receivableMinor: { type: Number, required: true, min: 0, default: 0 },
  frozen: { type: Boolean, required: true, default: false },
  frozenReason: { type: String, trim: true },
  frozenAt: { type: Date },
  isActive: { type: Boolean, required: true, default: true },
  version: { type: Number, required: true, default: 0 },
}, { timestamps: true, strict: 'throw' });
walletSchema.index({ ownerKind: 1, ownerId: 1 }, { unique: true });
walletSchema.index({ frozen: 1 });

const entrySchema = new Schema<IPartnerWalletEntry>({
  walletId: { type: String, required: true },
  ownerKind: { type: String, required: true, enum: ['lab', 'doctor'] },
  ownerId: { type: String, required: true },
  kind: { type: String, required: true, enum: ['credit', 'booking_debit', 'refund_credit', 'chargeback', 'receivable_setoff', 'adjustment'] },
  amountMinor: { type: Number, required: true },
  balanceAfterMinor: { type: Number, required: true, min: 0 },
  withdrawableDeltaMinor: { type: Number, required: true, default: 0 },
  receivableDeltaMinor: { type: Number, required: true, default: 0 },
  operationKey: { type: String, required: true },
  referenceType: { type: String, required: true },
  referenceId: { type: String, required: true },
  description: { type: String, required: true },
  notes: { type: String, trim: true },
  lotAllocations: {
    type: [new Schema({ lotId: { type: String, required: true }, amountPaise: { type: Number, required: true, min: 1 } }, { _id: false })],
    default: undefined,
  },
  requestHash: { type: String },
  actor: { type: new Schema({ kind: { type: String, enum: ['admin', 'member'], required: true }, id: { type: String, required: true } }, { _id: false }),
    default: undefined },
  at: { type: Date, required: true },
}, { versionKey: false, strict: 'throw' });
entrySchema.index({ walletId: 1, operationKey: 1 }, { unique: true });
// The owner's history, newest first (cursor `<at ms>_<id>`).
entrySchema.index({ ownerKind: 1, ownerId: 1, at: -1, _id: -1 });

export const PartnerWalletModel: Model<IPartnerWallet> = model<IPartnerWallet>('PartnerWallet', walletSchema, 'partner_wallets');
export const PartnerWalletEntryModel: Model<IPartnerWalletEntry> = model<IPartnerWalletEntry>('PartnerWalletEntry', entrySchema, 'partner_wallet_entries');
