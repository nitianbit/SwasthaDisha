export type PayoutBillingStatus = 'Unpaid' | 'Partially Paid' | 'Paid';

export interface IPayoutBilling {
  _id?: string;
  specialistId: string;
  month: number; // YYYYMM
  totalAppointments: number;
  totalPatients: number;
  totalUniquePatients: number;
  totalFollowUpAppointments: number;
  total: number;
  paid: number;
  due: number;
  status: PayoutBillingStatus;
  invoiceUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPayoutDisbursalExtraDetails {
  notes?: string;
  receipts?: string[];
  [key: string]: unknown;
}

export interface IPayoutDisbursal {
  _id?: string;
  billingIds: string[];
  specialistId: string;
  disbursalAmount: number;
  disbursalDate: number; // Unix seconds
  extraDetails?: IPayoutDisbursalExtraDetails;
  receiptUrl?: string;
  createdByAdminId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPayoutSummary {
  _id?: string;
  specialistId: string;
  total: number;
  paid: number;
  due: number;
  lastDisbursalDate?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PayoutActivitySummaryRequest {
  fromDate?: number;
  tillDate?: number;
  sortBy?: string;
  sortAsc?: boolean;
  isConsultant?: boolean;
}

export interface FetchPayoutBillingsRequest {
  specialist_id?: string;
  consultant_id?: string;
  year: number;
}

export interface CalculatePayoutBillingsRequest {
  specialist_id?: string;
  consultant_id?: string;
  months: number[];
}

export interface CalculatePayoutBillingsByYearRequest {
  specialist_id?: string;
  consultant_id?: string;
  year: number;
}

export interface CreatePayoutDisbursalRequest {
  billing_ids: string[];
  specialist_id?: string;
  consultant_id?: string;
  disbursal_amount: number;
  disbursal_date?: number;
  extra_details?: IPayoutDisbursalExtraDetails;
}

export interface PayoutDisbursalHistoryRequest {
  specialist_id?: string;
  consultant_id?: string;
}

export interface UpdatePayoutDisbursalRequest {
  _id: string;
  extra_details: IPayoutDisbursalExtraDetails;
}

export interface GetPayoutInvoiceRequest {
  specialist_id?: string;
  consultant_id?: string;
  month: number;
}

export interface GetPayoutReceiptRequest {
  disbursal_id: string;
}

export interface CreateAllPayoutsRequest {
  month: number;
}

export interface PayoutGridRow {
  specialistId: string;
  name: string;
  email?: string;
  phone?: string;
  specialization?: string;
  total: number;
  paid: number;
  due: number;
  lastDisbursalDate?: number;
}
