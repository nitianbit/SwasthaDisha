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
  createdAt?: Date;
  updatedAt?: Date;
}

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
