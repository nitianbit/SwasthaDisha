export interface UpdateAdminProfileRequest {
  name?: string;
  email?: string;
  profilePictureUrl?: string;
  department?: string;
  employeeId?: string;
  permissions?: string[];
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  isActive?: boolean;
}

export interface AdminQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  forUser?: boolean;
}

export interface IAdmin {
  _id?: string;
  email?: string;
  phone?: string;
  userType: 'admin';
  name?: string;
  profilePictureUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  department?: string;
  employeeId?: string;
  permissions?: string[];
  isActive?: boolean;
  isVerified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
