export interface IPartner {
  _id?: string;
  name: string;
  logoUrl?: string;
  description?: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  partnerType?: string; // e.g., "hospital", "lab", "clinic", "pharmacy"
  isActive?: boolean;
  isVerified?: boolean;
  order?: number; // For display ordering
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreatePartnerRequest {
  name: string;
  logoUrl?: string;
  description?: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  partnerType?: string;
  isActive?: boolean;
  isVerified?: boolean;
  order?: number;
}

export interface UpdatePartnerRequest {
  name?: string;
  logoUrl?: string;
  description?: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  partnerType?: string;
  isActive?: boolean;
  isVerified?: boolean;
  order?: number;
}

export interface PartnerQueryParams {
  name?: string;
  email?: string;
  partnerType?: string;
  isActive?: boolean;
  isVerified?: boolean;
  city?: string;
  state?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
