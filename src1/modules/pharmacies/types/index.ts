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
}

export interface PharmacyQueryParams {
  name?: string;
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
