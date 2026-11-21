export type ImportStatus =
  | 'pending'
  | 'previewed'
  | 'committing'
  | 'committed'
  | 'partially_committed'
  | 'failed';

export interface ImportCommitError {
  rowIndex: number;
  medicineName?: string;
  error: string;
  code?: string;
  retryable?: boolean;
}
export type ImportMode = 'create_only' | 'update_only' | 'upsert';

export interface ImportCurrentPrices {
  mrp: number | null;
  retailPrice: number | null;
  wholesalePrice: number | null;
  purchasePrice: number | null;
}

export interface ImportRowResult {
  rowIndex: number;
  medicineName?: string;
  status: 'valid' | 'error' | 'skipped' | 'committed' | 'failed';
  errors?: string[];
  /** Q16c: the pharmacy already has this medicine in its inventory (an inventory record, whatever its quantity). */
  inMyStock?: boolean;
  /** Q16c: the pharmacy's current prices for it (MRP from the row's batch, else the latest batch); null if not stocked. */
  currentPrices?: ImportCurrentPrices | null;
  data?: Record<string, any> & {
    medicineId?: string;
    medicineMatchStatus?: 'matched' | 'not_found' | 'duplicate';
    matchedMedicineName?: string;
  };
}

export interface IInventoryImport {
  _id?: string;
  pharmacyId: string;
  uploadedBy: string;
  uploadedByRole: string;
  fileName: string;
  filePath: string;
  importMode: ImportMode;
  /** Q16c: the supplier chosen for the whole file (optional; rows may name their own in a "supplier" column). */
  supplierId?: string;
  status: ImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  committedRows?: number;
  failedRows?: number;
  commitErrors?: ImportCommitError[];
  previewRows?: ImportRowResult[];
  errorSummary?: string;
  createdAt?: Date;
  updatedAt?: Date;
  committedAt?: Date;
  sourceFileDeletedAt?: Date;
}

export interface ImportPreviewRequest {
  importMode?: ImportMode;
}

export interface CommitImportRequest {
  importId: string;
}
