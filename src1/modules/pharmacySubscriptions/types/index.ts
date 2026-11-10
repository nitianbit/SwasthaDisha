export type ReminderChannel = 'sms' | 'push' | 'both' | 'none';
export type SubscriptionSyncStatus = 'pending' | 'synced' | 'failed';

export interface IPharmacySubscription {
  _id?: string;
  pharmacyId: string;
  userId: string;
  medicineId: string;
  medicineName?: string;
  frequency?: string;
  intervalDays: number;
  nextRefillDate?: string;
  reminderChannel?: ReminderChannel;
  isActive?: boolean;
  pausedUntil?: string;
  sourceOrderId?: string;
  sourceOrderStatus?: string;
  lastSyncStatus?: SubscriptionSyncStatus;
  lastSyncError?: string;
  createdById?: string;
  createdByRole?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SubscriptionItemInput {
  medicineId: string;
  medicineName?: string;
  frequency?: string;
  intervalDays: number;
  nextRefillDate?: string;
  reminderChannel?: ReminderChannel;
}

export interface CreateSubscriptionRequest {
  userId: string;
  items: SubscriptionItemInput[];
}

export interface SubscriptionOrderLinkage {
  sourceOrderId: string;
  sourceOrderStatus: string;
  lastSyncStatus?: SubscriptionSyncStatus;
  lastSyncError?: string;
}

export interface UpdateSubscriptionRequest {
  intervalDays?: number;
  nextRefillDate?: string;
  reminderChannel?: ReminderChannel;
  isActive?: boolean;
  pausedUntil?: string;
}

export interface SubscriptionQueryParams {
  pharmacyId?: string;
  userId?: string;
  medicineId?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}
