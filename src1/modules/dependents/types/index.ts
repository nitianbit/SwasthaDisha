export interface IDependent {
  _id?: string;
  userId: string; // The user who added this dependent
  name: string;
  relationship: string; // e.g., "Me", "Father", "Mother", "Spouse", "Son", "Daughter", etc.
  age?: number;
  gender?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string; // YYYYMMDD format
  bloodGroup?: string;
  address?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateDependentRequest {
  userId: string;
  name: string;
  relationship: string;
  age?: number;
  gender?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string; // YYYYMMDD format
  bloodGroup?: string;
  address?: string;
  isActive?: boolean;
}

export interface UpdateDependentRequest {
  name?: string;
  relationship?: string;
  age?: number;
  gender?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string; // YYYYMMDD format
  bloodGroup?: string;
  address?: string;
  isActive?: boolean;
}

export interface DependentQueryParams {
  userId?: string;
  relationship?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
