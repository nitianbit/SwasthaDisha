import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { FileService } from '../services';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import { FileDocumentService } from '../documents';
import { legacyPath } from '../storage';
import { actor, documentError, input } from '../validation';
import { decideFileAccess } from '../access';

const privateResponses = new WeakSet<Response>();

/** One header policy shared by pre-auth private routes, handlers and reserved-subtree denials. */
export function applyPrivateDocumentHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Pragma', 'no-cache');
  res.vary('Authorization'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('ETag'); res.removeHeader('Last-Modified');
  // Express computes freshness before end(), so suppress only private cache validators first.
  delete res.req.headers['if-none-match']; delete res.req.headers['if-modified-since'];
  if (!privateResponses.has(res)) {
    privateResponses.add(res);
    const end = res.end;
    res.end = function (this: Response, ...args: Parameters<Response['end']>): Response {
      if (!this.headersSent) { this.removeHeader('ETag'); this.removeHeader('Last-Modified'); }
      return end.apply(this, args);
    } as Response['end'];
  }
}

export class FileController {
  private fileService: FileService;
  private documents: FileDocumentService;

  constructor() {
    this.fileService = Container.get(FileService);
    this.documents = Container.get(FileDocumentService);
  }

  private async privateRequest(res: Response, work: () => Promise<void>): Promise<void> {
    applyPrivateDocumentHeaders(res);
    try { await work(); } catch (error) {
      if (res.headersSent && !res.destroyed) res.destroy();
      if (error instanceof AppError && typeof error.code === 'string' && error.code.startsWith('DOCUMENT_')) throw error;
      throw documentError();
    }
  }

  private privateJson(res: Response, status: number, data: unknown): void {
    const body = JSON.stringify({ success: true, data });
    if (Buffer.byteLength(body, 'utf8') >= 65536) throw documentError();
    res.status(status).type('application/json').send(body);
  }

  uploadPrivateAsset = async (req: AuthRequest, res: Response, _next: NextFunction): Promise<void> => {
    await this.privateRequest(res, async () => {
      const result = await this.documents.upload(req.user, req.query, 'unbound_upload', undefined, req);
      this.privateJson(res, result.created ? 201 : 200, result.data);
    });
  };

  uploadClinicalAsset = async (req: AuthRequest, res: Response, _next: NextFunction): Promise<void> => {
    await this.privateRequest(res, async () => {
      actor(req.user);
      input(req.params.resourceKind === 'booking' || req.params.resourceKind === 'external_booking');
      const result = await this.documents.upload(req.user, req.query, req.params.resourceKind, req.params.resourceId, req);
      this.privateJson(res, result.created ? 201 : 200, result.data);
    });
  };

  listAssetVersions = async (req: AuthRequest, res: Response, _next: NextFunction): Promise<void> => {
    await this.privateRequest(res, async () => this.privateJson(res, 200, await this.documents.list(req.user, req.params.assetId, req.query)));
  };

  readAssetContent = async (req: AuthRequest, res: Response, _next: NextFunction): Promise<void> => {
    await this.privateRequest(res, async () => this.documents.content(req.user, req.params.assetId, req.params.versionId, req.query, req, res));
  };

  revokePrivateAsset = async (req: AuthRequest, res: Response, _next: NextFunction): Promise<void> => {
    await this.privateRequest(res, async () => this.privateJson(res, 200, await this.documents.revoke(req.user, req.params.assetId, req.body)));
  };

  private legacyFilePath(raw: unknown, root: string, res: Response): string {
    try { return legacyPath(raw, root); } catch (error) {
      applyPrivateDocumentHeaders(res);
      if (error instanceof AppError) throw error;
      throw documentError();
    }
  }

  uploadFiles = async (req: Request, res: Response, _next: NextFunction) => {
    // Get module from params or form data
    const module = (req.params.module as string) || req.body?.module || 'general';
    const recordId = req.body?.recordId as string | undefined;

    const files = await this.fileService.uploadFiles(req, module, recordId).catch(error => {
      if (error instanceof AppError && typeof error.code === 'string' && error.code.startsWith('DOCUMENT_')) {
        applyPrivateDocumentHeaders(res);
      }
      throw error;
    });

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

    if (typeof url !== 'string' || url.length === 0 || url.length > 1024) {
      res.status(400).json({
        success: false,
        message: 'URL parameter is required. Example: /api/v1/file/fetch?url=/api/v1/file/static/bookings/12345/document.pdf',
      });
      return;
    }

    // Extract file path from URL
    // Remove /api/v1/file/static/ or /api/v1/file/ prefix
    let filePath: string;
    if (url.startsWith('/api/static/')) {
      filePath = url.slice('/api/static/'.length);
    } else if (url.startsWith('/api/v1/file/static/')) {
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

    await this.serveFileByPath(filePath, res, (req as AuthRequest).user);
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

    await this.serveFileByPath(filePath, res, (req as AuthRequest).user);
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
    const fullPath = this.legacyFilePath(filePath, uploadDir, res);

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
    await this.serveFileByPath(filePath, res, (req as AuthRequest).user);
  };

  /**
   * The one read path of every legacy alias (/api/static, /api/v1/file/static, /api/v1/file/fetch). D1: the path guard
   * runs first, then the access decision, and only then is the file looked at, so an unauthorised reader learns nothing
   * about whether it exists.
   */
  private async serveFileByPath(filePath: unknown, res: Response, reader: AuthRequest['user']): Promise<void> {
    if (typeof filePath !== 'string') { applyPrivateDocumentHeaders(res); throw documentError(400, 'DOCUMENT_INPUT_INVALID'); }
    const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
    const fullPath = this.legacyFilePath(filePath, uploadDir, res);
    let decision;
    try { decision = await decideFileAccess(reader, filePath); } catch {
      applyPrivateDocumentHeaders(res);
      throw documentError();
    }
    if (!decision.allow) {
      applyPrivateDocumentHeaders(res);
      if (decision.status === 401) {
        res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Sign in to open this file' });
      } else {
        res.status(404).json({ success: false, message: 'File not found' });
      }
      return;
    }
    if (decision.visibility === 'private') applyPrivateDocumentHeaders(res);

    let stats: fs.Stats;
    try { stats = fs.statSync(fullPath); } catch {
      res.status(404).json({ success: false, message: 'File not found' });
      return;
    }
    if (!stats.isFile()) {
      res.status(404).json({ success: false, message: 'File not found' });
      return;
    }
    const file = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const fileName = path.basename(fullPath).replace(/[^A-Za-z0-9._-]/g, '_');
    const html = ext === '.html' || ext === '.htm';

    res.setHeader('Content-Length', file.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (html) {
      // Payout invoices/receipts: never rendered in the API origin.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Security-Policy', 'sandbox');
    } else {
      res.setHeader('Content-Type', mime.contentType(ext) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    }
    if (decision.visibility === 'public') {
      // Short, so that withdrawing a public grant is honoured within the hour.
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    res.send(file);
  }
}
