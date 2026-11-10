export interface IHealthTip {
  _id?: string;
  title: string;
  description: string;
  shortDescription?: string;
  icon?: string;
  imageUrl?: string;
  category?: string;
  isActive?: boolean;
  order?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateHealthTipRequest {
  title: string;
  description: string;
  shortDescription?: string;
  icon?: string;
  imageUrl?: string;
  category?: string;
  isActive?: boolean;
  order?: number;
}

export interface UpdateHealthTipRequest {
  title?: string;
  description?: string;
  shortDescription?: string;
  icon?: string;
  imageUrl?: string;
  category?: string;
  isActive?: boolean;
  order?: number;
}

export interface HealthTipQueryParams {
  title?: string;
  category?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
