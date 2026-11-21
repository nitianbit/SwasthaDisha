export type PharmacyWalletTxType =
  | 'credit'
  | 'debit'
  | 'consultation_payment'
  | 'refund'
  | 'adjustment'
  | 'booking_debit'
  | 'refund_credit'
  | 'withdrawal_hold'
  | 'withdrawal_release'
  | 'withdrawal_void'
  | 'chargeback'
  | 'receivable_setoff'
  | 'opening_balance';

export interface IPharmacyWallet {
  _id?: string;
  pharmacyId: string;
  balance: number;
  balancePaise?: number;
  isActive?: boolean;
  withdrawableMinor?: number;
  receivableMinor?: number;
  frozen?: boolean;
  frozenReason?: string;
  frozenAt?: Date;
  version?: number;
  ledgerOpenedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPharmacyWalletTransaction {
  _id?: string;
  pharmacyId: string;
  walletId: string;
  transactionType: PharmacyWalletTxType;
  amount: number;
  amountPaise?: number;
  balanceBefore: number;
  balanceAfter: number;
  balanceBeforePaise?: number;
  balanceAfterPaise?: number;
  status: 'pending' | 'completed' | 'failed';
  referenceType?: string;
  referenceId?: string;
  description?: string;
  notes?: string;
  transactionDate?: string;
  signedAmountPaise?: number;
  operationKey?: string;
  withdrawableDeltaPaise?: number;
  receivableDeltaPaise?: number;
  lotAllocations?: { lotId: string; amountPaise: number }[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TopupWalletRequest {
  amount: number;
  notes?: string;
}

export interface InitiatePharmacyWalletTopupResponse {
  paymentRequired: true;
  paymentTransactionId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  amount: number;
  currency: string;
}

export interface ConsultationPaymentRequest {
  amount: number;
  consultationId: string;
  notes?: string;
}

export interface WalletTxQueryParams {
  pharmacyId: string;
  transactionType?: PharmacyWalletTxType;
  page?: number;
  limit?: number;
}
