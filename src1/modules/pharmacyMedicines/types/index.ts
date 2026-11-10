export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'injection'
  | 'cream'
  | 'ointment'
  | 'drops'
  | 'inhaler'
  | 'patch'
  | 'powder'
  | 'solution'
  | 'gel'
  | 'other';

export interface IMedicine {
  _id?: string;
  name: string;
  nameKey?: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  imageUrl?: string;
  dosageForm?: DosageForm;
  strength?: string;
  manufacturer?: string;
  hsnCode?: string;
  gstPercent?: number;
  prescriptionRequired?: boolean;
  isActive?: boolean;
  archivedAt?: Date;
  archivedBy?: string;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateMedicineRequest {
  name: string;
  nameKey?: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  imageUrl?: string;
  dosageForm?: DosageForm;
  strength?: string;
  manufacturer?: string;
  hsnCode?: string;
  gstPercent?: number;
  prescriptionRequired?: boolean;
  isActive?: boolean;
}

export interface UpdateMedicineRequest {
  name?: string;
  nameKey?: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  imageUrl?: string;
  dosageForm?: DosageForm;
  strength?: string;
  manufacturer?: string;
  hsnCode?: string;
  gstPercent?: number;
  prescriptionRequired?: boolean;
  isActive?: boolean;
}

export interface MedicineQueryParams {
  name?: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  dosageForm?: DosageForm;
  manufacturer?: string;
  prescriptionRequired?: boolean;
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface NearbyMedicineQueryParams {
  latitude: number;
  longitude: number;
  radiusKm?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface NearbyMedicineDto {
  medicineId: string;
  name: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  imageUrl?: string;
  dosageForm?: DosageForm;
  strength?: string;
  manufacturer?: string;
  prescriptionRequired?: boolean;
  pharmacyCount: number;
  totalAvailableQty: number;
  minRetailPrice?: number;
  minWholesalePrice?: number;
  nearestDistanceKm: number;
}
