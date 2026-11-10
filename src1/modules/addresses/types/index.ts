export interface IAddress {
  _id?: string;
  userId: string;
  type?: 'Home' | 'Work' | 'Other';
  label?: string;
  address: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateAddressRequest {
  userId?: string;
  type?: 'Home' | 'Work' | 'Other';
  label?: string;
  address: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface UpdateAddressRequest {
  type?: 'Home' | 'Work' | 'Other';
  label?: string;
  address?: string;
  landmark?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface AddressQueryParams {
  userId?: string;
  type?: 'Home' | 'Work' | 'Other';
  isDefault?: boolean;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
