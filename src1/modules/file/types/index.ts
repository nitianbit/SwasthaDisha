export interface IUploadedFile {
  url: string;
  fileName: string;
  originalFileName: string;
  fileSize?: number;
  mimeType?: string;
}

export interface UploadFileRequest {
  module: string; // e.g., "bookings", "dependents", "specialists"
  recordId?: string; // Optional record ID for organizing files
}

export interface UploadFileResponse {
  files: IUploadedFile[];
}
