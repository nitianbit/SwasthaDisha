import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { FileService } from '../services';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { CONFIG } from '@/config/config';

export class FileController {
  private fileService: FileService;

  constructor() {
    this.fileService = Container.get(FileService);
  }

  uploadFiles = async (req: Request, res: Response, _next: NextFunction) => {
    // Get module from params or form data
    const module = (req.params.module as string) || req.body.module || 'general';
    const recordId = req.body.recordId as string | undefined;

    const files = await this.fileService.uploadFiles(req, module, recordId);

    res.status(200).json({
      success: true,
      message: 'Files uploaded successfully',
      data: { files },
    });
  };

  /**
   * Simple file fetch API - pass URL as query parameter
   * GET /api/v1/file/fetch?url=/api/v1/file/static/bookings/12345/document.pdf
   * GET /api/v1/file/fetch?url=bookings/12345/document.pdf
   */
  fetchFile = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const url = req.query.url as string;

    if (!url) {
      res.status(400).json({
        success: false,
        message: 'URL parameter is required. Example: /api/v1/file/fetch?url=/api/v1/file/static/bookings/12345/document.pdf',
      });
      return;
    }

    // Extract file path from URL
    // Remove /api/v1/file/static/ or /api/v1/file/ prefix
    let filePath: string;
    if (url.startsWith('/api/v1/file/static/')) {
      filePath = url.replace('/api/v1/file/static/', '');
    } else if (url.startsWith('/api/v1/file/')) {
      filePath = url.replace('/api/v1/file/', '');
    } else if (url.startsWith('/')) {
      // If it starts with /, remove it
      filePath = url.substring(1);
    } else {
      // Otherwise use as-is
      filePath = url;
    }

    await this.serveFileByPath(filePath, res);
  };

  /**
   * Serve file by structured path
   * GET /api/v1/file/:module/:fileName
   * GET /api/v1/file/:module/:recordId/:fileName
   */
  serveFileStructured = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const { module, recordId, fileName } = req.params;
    
    // Build file path
    let filePath: string;
    if (recordId) {
      filePath = `${module}/${recordId}/${fileName}`;
    } else {
      filePath = `${module}/${fileName}`;
    }

    await this.serveFileByPath(filePath, res);
  };

  /**
   * Get file info/metadata without downloading
   * GET /api/v1/file/info/:module/:recordId?/:fileName
   */
  getFileInfo = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const { module, recordId, fileName } = req.params;
    
    // Build file path
    let filePath: string;
    if (recordId) {
      filePath = `${module}/${recordId}/${fileName}`;
    } else {
      filePath = `${module}/${fileName}`;
    }

    const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
    const fullPath = path.join(uploadDir, filePath);

    if (!fs.existsSync(fullPath)) {
      res.status(404).json({
        success: false,
        message: 'File not found',
      });
      return;
    }

    const stats = fs.statSync(fullPath);
    const mimeType = mime.contentType(path.extname(fullPath)) || 'application/octet-stream';

    res.status(200).json({
      success: true,
      data: {
        fileName,
        filePath,
        fileSize: stats.size,
        mimeType,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        url: `/api/static/${filePath}`,
      },
    });
  };

  /**
   * Serve file by path (catch-all route for backward compatibility)
   * GET /api/v1/file/static/* (e.g., /api/v1/file/static/bookings/12345/document.pdf)
   */
  serveFile = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const filePath = req.params[0]; // Catch-all parameter
    await this.serveFileByPath(filePath, res);
  };

  /**
   * Internal method to serve file by path
   */
  private async serveFileByPath(filePath: string, res: Response): Promise<void> {
    try {
      // Security: Prevent directory traversal
      if (filePath.includes('..') || filePath.includes('~')) {
        res.status(400).json({
          success: false,
          message: 'Invalid file path',
        });
        return;
      }

      const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
      const fullPath = path.join(uploadDir, filePath);

      if (!fs.existsSync(fullPath)) {
        res.status(404).json({
          success: false,
          message: 'File not found',
        });
        return;
      }

      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        res.status(400).json({
          success: false,
          message: 'Path is not a file',
        });
        return;
      }

      const file = fs.readFileSync(fullPath);
      const contentType = mime.contentType(path.extname(fullPath)) || 'application/octet-stream';
      const fileName = path.basename(fullPath);

      // Set headers
      res.setHeader('Content-Length', file.length);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      
      // Cache headers for better performance
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
      res.setHeader('ETag', `"${stats.mtime.getTime()}"`);
      res.setHeader('Last-Modified', stats.mtime.toUTCString());

      res.send(file);
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Error serving file',
        error: error.message,
      });
    }
  }
}
