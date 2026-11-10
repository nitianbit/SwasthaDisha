export interface ISlot {
  _id?: string;
  specialistId?: string; // For consultation slots
  wellnessPackageId?: string; // For wellness package slots
  date: string; // YYYYMMDD format (e.g., "20250215")
  startTime: string; // e.g., "9:00 AM"
  endTime: string; // e.g., "10:00 AM"
  duration?: number; // Duration in minutes
  isAvailable: boolean; // Whether the slot is available for booking
  maxBookings?: number; // Maximum number of bookings allowed for this slot
  currentBookings?: number; // Current number of bookings (default: 0)
  slotType?: 'consultation' | 'wellnessPackage'; // Type of slot
  isRecurring?: boolean; // If this is part of a recurring schedule
  recurringPattern?: string; // e.g., "daily", "weekly", "monthly"
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateSlotRequest {
  specialistId?: string;
  wellnessPackageId?: string;
  date: string; // YYYYMMDD format (e.g., "20250215")
  startTime: string;
  endTime: string;
  duration?: number;
  isAvailable?: boolean;
  maxBookings?: number;
  currentBookings?: number;
  slotType?: 'consultation' | 'wellnessPackage';
  isRecurring?: boolean;
  recurringPattern?: string;
  isActive?: boolean;
}

export interface UpdateSlotRequest {
  date?: string; // YYYYMMDD format (e.g., "20250215")
  startTime?: string;
  endTime?: string;
  duration?: number;
  isAvailable?: boolean;
  maxBookings?: number;
  currentBookings?: number;
  isRecurring?: boolean;
  recurringPattern?: string;
  isActive?: boolean;
}

export interface SlotQueryParams {
  specialistId?: string;
  wellnessPackageId?: string;
  slotType?: 'consultation' | 'wellnessPackage';
  date?: string; // YYYYMMDD format
  dateFrom?: string; // YYYYMMDD format
  dateTo?: string; // YYYYMMDD format
  isAvailable?: boolean;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
