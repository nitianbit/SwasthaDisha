import { Schema, model, Model } from 'mongoose';
import { IWallet, IWalletTransaction } from '@/modules/wallet/types';

// Wallet Schema - One wallet per user
const walletSchema = new Schema<IWallet>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    }, // User who owns this wallet (one wallet per user)
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    }, // Current wallet balance (calculated from transactions, should always be >= 0)
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    }, // Whether wallet is active
  },
  {
    timestamps: true,
  }
);

// Wallet Transaction Schema - Transaction history
const walletTransactionSchema = new Schema<IWalletTransaction>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    }, // User who owns the wallet
    walletId: {
      type: String,
      index: true,
    }, // Reference to wallet (optional, can be derived from userId)
    transactionType: {
      type: String,
      enum: ['credit', 'debit', 'refund', 'cashback', 'promotion'],
      required: true,
      index: true,
    }, // Type: 'credit' (adds to balance), 'debit' (deducts from balance), 'refund', 'cashback', 'promotion'
    amount: {
      type: Number,
      required: true,
      min: 0,
    }, // Transaction amount (always positive, type determines if it's added or deducted)
    balanceBefore: {
      type: Number,
      required: true,
      min: 0,
    }, // Wallet balance before this transaction
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    }, // Wallet balance after this transaction
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'completed',
      index: true,
    }, // Transaction status
    referenceType: {
      type: String,
      trim: true,
      index: true,
    }, // Type of reference: 'booking', 'refund', 'cashback', 'promotion', etc.
    referenceId: {
      type: String,
      trim: true,
      index: true,
    }, // ID of the reference entity (bookingId, refundId, etc.)
    description: {
      type: String,
      trim: true,
    }, // Description of the transaction
    notes: {
      type: String,
      trim: true,
    }, // Additional notes
    transactionDate: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Date of transaction (YYYYMMDD format)
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
walletSchema.index({ userId: 1, isActive: 1 });
walletSchema.index({ balance: 1 });

walletTransactionSchema.index({ userId: 1, transactionType: 1 });
walletTransactionSchema.index({ userId: 1, status: 1 });
walletTransactionSchema.index({ userId: 1, transactionDate: 1 });
walletTransactionSchema.index({ referenceType: 1, referenceId: 1 });
walletTransactionSchema.index({ transactionDate: 1, status: 1 });
walletTransactionSchema.index({ createdAt: -1 }); // For recent transactions
walletTransactionSchema.index(
  { userId: 1, transactionType: 1, referenceType: 1, referenceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      transactionType: 'refund',
      referenceType: 'pharmacy_order',
      referenceId: { $exists: true, $type: 'string' },
    },
  }
);

const WalletModel: Model<IWallet> = model<IWallet>('Wallet', walletSchema);
const WalletTransactionModel: Model<IWalletTransaction> = model<IWalletTransaction>(
  'WalletTransaction',
  walletTransactionSchema
);

export { WalletModel, WalletTransactionModel };
export default WalletModel;
