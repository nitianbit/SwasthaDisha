export interface INews {
  _id?: string;
  title: string;
  description: string;
  image?: string;
  link?: string;
  publishedAt?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateNewsRequest {
  title: string;
  description: string;
  image?: string;
  link?: string;
  publishedAt?: string;
}

export interface UpdateNewsRequest {
  title?: string;
  description?: string;
  image?: string;
  link?: string;
  publishedAt?: string;
}

export interface NewsQueryParams {
  title?: string;
  description?: string;
  publishedAt?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
