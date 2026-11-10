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

export interface ImportRowResult {
  rowIndex: number;
  medicineName?: string;
  status: 'valid' | 'error' | 'skipped' | 'committed' | 'failed';
  errors?: string[];
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
