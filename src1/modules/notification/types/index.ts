/**
 * Notification Module Types
 * 
 * Notification System:
 * - Notifications are created for various user events
 * - Each notification has a type, title, message, and optional data
 * - Notifications can be marked as read/unread
 * - Notifications are user-specific
 * 
 * Notification Types:
 * - 'login': User successfully logged in
 * - 'booking_created': A new booking was created
 * - 'booking_confirmed': Booking was confirmed
 * - 'booking_cancelled': Booking was cancelled
 * - 'wallet_credit': Money was added to wallet
 * - 'wallet_debit': Money was deducted from wallet
 * - 'payment_success': Payment was successful
 * - 'payment_failed': Payment failed
 * - 'reminder': Booking reminder or other reminder
 * - 'general': General notification
 */

export type NotificationType =
  | 'login'
  | 'booking_created'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'wallet_credit'
  | 'wallet_debit'
  | 'payment_success'
  | 'payment_failed'
  | 'reminder'
  | 'general'
  | 'specialist_login'
  | 'specialist_new_booking'
  | 'specialist_upcoming_appointment'
  | 'specialist_appointment_cancelled'
  | 'specialist_appointment_confirmed'
  | 'specialist_appointment_completed'
  | 'specialist_general';

export interface INotification {
  _id?: string;
  userId: string; // User who will receive this notification
  type: NotificationType; // Type of notification
  title: string; // Notification title
  message: string; // Notification message/content
  isRead: boolean; // Whether notification has been read
  readAt?: Date; // When notification was read
  data?: Record<string, any>; // Additional data (e.g., bookingId, transactionId, amount, etc.)
  // Reference fields for linking to related entities
  referenceType?: string; // Type of reference: 'booking', 'wallet_transaction', 'payment', etc.
  referenceId?: string; // ID of the reference entity
  idempotencyKey?: string;
  fcmSentAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateNotificationRequest {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
}

/** Request for sending a notification to multiple users, a corporate, or all users. */
export interface CreateGeneralNotificationRequest {
  userIds?: string[]; // If provided, send only to these users
  corporateId?: string; // If provided, send to all users of this corporate (ignored if userIds is provided)
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
  referenceType?: string;
  referenceId?: string;
}

export interface UpdateNotificationRequest {
  isRead?: boolean;
}

export interface NotificationQueryParams {
  userId?: string;
  type?: NotificationType;
  isRead?: boolean;
  referenceType?: string;
  referenceId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
