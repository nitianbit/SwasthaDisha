export const REFILL_REMINDER_CHANNELS = Object.freeze(['sms', 'push', 'both', 'none'] as const);
export type ReminderChannel = typeof REFILL_REMINDER_CHANNELS[number];
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

/** Internal parsed primitives; only parseDueRefillQuery constructs this read input. */
export interface DueRefillCursor {
  readonly v: 1;
  readonly pharmacyId: string;
  readonly through: string;
  readonly limit: number;
  readonly nextRefillDate: string;
  readonly subscriptionId: string;
}
export interface DueRefillQuery {
  readonly through: string;
  readonly limit: number;
  readonly after?: DueRefillCursor;
}
export interface DueRefillRow {
  subscriptionId: string;
  nextRefillDate: string;
  intervalDays: number;
  reminderChannel: ReminderChannel | null;
  pausedUntil: string | null;
  pauseEvaluation: 'not_evaluated';
}
export interface DueRefillPage {
  through: string;
  limit: number;
  items: DueRefillRow[];
  nextCursor: string | null;
}
