export interface IUser {
  _id?: string;
  // Authentication & Basic Info
  email?: string;
  corporateEmail?: string;
  phone?: string;
  userType: 'user';
  name?: string;
  age?: number;
  profilePictureUrl?: string;

  // User-specific fields (for regular app users)
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
  height?: number; // in cm
  weight?: number; // in kg
  emergencyContact?: {
    name?: string;
    phone?: string;
    relationship?: string;
  };

  // Address fields
  address?: string;
  latitude?: number;
  longitude?: number;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;

  // Corporate association
  corporateId?: string; // Corporate ID if user belongs to a corporate
  referralCode?: string; // Shareable referral code for this user
  referredByUserId?: string; // Referrer user ID if referral was applied

  // Status fields
  isActive?: boolean;
  isVerified?: boolean;
  isCorporateEmailVerified?: boolean;
  createdSource?: 'self_signup' | 'pharmacy_app';
  createdByRole?: string;
  createdById?: string;
  otpVerified?: boolean;
  linkedPharmacyId?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateUserRequest {
  email?: string;
  corporateEmail?: string;
  phone?: string;
  userType: 'user';
  name?: string;
  age?: number;
  profilePictureUrl?: string;
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
  height?: number;
  weight?: number;
  emergencyContact?: {
    name?: string;
    phone?: string;
    relationship?: string;
  };
  address?: string;
  latitude?: number;
  longitude?: number;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  corporateId?: string; // Corporate ID if user belongs to a corporate
  referralCode?: string;
  referredByUserId?: string;
  isActive?: boolean;
  isVerified?: boolean;
  isCorporateEmailVerified?: boolean;
  createdSource?: 'self_signup' | 'pharmacy_app';
  createdByRole?: string;
  createdById?: string;
  otpVerified?: boolean;
  linkedPharmacyId?: string;
}

export interface UpdateUserRequest {
  email?: string;
  corporateEmail?: string;
  phone?: string;
  userType?: 'user';
  name?: string;
  age?: number;
  profilePictureUrl?: string;
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
  height?: number;
  weight?: number;
  emergencyContact?: {
    name?: string;
    phone?: string;
    relationship?: string;
  };
  address?: string;
  latitude?: number;
  longitude?: number;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  corporateId?: string; // Corporate ID if user belongs to a corporate
  referralCode?: string;
  referredByUserId?: string;
  isCorporateUser?: boolean;
  isActive?: boolean;
  isVerified?: boolean;
  isCorporateEmailVerified?: boolean;
  createdSource?: 'self_signup' | 'pharmacy_app';
  createdByRole?: string;
  createdById?: string;
  otpVerified?: boolean;
  linkedPharmacyId?: string;
}

export interface UserQueryParams {
  userType?: 'user';
  name?: string;
  email?: string;
  phone?: string;
  corporateId?: string; // Filter by corporate ID
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  forUser?: boolean;
}
