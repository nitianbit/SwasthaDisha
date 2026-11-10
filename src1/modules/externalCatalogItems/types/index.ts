export type ExternalCatalogItemType = 'package' | 'test';
export type ExternalCatalogIntegration = 'labstack' | 'healthians';

export interface IExternalCatalogItem {
  _id?: string;
  integration: ExternalCatalogIntegration;
  itemType: ExternalCatalogItemType;
  externalItemId: string;
  name?: string;
  customPrice?: number;
  image?: string;
  coverImage?: string;
  pinned?: boolean;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateExternalCatalogItemRequest {
  integration: ExternalCatalogIntegration;
  itemType: ExternalCatalogItemType;
  externalItemId: string;
  name?: string;
  customPrice?: number;
  image?: string;
  coverImage?: string;
  pinned?: boolean;
  isActive?: boolean;
}

export interface UpdateExternalCatalogItemRequest {
  name?: string;
  customPrice?: number;
  image?: string;
  coverImage?: string;
  pinned?: boolean;
  isActive?: boolean;
}

export interface ExternalCatalogItemQueryParams {
  integration?: ExternalCatalogIntegration;
  itemType?: ExternalCatalogItemType;
  externalItemId?: string;
  name?: string;
  pinned?: boolean;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?:
    | 'createdAt'
    | 'updatedAt'
    | 'externalItemId'
    | 'name'
    | 'customPrice'
    | 'pinned';
  sortOrder?: 'asc' | 'desc';
}
