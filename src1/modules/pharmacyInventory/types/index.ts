export type InventoryAdjustmentReason =
  | 'purchase'
  | 'return'
  | 'damage'
  | 'expiry'
  | 'correction'
  | 'transfer'
  | 'other';

export type InventoryBatchStatus =
  | 'active'
  | 'depleted'
  | 'expired'
  | 'recalled'
  | 'quarantined';

export const INVENTORY_QUALITY_HOLD_STATUSES = ['recalled', 'quarantined', 'expired'] as const;
export type InventoryQualityHoldStatus = Extract<InventoryBatchStatus, typeof INVENTORY_QUALITY_HOLD_STATUSES[number]>;

export interface InventoryQualityWorklistQuery {
  qualityStatus?: InventoryQualityHoldStatus;
  page?: number;
  limit?: number;
}

export interface InventoryQualityWorklistRow {
  inventoryItemId: string;
  medicineId: string | null;
  medicineName: string | null;
  inventoryIsActive: boolean | null;
  rackLocation: string | null;
  batchId: string | null;
  batchPosition: number;
  batchNumberRaw: string | null;
  expiryDateRaw: string | null;
  storedQualityStatus: InventoryQualityHoldStatus;
  availableQty: number | null;
  reservedQty: number | null;
  freeQty: number | null;
}

export interface InventoryQualityWorklistPage {
  data: InventoryQualityWorklistRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface IInventoryBatch {
  _id?: string;
  batchNumber: string;
  expiryDate: string;
  receivedAt: Date;
  availableQty: number;
  reservedQty: number;
  freeQty: number;
  purchasePrice?: number;
  mrp?: number;
  retailPrice?: number;
  wholesalePrice?: number;
  status: InventoryBatchStatus;
  depletedAt?: Date;
}

export interface IInventoryBatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
}

export interface IInventoryItem {
  _id?: string;
  pharmacyId: string;
  medicineId: string;
  availableQty: number;
  reservedQty: number;
  freeQty: number;
  batches?: IInventoryBatch[];
  lowStockNotifiedAt?: Date;
  reorderThreshold?: number;
  rackLocation?: string;
  purchasePrice?: number;
  retailPrice?: number;
  wholesalePrice?: number;
  batchNumber?: string;
  expiryDate?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInventoryAdjustment {
  _id?: string;
  pharmacyId: string;
  medicineId: string;
  inventoryItemId: string;
  adjustmentType: 'add' | 'remove' | 'correction';
  quantity: number;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: string;
  availableQtyBefore?: number;
  availableQtyAfter?: number;
  sourceType?: 'manual' | 'inventory_import' | 'order';
  sourceId?: string;
  sourceRowIndex?: number;
  reason: InventoryAdjustmentReason;
  notes?: string;
  adjustedBy: string;
  adjustedByRole: string;
  createdAt?: Date;
}

export type InventoryReservationType = 'order' | 'manual';
export type InventoryReservationStatus = 'active' | 'closed';

export interface IInventoryReservation {
  _id?: string;
  pharmacyId: string;
  medicineId: string;
  orderId?: string;
  reservationType: InventoryReservationType;
  quantity: number;
  remainingQty: number;
  consumedQty: number;
  releasedQty: number;
  reason?: string;
  notes?: string;
  createdBy?: string;
  createdByRole?: string;
  status: InventoryReservationStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateInventoryItemRequest {
  pharmacyId: string;
  medicineId: string;
  quantity?: number;
  reorderThreshold?: number;
  rackLocation?: string;
  purchasePrice?: number;
  mrp?: number;
  retailPrice?: number;
  wholesalePrice?: number;
  batchNumber?: string;
  expiryDate?: string;
  reason?: InventoryAdjustmentReason;
  notes?: string;
}

export interface CreateInventoryItemsRequest {
  items: CreateInventoryItemRequest[];
}

export interface InventoryQueryParams {
  pharmacyId?: string;
  medicineId?: string;
  isActive?: boolean;
  lowStock?: boolean;
  search?: string;
  includeBatches?: boolean;
  page?: number;
  limit?: number;
}

export interface PublicInventoryQueryParams {
  pharmacyId: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PublicInventoryItemDto {
  inventoryItemId: string;
  pharmacyId: string;
  medicineId: string;
  name: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  dosageForm?: string;
  strength?: string;
  manufacturer?: string;
  prescriptionRequired?: boolean;
  availableQty: number;
  retailPrice?: number;
  wholesalePrice?: number;
  batchNumber?: string;
  expiryDate?: string;
}

export interface AdjustInventoryRequest {
  quantity: number;
  reason: InventoryAdjustmentReason;
  notes?: string;
}

export interface ReserveReleaseRequest {
  quantity: number;
}

export interface ManualInventoryReservationItem {
  medicineId: string;
  quantity: number;
}

export interface ManualInventoryReservationRequest {
  items: ManualInventoryReservationItem[];
  reason?: string;
  notes?: string;
}
