export interface ICorporate {
  _id?: string;
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  contactPerson?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  logoUrl?: string;
  website?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  description?: string;
  specialistIds?: string[];
  wellnessPackageIds?: string[];
  isActive?: boolean;
  isVerified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateCorporateRequest {
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  contactPerson?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  logoUrl?: string;
  website?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  description?: string;
  specialistIds?: string[];
  wellnessPackageIds?: string[];
  isActive?: boolean;
  isVerified?: boolean;
}

export interface UpdateCorporateRequest {
  name?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  contactPerson?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  logoUrl?: string;
  website?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  description?: string;
  specialistIds?: string[];
  wellnessPackageIds?: string[];
  isActive?: boolean;
  isVerified?: boolean;
}

export interface CorporateQueryParams {
  name?: string;
  companyName?: string;
  email?: string;
  contactPerson?: string;
  industry?: string;
  city?: string;
  state?: string;
  country?: string;
  isActive?: boolean;
  isVerified?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
