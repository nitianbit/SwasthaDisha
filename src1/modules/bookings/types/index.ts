export type BookingType = 'package' | 'consultation' | 'second-opinion' | 'surgery';
export type ServiceMode = 'in-person' | 'pickup' | 'chat' | 'call' | 'video';
export type ConsultationMode = 'chat' | 'call' | 'video' | 'in-person';
export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export type VirtualMeetingStatus = 'active' | 'cancelled' | 'failed';

/** Q14: a no-show that was rescheduled once (same price, no new payment, no refund). */
export interface IBookingNoShow {
  at?: Date; by?: string; byKind?: string;
  rescheduledAt: Date; rescheduledBy: string; rescheduledByKind: string;
  fromSlotId?: string; fromDate?: string; fromTime?: string; toSlotId: string; requestKey: string; requestHash: string;
}

export interface IBookingLifecycleEvent {
  at: string;
  by?: string;
  amount?: number;
  reason?: string;
}

export interface IBookingLifecycle {
  created?: IBookingLifecycleEvent;
  paymentPending?: IBookingLifecycleEvent;
  paid?: IBookingLifecycleEvent;
  confirmed?: IBookingLifecycleEvent;
  rescheduled?: IBookingLifecycleEvent;
  cancelled?: IBookingLifecycleEvent;
  completed?: IBookingLifecycleEvent;
  prescriptionUploaded?: IBookingLifecycleEvent;
  refunded?: IBookingLifecycleEvent;
}

export interface IDocument {
  type: 'report' | 'prescription' | 'other';
  url: string;
  fileName?: string;
}

export interface IBookingPrescription {
  fileUrls?: string[];
  message?: string;
  diagnosis?: string;
  advice?: string;
  medicines?: IBookingPrescriptionMedicine[];
  testsAdvised?: string[];
  prescribedAt?: string;
  prescribedBySpecialistId?: string;
  prescribedBySpecialistName?: string;
  /** Assisted booking phase 0 (D15): the dispensing copy (no diagnosis) and the hash of the content it shows. */
  dispensingCopy?: { url: string; hash: string; at: Date };
}

export interface IBookingPrescriptionMedicine {
  name: string;
  dosage?: string;
  frequency?: string;
  instructions?: string;
  duration?: string;
}

export interface IBookingReport {
  fileUrls?: string[];
  message?: string;
}

export interface IBookingFollowUp {
  isFollowUp?: boolean;
  parentConsultationId?: string;
  eligibilityExpiresAt?: string;
  benefitUsed?: boolean;
  completedAt?: string;
}

export interface IServiceAddress {
  addressLine: string;
  city: string;
  pincode: string;
  state?: string;
}

export interface IVirtualMeeting {
  provider: 'google_meet';
  status: VirtualMeetingStatus;
  joinUrl?: string;
  meetingCode?: string;
  calendarEventId?: string;
  startDateTime?: string;
  endDateTime?: string;
  error?: string;
  createdAt?: Date;
  updatedAt?: Date;
  cancelledAt?: Date;
}

export interface IBooking {
  _id?: string;
  /** Machine-readable reason of a system cancellation (D2: 'payment_timeout'). */
  cancellationCause?: string;
  expiryNextAt?: Date;
  expiryChecks?: number;
  /** Client key of the create request (W3b); a resent create returns this booking. */
  createRequestKey?: string;
  /** Validated create terms (W3b); an interrupted creation is finished with exactly these. */
  createTerms?: { basePrice: number; discountAmount: number; couponCode?: string; useWalletBalance: boolean };
  bookingType: BookingType;
  userId: string; // User making the booking
  pharmacyId?: string; // Pharmacy creating the booking on behalf of the user
  dependentId?: string; // If booking is for a dependent
  corporateId?: string; // Corporate ID if booking is through corporate
  
  // Wellness Package Booking fields
  wellnessPackageId?: string;
  packageName?: string;
  
  // Specialist Booking fields
  specialistId?: string;
  doctorName?: string;
  primaryConcern?: string;
  consultationMode?: ConsultationMode;
  
  // Slot information
  slotId?: string; // Slot ID (not required for surgery)
  
  // Common fields
  bookingDate: string; // YYYYMMDD format (e.g., "20250215")
  bookingTime: string; // e.g., "9:00 AM"
  serviceMode: ServiceMode;
  serviceAddress?: IServiceAddress;
  documents?: IDocument[]; // User-uploaded supporting files
  prescription?: IBookingPrescription; // Doctor-issued prescription
  report?: IBookingReport; // Lab or doctor report/result
  followUp?: IBookingFollowUp;
  
  // Contact information
  contactNo?: string; // Primary contact number (10 digits)
  alternateContactNo?: string; // Alternate contact number (10 digits)
  
  // Pricing
  price: number;
  originalPrice?: number; // For wellness packages
  paymentTransactionId?: string; // Payment transaction reference for paid flows
  /** Wallet money applied to this booking (rupees); authoritative for refunds and retries. */
  postPaymentCompletedFor?: string;
  /** Slot capacity / follow-up benefit held by this booking (bookings/holds.ts). */
  holds?: { version: 1; heldSlotId?: string | null; followUpParentId?: string | null };
  /** Q3 §7a: settled by the legacy payouts or the ledger (never both). */
  /** 'clinic' = booked by a clinic's front desk and paid at the clinic: never settled by the legacy payouts or the ledger. */
  settlementSystem?: 'legacy' | 'ledger' | 'clinic';
  clinicDesk?: { partnerId: string; branchId: string; createdBy: string; arrivedAt?: Date | null; requestKey?: string; requestHash?: string };
  clinicVisit?: { partnerId: string; branchId: string };
  /** Q14: the current no-show; rescheduled no-shows (≤ 1) and their count. */
  noShow?: { at: Date; by: string; byKind: string };
  noShows?: IBookingNoShow[];
  noShowReschedules?: number;
  /** Q16a: a moved no-show cancelled by an admin, refunded or not (their choice). */
  noShowCancel?: { at: Date; by: string; refund: boolean; forfeitedAmount?: number };
  /** Q16a: the appointment before the first customer reschedule (history only; the refund rule uses `refundLock`). */
  originalAppointment?: { bookingDate: string; bookingTime: string };
  /** Q16a: the appointment a customer moved away from after its refund deadline had passed; that window stays closed. */
  refundLock?: { bookingDate: string; bookingTime: string; movedAt: Date };
  settlement?: { settlementAccountId?: string; beneficiaryName?: string };
  bookingKind?: 'scheduled' | 'instant';
  instantRequestId?: string;
  /** Q13: every extension of an instant consultation (a keyed one happens once). */
  instantExtensions?: { requestKey?: string; minutes: number; endTime: Date; at: Date }[];
  walletFunding?: { total: number; revision?: number; closed?: boolean;
    captures?: { recordId: string; amount: number; state: 'applied' | 'returned' }[]; updatedAt?: Date };
  
  // Status
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  lifecycle?: IBookingLifecycle;
  
  // Additional fields
  notes?: string;
  cancellationReason?: string;
  cancelledAt?: string; // YYYYMMDD format
  virtualMeeting?: IVirtualMeeting;
  
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateWellnessPackageBookingRequest {
  userId: string;
  pharmacyId?: string;
  dependentId?: string;
  corporateId?: string; // Corporate ID if booking is through corporate
  wellnessPackageId: string;
  packageName?: string;
  slotId: string; // Required slot ID for the booking
  bookingDate: string; // YYYYMMDD format
  bookingTime: string;
  serviceMode: ServiceMode;
  serviceAddress?: IServiceAddress;
  documents?: IDocument[];
  prescription?: IBookingPrescription;
  report?: IBookingReport;
  followUp?: IBookingFollowUp;
  contactNo?: string; // Primary contact number (10 digits)
  alternateContactNo?: string; // Alternate contact number (10 digits)
  couponCode?: string; // Coupon code used for this booking (if any)
  useWalletBalance?: boolean; // Whether to use wallet balance for this booking
  notes?: string;
}

export interface CreateSpecialistBookingRequest {
  userId: string;
  /** Optional create key (^[A-Za-z0-9_-]{8,64}$): the same key again returns the booking it created (W3b). */
  requestKey?: string;
  pharmacyId?: string;
  dependentId?: string;
  corporateId?: string; // Corporate ID if booking is through corporate
  specialistId: string;
  doctorName?: string;
  primaryConcern: string;
  consultationMode: ConsultationMode;
  slotId: string; // Required slot ID for the booking
  bookingDate: string; // YYYYMMDD format
  bookingTime: string;
  serviceAddress?: IServiceAddress;
  documents?: IDocument[];
  prescription?: IBookingPrescription;
  report?: IBookingReport;
  followUp?: IBookingFollowUp;
  contactNo?: string; // Primary contact number (10 digits)
  alternateContactNo?: string; // Alternate contact number (10 digits)
  couponCode?: string; // Coupon code used for this booking (if any)
  useWalletBalance?: boolean; // Whether to use wallet balance for this booking
  notes?: string;
}

export interface CreateBookingRequest {
  bookingType: BookingType;
  userId: string;
  pharmacyId?: string;
  dependentId?: string;
  corporateId?: string;
  wellnessPackageId?: string;
  packageName?: string;
  specialistId?: string;
  doctorName?: string;
  primaryConcern?: string;
  consultationMode?: ConsultationMode;
  slotId?: string;
  bookingDate: string;
  bookingTime: string;
  serviceMode?: ServiceMode;
  serviceAddress?: IServiceAddress;
  documents?: IDocument[];
  prescription?: IBookingPrescription;
  report?: IBookingReport;
  followUp?: IBookingFollowUp;
  contactNo?: string;
  alternateContactNo?: string;
  couponCode?: string;
  useWalletBalance?: boolean;
  notes?: string;
}

export interface UpdateBookingRequest {
  corporateId?: string; // Corporate ID if booking is through corporate
  slotId?: string; // Slot ID (optional for updates)
  bookingDate?: string; // YYYYMMDD format
  bookingTime?: string;
  serviceMode?: ServiceMode;
  serviceAddress?: IServiceAddress;
  documents?: IDocument[];
  prescription?: IBookingPrescription;
  report?: IBookingReport;
  followUp?: IBookingFollowUp;
  primaryConcern?: string;
  consultationMode?: ConsultationMode;
  contactNo?: string; // Primary contact number (10 digits)
  alternateContactNo?: string; // Alternate contact number (10 digits)
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  lifecycle?: IBookingLifecycle;
  notes?: string;
  cancellationReason?: string;
  cancelledAt?: string; // YYYYMMDD format
  virtualMeeting?: IVirtualMeeting;
}

export interface CancelBookingRequest {
  cancellationReason?: string;
}

export interface RescheduleBookingRequest {
  slotId: string;
  bookingDate?: string;
  bookingTime?: string;
  serviceMode?: ServiceMode;
  serviceAddress?: IServiceAddress;
  consultationMode?: ConsultationMode;
  notes?: string;
}

export interface RetryBookingPaymentRequest {
  useWalletBalance?: boolean;
  couponCode?: string;
}

export interface BookingPaymentDetailsResponse {
  booking: {
    _id?: string;
    userId: string;
    bookingType: BookingType;
    bookingDate: string;
    bookingTime: string;
    status: BookingStatus;
    paymentStatus: PaymentStatus;
    price: number;
    originalPrice?: number;
    paymentTransactionId?: string;
  };
  payment: null | {
    paymentTransactionId: string;
    paymentGateway: 'razorpay' | 'internal';
    paymentStatus: 'created' | 'paid' | 'failed' | 'refunded';
    couponCode?: string;
    baseAmount: number;
    discountAmount: number;
    finalAmount: number;
    currency: string;
    razorpayOrderId: string;
    razorpayPaymentId?: string;
    paidAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
  };
  wallet: {
    amountUsed: number;
    transactions: Array<{
      _id?: string;
      amount: number;
      status: string;
      transactionDate?: string;
      createdAt?: Date;
    }>;
  };
  refund: {
    amountRefunded: number;
    transactions: Array<{
      _id?: string;
      amount: number;
      status: string;
      transactionDate?: string;
      createdAt?: Date;
    }>;
  };
  summary: {
    couponCode?: string;
    amountChargedToRazorpay: number;
    amountUsedFromWallet: number;
    amountRefunded: number;
    actualAmountPaid: number;
    paidAt?: Date;
  };
}

export interface BookingQueryParams {
  userId?: string;
  pharmacyId?: string;
  dependentId?: string;
  corporateId?: string; // Filter by corporate ID
  bookingType?: BookingType;
  wellnessPackageId?: string;
  specialistId?: string;
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  bookingDateFrom?: string; // YYYYMMDD format
  bookingDateTo?: string; // YYYYMMDD format
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  forUser?: boolean;
  /** S2: set only by the controller for a specialist or pharmacy; the list never leaves this owner's bookings. */
  ownerScope?: BookingOwnerScope;
}

/** S2: the bookings a specialist (own specialistId) or a pharmacy (own pharmacyId) may see. */
export type BookingOwnerScope = { specialistId: string } | { pharmacyId: string };
