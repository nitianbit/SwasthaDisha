export interface IPharmacyOpeningHours {
  open: string;   // e.g. "09:00"
  close: string;  // e.g. "21:00"
  isClosed?: boolean;
}

export interface IPharmacyWeeklyHours {
  monday?: IPharmacyOpeningHours;
  tuesday?: IPharmacyOpeningHours;
  wednesday?: IPharmacyOpeningHours;
  thursday?: IPharmacyOpeningHours;
  friday?: IPharmacyOpeningHours;
  saturday?: IPharmacyOpeningHours;
  sunday?: IPharmacyOpeningHours;
}

export interface IPharmacy {
  _id?: string;
  name: string;
  nickname?: string;
  ownerName?: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  gstNumber?: string;
  drugLicenseNumber?: string;
  /** P9: the registered pharmacist recorded on prescription approvals. */
  pharmacist?: { name: string; registrationNumber: string; updatedAt: Date };
  gstCertificateUrl?: string;
  drugLicenseDocumentUrl?: string;
  ownerIdProofUrl?: string;
  shopFrontPhotoUrl?: string;
  openingHours?: IPharmacyWeeklyHours;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  isVerified?: boolean;
  isActive?: boolean;
  archivedAt?: Date;
  archivedBy?: string;
  archiveReason?: string;
  walletEnabled?: boolean;
  profilePictureUrl?: string;
  /** Q15: set on an admin create made under a request key. */
  createdBy?: string;
  createRequestKey?: string;
  createRequestHash?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreatePharmacyRequest {
  name: string;
  nickname?: string;
  ownerName?: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  gstNumber?: string;
  drugLicenseNumber?: string;
  gstCertificateUrl?: string;
  drugLicenseDocumentUrl?: string;
  ownerIdProofUrl?: string;
  shopFrontPhotoUrl?: string;
  openingHours?: IPharmacyWeeklyHours;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  isVerified?: boolean;
  isActive?: boolean;
  walletEnabled?: boolean;
  profilePictureUrl?: string;
  /** Q15: admin create exactly once per (admin, requestKey); replayed by content hash. */
  requestKey?: string;
}

export interface UpdatePharmacyRequest {
  name?: string;
  nickname?: string;
  ownerName?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  gstNumber?: string;
  drugLicenseNumber?: string;
  gstCertificateUrl?: string;
  drugLicenseDocumentUrl?: string;
  ownerIdProofUrl?: string;
  shopFrontPhotoUrl?: string;
  openingHours?: IPharmacyWeeklyHours;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  isVerified?: boolean;
  isActive?: boolean;
  walletEnabled?: boolean;
  profilePictureUrl?: string;
  /** Q15 (admin edit): the updatedAt the editor started from; any other current value is refused (409 RECORD_CHANGED). */
  expectedUpdatedAt?: Date | string | null;
}

export interface PharmacyQueryParams {
  name?: string;
  /** Q15 (admin list): exact canonical 10-digit phone. */
  phone?: string;
  city?: string;
  state?: string;
  pincode?: string;
  isVerified?: boolean;
  isActive?: boolean;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
}

export interface MedicineAvailabilityQueryParams {
  medicineId: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  page?: number;
  limit?: number;
}

export interface PharmacyMedicineAvailabilityDto {
  pharmacyId: string;
  medicineId: string;
  pharmacyName: string;
  pharmacyNickname?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  profilePictureUrl?: string;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  medicineName: string;
  genericName?: string;
  brandName?: string;
  dosageForm?: string;
  strength?: string;
  manufacturer?: string;
  availableQty: number;
  retailPrice?: number;
  wholesalePrice?: number;
  distanceKm?: number;
}

export interface PublicPharmacyDto {
  _id?: string;
  name: string;
  nickname?: string;
  ownerName?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  openingHours?: IPharmacyWeeklyHours;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  isVerified?: boolean;
  isActive?: boolean;
  profilePictureUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
