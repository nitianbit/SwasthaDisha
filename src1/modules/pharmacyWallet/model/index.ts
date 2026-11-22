import { Schema, model, Model } from 'mongoose';
import { IPharmacyWallet, IPharmacyWalletTransaction } from '@/modules/pharmacyWallet/types';

const pharmacyWalletSchema = new Schema<IPharmacyWallet>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, unique: true, index: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    balancePaise: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    // Assisted booking phase 1a (§5.3, §17.3). Paise; `balancePaise` is authoritative and equals Σ signedAmountPaise.
    withdrawableMinor: { type: Number, min: 0 },
    receivableMinor: { type: Number, min: 0 },
    frozen: { type: Boolean },
    frozenReason: { type: String, trim: true },
    frozenAt: { type: Date },
    version: { type: Number },
    ledgerOpenedAt: { type: Date },
  },
  { timestamps: true }
);
pharmacyWalletSchema.index({ frozen: 1 });

const pharmacyWalletTransactionSchema = new Schema<IPharmacyWalletTransaction>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    walletId: { type: Schema.Types.ObjectId as any, ref: 'PharmacyWallet', required: true, index: true },
    transactionType: {
      type: String,
      enum: ['credit', 'debit', 'consultation_payment', 'refund', 'adjustment',
        // Assisted booking phase 1a (§17.3).
        'booking_debit', 'refund_credit', 'withdrawal_hold', 'withdrawal_release', 'withdrawal_void', 'chargeback', 'receivable_setoff',
        'opening_balance'],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    amountPaise: { type: Number, min: 0 },
    balanceBefore: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true, min: 0 },
    balanceBeforePaise: { type: Number, min: 0 },
    balanceAfterPaise: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'completed',
      index: true,
    },
    referenceType: { type: String, trim: true },
    referenceId: { type: String, trim: true },
    description: { type: String, trim: true },
    notes: { type: String, trim: true },
    transactionDate: { type: String, match: /^\d{8}$/ },
    // Assisted booking phase 1a (§17.3): signed paise (every new row; old rows filled by the migration), the exactly-once
    // key of the movement, the change to the withdrawable amount and the top-up lots a spend used (or a refund restored).
    signedAmountPaise: { type: Number },
    operationKey: { type: String },
    withdrawableDeltaPaise: { type: Number },
    // Chargebacks: the change to what the partner owes (`receivableMinor`).
    receivableDeltaPaise: { type: Number },
    lotAllocations: {
      type: [new Schema({ lotId: { type: String, required: true }, amountPaise: { type: Number, required: true, min: 1 } }, { _id: false })],
      default: undefined,
    },
    // Admin top-ups: content hash under the Idempotency-Key, and the admin who credited it.
    requestHash: { type: String },
    actor: { type: new Schema({ kind: { type: String, enum: ['admin'], required: true }, id: { type: String, required: true } }, { _id: false }), default: undefined },
  },
  { timestamps: true }
);

pharmacyWalletTransactionSchema.index({ pharmacyId: 1, createdAt: -1 });
pharmacyWalletTransactionSchema.index({ pharmacyId: 1, transactionType: 1 });
pharmacyWalletTransactionSchema.index(
  { pharmacyId: 1, referenceType: 1, referenceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      referenceType: { $exists: true, $type: 'string' },
      referenceId: { $exists: true, $type: 'string' },
    },
  }
);

// §17.3: one movement per (pharmacy, operation key); writers check it fail-closed before posting.
pharmacyWalletTransactionSchema.index({ pharmacyId: 1, operationKey: 1 }, { unique: true, partialFilterExpression: { operationKey: { $type: 'string' } } });

export const PharmacyWalletModel: Model<IPharmacyWallet> = model<IPharmacyWallet>(
  'PharmacyWallet',
  pharmacyWalletSchema
);

export const PharmacyWalletTransactionModel: Model<IPharmacyWalletTransaction> = model<IPharmacyWalletTransaction>(
  'PharmacyWalletTransaction',
  pharmacyWalletTransactionSchema
);
