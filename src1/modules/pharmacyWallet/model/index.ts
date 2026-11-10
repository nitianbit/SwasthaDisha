import { Schema, model, Model } from 'mongoose';
import { IPharmacyWallet, IPharmacyWalletTransaction } from '@/modules/pharmacyWallet/types';

const pharmacyWalletSchema = new Schema<IPharmacyWallet>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, unique: true, index: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    balancePaise: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

const pharmacyWalletTransactionSchema = new Schema<IPharmacyWalletTransaction>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    walletId: { type: Schema.Types.ObjectId as any, ref: 'PharmacyWallet', required: true, index: true },
    transactionType: {
      type: String,
      enum: ['credit', 'debit', 'consultation_payment', 'refund', 'adjustment'],
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

export const PharmacyWalletModel: Model<IPharmacyWallet> = model<IPharmacyWallet>(
  'PharmacyWallet',
  pharmacyWalletSchema
);

export const PharmacyWalletTransactionModel: Model<IPharmacyWalletTransaction> = model<IPharmacyWalletTransaction>(
  'PharmacyWalletTransaction',
  pharmacyWalletTransactionSchema
);
