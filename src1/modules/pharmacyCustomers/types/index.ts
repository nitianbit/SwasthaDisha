export interface IPharmacyCustomer {
  _id?: string;
  pharmacyId: string;
  userId: string;
  // pharmacy-specific metadata
  diseaseNotes?: string;
  chronicCondition?: boolean;
  recurringMedicine?: boolean;
  recurringIntervalDays?: number;
  preferredFollowUpDate?: string;
  pharmacyNotes?: string;
  createdByRole?: string;
  createdById?: string;
  /** S3: how the patient's agreement to this link was recorded, by whom and when. */
  consent?: PharmacyCustomerConsent;
  consentRecordedAt?: Date;
  consentRecordedById?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * 'patient_agreed': the partner ticked "patient agreed"; 'not_recorded': linked without that confirmation;
 * 'customer_order': the customer placed an order with this pharmacy themselves.
 */
export type PharmacyCustomerConsent = 'patient_agreed' | 'not_recorded' | 'customer_order';

export interface CreatePharmacyCustomerRequest {
  pharmacyId: string;
  // user fields — used to find or create the user
  name: string;
  phone: string;
  age?: number;
  diseaseNotes?: string;
  chronicCondition?: boolean;
  recurringMedicine?: boolean;
  recurringIntervalDays?: number;
  /** S3: true when the patient agreed to the link; a missing value is recorded as 'not_recorded'. */
  consent?: boolean;
}

export interface UpdatePharmacyCustomerNotesRequest {
  diseaseNotes?: string;
  chronicCondition?: boolean;
  recurringMedicine?: boolean;
  recurringIntervalDays?: number;
  preferredFollowUpDate?: string;
  pharmacyNotes?: string;
}

export interface PharmacyCustomerQueryParams {
  pharmacyId: string;
  search?: string;
  page?: number;
  limit?: number;
}
