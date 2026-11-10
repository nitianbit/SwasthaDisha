export interface ITestCategory {
  categoryName: string;
  categoryTestsCount: number;
  subTests: string[];
}

export interface IWellnessPackage {
  _id?: string;
  name: string;
  description?: string;
  bookingProcedure?: string;
  imageUrl?: string;
  originalPrice: number;
  discountedPrice: number;
  totalTestsCount: number;
  hasFreeDoctorConsultation: boolean;
  testsIncluded: ITestCategory[];
  category?: string;
  isActive?: boolean;
  isPopular?: boolean;
  order?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateWellnessPackageRequest {
  name: string;
  description?: string;
  bookingProcedure?: string;
  imageUrl?: string;
  originalPrice: number;
  discountedPrice: number;
  totalTestsCount: number;
  hasFreeDoctorConsultation?: boolean;
  testsIncluded: ITestCategory[];
  category?: string;
  isActive?: boolean;
  isPopular?: boolean;
  order?: number;
}

export interface UpdateWellnessPackageRequest {
  name?: string;
  description?: string;
  bookingProcedure?: string;
  imageUrl?: string;
  originalPrice?: number;
  discountedPrice?: number;
  totalTestsCount?: number;
  hasFreeDoctorConsultation?: boolean;
  testsIncluded?: ITestCategory[];
  category?: string;
  isActive?: boolean;
  isPopular?: boolean;
  order?: number;
}

export interface WellnessPackageQueryParams {
  name?: string;
  category?: string;
  isActive?: boolean;
  isPopular?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  minPrice?: number;
  maxPrice?: number;
  forUser?: boolean;
}
