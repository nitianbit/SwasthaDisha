/**
 * Wallet Module Types
 * 
 * Wallet System:
 * - Each user has a wallet with a balance
 * - Transactions track all credit/debit operations
 * - Balance is calculated from transaction history
 * 
 * Transaction Types:
 * - 'credit': Money added to wallet (refund, cashback, promotion, etc.)
 * - 'debit': Money deducted from wallet (payment for booking, etc.)
 * - 'refund': Refund to wallet from cancelled booking
 * - 'cashback': Cashback reward
 * - 'promotion': Promotional credit
 */

export type TransactionType = 'credit' | 'debit' | 'refund' | 'cashback' | 'promotion';

export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface IWallet {
  _id?: string;
  userId: string; // User who owns this wallet
  balance: number; // Current wallet balance (calculated from transactions)
  isActive?: boolean; // Whether wallet is active
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWalletTransaction {
  _id?: string;
  userId: string; // User who owns the wallet
  walletId?: string; // Reference to wallet (optional, can be derived from userId)
  transactionType: TransactionType; // Type of transaction: 'credit', 'debit', 'refund', 'cashback', 'promotion'
  amount: number; // Transaction amount (always positive, type determines if it's added or deducted)
  balanceBefore: number; // Wallet balance before this transaction
  balanceAfter: number; // Wallet balance after this transaction
  status: TransactionStatus; // Transaction status: 'pending', 'completed', 'failed', 'cancelled'
  referenceType?: string; // Type of reference: 'booking', 'refund', 'cashback', 'promotion', etc.
  referenceId?: string; // ID of the reference entity (bookingId, refundId, etc.)
  description?: string; // Description of the transaction
  notes?: string; // Additional notes
  transactionDate?: string; // YYYYMMDD format - Date of transaction
  /** Stable business-operation identity (unique when present): the same operation can never post twice. */
  operationKey?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateWalletRequest {
  userId: string;
  initialBalance?: number; // Optional initial balance (default: 0)
  isActive?: boolean;
}

export interface UpdateWalletRequest {
  isActive?: boolean;
}

export interface CreateWalletTransactionRequest {
  userId: string;
  transactionType: TransactionType;
  amount: number;
  referenceType?: string; // e.g., 'booking', 'refund', 'cashback', 'promotion'
  referenceId?: string; // ID of the reference entity
  description?: string;
  notes?: string;
  transactionDate?: string; // YYYYMMDD format
}

export interface WalletQueryParams {
  userId?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface WalletTransactionQueryParams {
  userId?: string;
  transactionType?: TransactionType;
  status?: TransactionStatus;
  referenceType?: string;
  referenceId?: string;
  transactionDateFrom?: string; // YYYYMMDD format
  transactionDateTo?: string; // YYYYMMDD format
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface InitiateWalletRechargeRequest {
  userId: string;
  amount: number;
  couponCode?: string;
}
