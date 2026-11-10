import { Service } from 'typedi';
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { IUploadedFile } from '../types';
import { AppError } from '@/modules/common/types';

@Service()
export class FileService {
  private readonly uploadDir: string;
  private readonly maxFileSize: number = 10 * 1024 * 1024; // 10MB
  private readonly allowedMimeTypes: string[] = [
    'image/jpeg',
    'image/png',
    'image/jpg',
    'application/pdf',
    'application/octet-stream',
    'image/webp',
  ];

  constructor() {
    // Set upload directory (adjust based on your settings)
    // Default to files directory in project root
    this.uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'files');
    this.ensureDirectoryExists(this.uploadDir);
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private parseFormData(req: any): Promise<{ fields: any; files: any }> {
    return new Promise((resolve, reject) => {
      const form = formidable({
        maxFileSize: this.maxFileSize,
        keepExtensions: true,
        multiples: true,
      });

      form.parse(req, (err, fields, files) => {
        if (err) {
          reject(err);
        } else {
          // Convert fields to plain object
          const parsedFields: any = {};
          for (const key in fields) {
            parsedFields[key] = Array.isArray(fields[key])
              ? fields[key][0]
              : fields[key];
          }
          resolve({ fields: parsedFields, files });
        }
      });
    });
  }

  async uploadFiles(
    req: any,
    module: string,
    recordId?: string
  ): Promise<IUploadedFile[]> {
    try {
      const { files } = await this.parseFormData(req);

      // Get files from request (formidable returns files as object)
      const fileArray = Array.isArray(files.files)
        ? files.files
        : files.files
        ? [files.files]
        : [];

      if (fileArray.length === 0) {
        throw new AppError({
          status: 400,
          code: 'NO_FILES',
          message: 'No files provided',
        });
      }

      const uploadedFiles: IUploadedFile[] = [];
      const timestamp = Date.now();

      // Create module directory if it doesn't exist
      const moduleDir = recordId
        ? path.join(this.uploadDir, module, recordId)
        : path.join(this.uploadDir, module);
      this.ensureDirectoryExists(moduleDir);

      for (const file of fileArray) {
        if (!file) continue;

        // Validate file size
        if (file.size > this.maxFileSize) {
          throw new AppError({
            status: 400,
            code: 'FILE_TOO_LARGE',
            message: `File ${file.originalFilename} exceeds maximum size of ${this.maxFileSize / 1024 / 1024}MB`,
          });
        }

        // Validate mime type
        const mimeType = mime.lookup(file.filepath) || 'application/octet-stream';
        if (!this.allowedMimeTypes.includes(mimeType)) {
          throw new AppError({
            status: 400,
            code: 'INVALID_FILE_TYPE',
            message: `File type ${mimeType} is not allowed. Allowed types: ${this.allowedMimeTypes.join(', ')}`,
          });
        }

        // Read file data
        const fileData = fs.readFileSync(file.filepath);
        const fileExt = path.extname(file.originalFilename || '');
        const baseName = path.basename(file.newFilename, path.extname(file.newFilename));
        const fileName = `${timestamp}-${baseName}${fileExt}`;
        const filePath = path.join(moduleDir, fileName);
        

        // Save file
        fs.writeFileSync(filePath, fileData);

        // Generate relative path - store relative path in database
        const relativePath = recordId
          ? `${module}/${recordId}/${fileName}`
          : `${module}/${fileName}`;
        // Store relative path that can be accessed via /api/static/*
        const url = `/api/static/${relativePath}`;

        uploadedFiles.push({
          url,
          fileName,
          originalFileName: file.originalFilename || fileName,
          fileSize: file.size,
          mimeType,
        });

        // Clean up temp file
        try {
          fs.unlinkSync(file.filepath);
        } catch (err) {
          // Ignore cleanup errors
        }
      }

      return uploadedFiles;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError({
        status: 500,
        code: 'UPLOAD_FAILED',
        message: error.message || 'File upload failed',
      });
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      // Extract relative path from URL (handle both full URLs and relative paths)
      let relativePath = filePath;
      // Remove base URL if present
      if (filePath.includes('/api/static/')) {
        relativePath = filePath.split('/api/static/')[1];
      } else if (filePath.includes('/api/v1/file/static/')) {
        relativePath = filePath.split('/api/v1/file/static/')[1];
      }
      const fullPath = path.join(this.uploadDir, relativePath);

      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        
        // Optionally clean up empty directories
        const dirPath = path.dirname(fullPath);
        try {
          const dirContents = fs.readdirSync(dirPath);
          if (dirContents.length === 0) {
            fs.rmdirSync(dirPath);
          }
        } catch (err) {
          // Ignore directory cleanup errors
        }
      }
    } catch (error: any) {
      throw new AppError({
        status: 500,
        code: 'DELETE_FAILED',
        message: error.message || 'File deletion failed',
      });
    }
  }
}
