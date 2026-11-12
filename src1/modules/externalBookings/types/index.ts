export type ExternalIntegration = 'labstack' | 'healthians';
export type ExternalBookingListStatus =
  | 'created'
  | 'pending'
  | 'pending_payment'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'rescheduled'
  | 'report_delivered';

export const CUSTOMER_DIAGNOSTICS_PROGRESS_STATUSES = [
  'created', 'pending', 'pending_payment', 'confirmed', 'completed',
  'cancelled', 'rescheduled', 'report_delivered', 'phlebo_assigned',
] as const;

export interface CustomerDiagnosticsProgress {
  bookingId: string;
  integration: ExternalIntegration | 'unknown';
  bookingDateRaw: string | null;
  bookingTimeRaw: string | null;
  bookingStatus: ExternalBookingListStatus | 'phlebo_assigned' | 'unknown';
  paymentStatus: NonNullable<IExternalBooking['paymentStatus']> | 'unknown';
  providerReferenceRecorded: boolean | null;
  sampleState: 'unknown';
  reportReleaseState: 'unknown';
  source: 'local_record';
  lastRecordedAt: string | null;
}

export interface IExternalSpecialist {
  id: string;
  integration: ExternalIntegration;
  providerType?: string;
  appointmentType?: string;
  name: string;
  rating?: number;
  specialization?: string;
  degree?: string;
  experienceYears?: number;
  languages?: string[];
  profilePictureUrl?: string;
  consultationModes?: string[];
  city?: string;
  state?: string;
  pincode?: string;
  fee?: number;
  meta?: Record<string, unknown>;
}

export interface IExternalSlot {
  id: string;
  integration: ExternalIntegration;
  externalProviderId: string;
  providerType?: string;
  appointmentType: string;
  bookingDate: string; // YYYYMMDD
  startTime: string;
  endTime?: string;
  displayTime: string;
  available: boolean;
  meta?: Record<string, unknown>;
}

export interface IExternalPackage {
  id: string;
  integration: ExternalIntegration;
  name: string;
  price?: number;
  customPrice?: number;
  image?: string;
  coverImage?: string;
  pinned?: boolean;
  category?: string;
  serviceability?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface IExternalTest {
  id: string;
  integration: ExternalIntegration;
  name: string;
  price?: number;
  customPrice?: number;
  image?: string;
  coverImage?: string;
  pinned?: boolean;
  category?: string;
  serviceability?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface IExternalLab {
  id: string;
  integration: ExternalIntegration;
  name: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  address?: string;
  meta?: Record<string, unknown>;
}

export interface IExternalDiagnosticsSlot {
  id: string;
  integration: ExternalIntegration;
  bookingDate: string; // YYYYMMDD
  externalProviderId: string;
  labId?: string;
  startTime: string;
  endTime?: string;
  displayTime: string;
  available: boolean;
  meta?: Record<string, unknown>;
}

export interface IExternalBooking {
  _id?: string;
  userId: string;
  dependentId?: string;
  corporateId?: string;
  integration: ExternalIntegration;
  providerType: string;
  appointmentType: string;
  externalProviderId: string;
  externalBookingId?: string;
  externalSlotRef?: string;
  meetingLink?: string;
  bookingDate: string; // YYYYMMDD
  bookingTime: string;
  patientName: string;
  patientEmail?: string;
  patientPhone?: string;
  doctorName?: string;
  labName?: string;
  packageNames?: string[];
  testNames?: string[];
  /** Full or formatted service / visit address (optional; see also meta.addressLine) */
  address?: string;
  /** Persisted report URLs for this external booking */
  report?: string[];
  /** Payable amount (INR) for payment-first consultation or diagnostics */
  price?: number;
  paymentStatus?: 'pending' | 'paid' | 'cancelled' | 'refunded';
  paymentTransactionId?: string;
  status?: string;
  meta?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ExternalConsultationPaymentPayload {
  paymentTransactionId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  amount: number;
  currency: string;
  baseAmount: number;
  discountAmount: number;
  couponCode?: string;
  walletDeductedAmount?: number;
}

export interface ExternalBookingPaymentInitResponse {
  booking: IExternalBooking;
  paymentRequired: boolean;
  walletDeductedAmount?: number;
  payment?: ExternalConsultationPaymentPayload;
  fulfillmentState?: 'completed' | 'pending_confirmation';
}

export interface ExternalBookingPaymentDetailsResponse {
  booking: {
    _id?: string;
    userId: string;
    integration: ExternalIntegration;
    providerType: string;
    appointmentType: string;
    bookingDate: string;
    bookingTime: string;
    status?: string;
    paymentStatus?: 'pending' | 'paid' | 'cancelled' | 'refunded';
    price: number;
    paymentTransactionId?: string;
    externalBookingId?: string;
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

export interface ExternalBookingReportDetails {
  booking: IExternalBooking;
  externalBookingId: string;
  details: Record<string, unknown>;
  documents: Record<string, unknown>[];
  notes?: Record<string, unknown>;
}

export interface ExternalBookingSavedReportsResponse {
  booking: {
    _id?: string;
    userId: string;
    providerType: string;
    appointmentType: string;
    status?: string;
    externalBookingId?: string;
  };
  report: string[];
  source: 'cached' | 'fetched';
}

export interface ProviderTypesQuery {
  integration?: ExternalIntegration;
  appointmentType?: string;
  pincode?: string;
}

export interface ExternalPackagesQuery {
  integration?: ExternalIntegration;
  pincode?: string;
  latitude?: number;
  longitude?: number;
}

export interface ExternalTestsQuery {
  integration?: ExternalIntegration;
  id?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  search?: string;
}

export interface ExternalPackageQuery {
  integration?: ExternalIntegration;
  pincode?: string;
  packageId: string;
  latitude?: number;
  longitude?: number;
}

export interface ExternalTestQuery {
  integration?: ExternalIntegration;
  pincode?: string;
  testId: string;
  latitude?: number;
  longitude?: number;
}

export interface ExternalLabsQuery {
  integration?: ExternalIntegration;
  labId?: string;
  pincode?: string;
  city?: string;
  search?: string;
}

export interface ExternalDiagnosticsSlotsQuery {
  integration?: ExternalIntegration;
  bookingDate: string; // YYYYMMDD
  labId?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  packageIds?: string[];
  testIds?: string[];
}

export interface ExternalServiceabilityQuery {
  integration?: ExternalIntegration;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  packageIds?: string[];
  testIds?: string[];
}

export interface ExternalPackagePreparationsQuery {
  integration?: ExternalIntegration;
  packageId: string;
}

export interface CreateExternalDiagnosticsBookingRequest {
  userId: string;
  dependentId?: string;
  corporateId?: string;
  integration: ExternalIntegration;
  orderType: string;
  bookingDate: string; // YYYYMMDD
  bookingTime: string;
  patientName: string;
  patientEmail?: string;
  patientPhone?: string;
  patientGender?: string;
  patientAge?: string;
  pincode?: string;
  city?: string;
  state?: string;
  locality?: string;
  addressLine?: string;
  /** Full or formatted address string */
  address?: string;
  /** Lab/center address returned by the external lab API */
  labAddress?: string;
  latitude?: number;
  longitude?: number;
  patientDateOfBirth?: string;
  customerRelation?: string;
  stateId?: number;
  cityId?: number;
  zoneId?: number;
  landmark?: string;
  altEmail?: string;
  hardCopy?: number;
  applicationNumber?: string;
  customerRemarks?: string;
  paymentOption?: 'cod' | 'prepaid';
  isPpmcBooking?: number;
  packageIds?: string[];
  testIds?: string[];
  doctorName?: string;
  labName?: string;
  packageNames?: string[];
  testNames?: string[];
  stmId?: string;
  labId?: string;
  notes?: string;
  altContact?: string;
  meta?: Record<string, unknown>;
  couponCode?: string;
  useWalletBalance?: boolean;
}

export interface ExternalSpecialistsQuery {
  integration?: ExternalIntegration;
  providerType: string;
  appointmentType: string;
  speciality?: string;
  subSpeciality?: string;
  preferredGender?: string;
  pincode?: string;
  latitude?: string;
  longitude?: string;
}

export interface ExternalSlotsQuery {
  integration?: ExternalIntegration;
  providerType?: string;
  appointmentType: string;
  externalProviderId: string;
  bookingDate: string;
  pincode?: string;
  latitude?: string;
  longitude?: string;
}

export interface CreateExternalBookingRequest {
  userId: string;
  dependentId?: string;
  corporateId?: string;
  integration: ExternalIntegration;
  providerType: string;
  appointmentType: string;
  externalProviderId?: string;
  bookingDate: string;
  bookingTime?: string;
  selectedSlotTime: string;
  patientName: string;
  patientEmail?: string;
  patientPhone?: string;
  doctorName?: string;
  labName?: string;
  patientGender?: string;
  patientDateOfBirth?: string;
  patientAge?: string;
  primaryConcern?: string;
  consultationMode?: 'chat' | 'call' | 'video' | 'in-person';
  notes?: string;
  pincode?: string;
  city?: string;
  state?: string;
  addressLine?: string;
  /** Full or formatted address string */
  address?: string;
  meta?: Record<string, unknown>;
  couponCode?: string;
  useWalletBalance?: boolean;
}

export interface ExternalBookingListQuery {
  userId?: string;
  corporateId?: string;
  integration?: ExternalIntegration;
  providerType?: string;
  appointmentType?: string;
  patientName?: string;
  bookingDateFrom?: string;
  bookingDateTo?: string;
  status?: ExternalBookingListStatus;
  paymentStatus?: 'pending' | 'paid' | 'cancelled' | 'refunded';
  page?: number;
  limit?: number;
}

export interface ExternalBookingIdParams {
  id: string;
}

export interface CancelExternalBookingRequest {
  cancellationReason?: string;
  /** @deprecated use cancellationReason */
  reason?: string;
}

export interface RescheduleExternalBookingRequest {
  bookingDate: string;
  selectedSlotTime: string;
}

export interface RescheduleExternalDiagnosticsBookingRequest {
  bookingDate: string;
  bookingTime: string;
}
