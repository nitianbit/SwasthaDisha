export interface ApplyReferralRequest {
  referralCode: string;
}

export interface ApplyReferralResult {
  referredUserId: string;
  referrerUserId: string;
  referrerReferralCode: string;
  rewardAmount: number;
  referredByUserId: string;
  walletTransactionId: string;
}

export interface ReferralCodeResult {
  userId: string;
  referralCode: string;
}

export interface ReferralTransactionQueryParams {
  transactionDateFrom?: string;
  transactionDateTo?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ReferralEarningsResult {
  userId: string;
  totalEarned: number;
  totalTransactions: number;
}
