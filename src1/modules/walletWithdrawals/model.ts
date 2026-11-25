import { Schema, model, Model } from 'mongoose';

/**
 * Round 4d (§26.8.1): a withdrawal of card money from a partner wallet (pharmacy, lab, doctor) to its home account's
 * verified payout destination, paid by an admin like a payout. The wallet is debited at the request by a
 * `withdrawal_hold` (only lots withdrawable now), given back by `withdrawal_release` (cancel, reject) or `withdrawal_void`
 * (a paid transfer that bounced). Owner decision 25 Nov: the card fee of the money withdrawn is deducted ONLY on unspent
 * card money (each lot's fee in proportion to what is withdrawn from it); money spent on bookings never pays a fee.
 */
export type WithdrawalState = 'requested' | 'cancelled' | 'rejected' | 'paid' | 'voided';
export type WithdrawalWalletKind = 'pharmacy' | 'lab' | 'doctor';

export interface IWalletWithdrawal {
  _id?: string;
  walletRef: { kind: WithdrawalWalletKind; id: string };
  requestedBy: { kind: 'pharmacy' | 'member' | 'doctor'; id: string };
  /** What leaves the wallet; `feeMinor` = Σ lot fees; `transferMinor` = gross − fee (what reaches the bank). Paise. */
  grossMinor: number;
  feeMinor: number;
  transferMinor: number;
  lotAllocations: { lotId: string; amountMinor: number; feeMinor: number }[];
  state: WithdrawalState;
  destination: { homeAccountId: string; detailsVersion: number; masked: string };
  holdEntryId: string;
  releaseEntryId?: string;
  voidEntryId?: string;
  paid?: { method: 'bank_transfer' | 'upi'; reference: string; paidOn: string; note?: string; by: string; at: Date; detailsVersion: number;
    requestKey: string; requestHash: string };
  reason?: string;
  requestKey: string;
  requestHash: string;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const withdrawalSchema = new Schema<IWalletWithdrawal>({
  walletRef: { kind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] }, id: { type: String, required: true } },
  requestedBy: { kind: { type: String, required: true, enum: ['pharmacy', 'member', 'doctor'] }, id: { type: String, required: true } },
  grossMinor: { type: Number, required: true, min: 1 },
  feeMinor: { type: Number, required: true, min: 0 },
  transferMinor: { type: Number, required: true, min: 0 },
  lotAllocations: { type: [new Schema({ lotId: { type: String, required: true }, amountMinor: { type: Number, required: true, min: 1 },
    feeMinor: { type: Number, required: true, min: 0 } }, { _id: false })], required: true },
  state: { type: String, required: true, enum: ['requested', 'cancelled', 'rejected', 'paid', 'voided'] },
  destination: { homeAccountId: { type: String, required: true }, detailsVersion: { type: Number, required: true }, masked: { type: String, required: true } },
  holdEntryId: { type: String, required: true },
  releaseEntryId: { type: String },
  voidEntryId: { type: String },
  paid: {
    type: new Schema({ method: { type: String, required: true, enum: ['bank_transfer', 'upi'] }, reference: { type: String, required: true },
      paidOn: { type: String, required: true }, note: { type: String }, by: { type: String, required: true }, at: { type: Date, required: true },
      detailsVersion: { type: Number, required: true }, requestKey: { type: String, required: true }, requestHash: { type: String, required: true } }, { _id: false }),
    default: undefined,
  },
  reason: { type: String, trim: true },
  requestKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  version: { type: Number, required: true, default: 0 },
}, { timestamps: true, strict: 'throw' });
// §26.8.5: one withdrawal per (wallet, request key); a transfer reference (UTR) once per home account.
withdrawalSchema.index({ 'walletRef.kind': 1, 'walletRef.id': 1, requestKey: 1 }, { unique: true });
withdrawalSchema.index({ 'destination.homeAccountId': 1, 'paid.reference': 1 }, { unique: true, partialFilterExpression: { 'paid.reference': { $type: 'string' } } });
withdrawalSchema.index({ state: 1, createdAt: 1 });
withdrawalSchema.index({ 'walletRef.kind': 1, 'walletRef.id': 1, createdAt: -1 });

export const WalletWithdrawalModel: Model<IWalletWithdrawal> = model<IWalletWithdrawal>('WalletWithdrawal', withdrawalSchema, 'wallet_withdrawals');
