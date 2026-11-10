export type PharmacyWalletTxType =
  | 'credit'
  | 'debit'
  | 'consultation_payment'
  | 'refund'
  | 'adjustment';

export interface IPharmacyWallet {
  _id?: string;
  pharmacyId: string;
  balance: number;
  balancePaise?: number;
  isActive?: boolean;
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
