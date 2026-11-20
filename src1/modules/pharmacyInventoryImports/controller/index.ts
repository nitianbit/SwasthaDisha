import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { promises as fs } from 'fs';
import { ImportMode, IInventoryImport } from '@/modules/pharmacyInventoryImports/types';

const IMPORT_MODES = ['create_only', 'update_only', 'upsert'] as const;

/** Q15: what the pharmacy sees of an import — never where the server stored the file (nor Mongo internals). */
function publicImportView(record: IInventoryImport): Omit<IInventoryImport, 'filePath'> {
  const { filePath: _f, __v: _v, ...rest } = record as IInventoryImport & { __v?: unknown };
  return rest;
}

export class InventoryImportController {
  private service: InventoryImportService;

  constructor() {
    this.service = Container.get(InventoryImportService);
  }

  preview = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    if (!req.file) {
      throw new AppError({ status: 400, code: 'FILE_REQUIRED', message: 'No file uploaded' });
    }

    const pharmacyId = req.user?.pharmacyId || '';
    // Q15: an unknown import mode is a 400 (the uploaded file is removed), not a failed save.
    const rawMode = req.body?.importMode;
    if (rawMode !== undefined && rawMode !== '' && !(typeof rawMode === 'string' && (IMPORT_MODES as readonly string[]).includes(rawMode))) {
      await fs.unlink(req.file.path).catch(() => undefined);
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: `importMode must be one of: ${IMPORT_MODES.join(', ')}` });
    }
    const importMode = (rawMode as ImportMode) || 'upsert';

    const result = await this.service.preview(
      pharmacyId,
      req.user?._id || '',
      req.user?.userType || 'pharmacy',
      req.file.originalname,
      req.file.path,
      importMode
    );

    res.status(200).json({ success: true, message: 'Preview ready', data: publicImportView(result) });
  };

  commit = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const { importId } = req.body;

    const result = await this.service.commit(importId, pharmacyId);
    res.status(200).json({ success: true, message: 'Import committed', data: publicImportView(result) });
  };

  retry = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.retry(req.params.id, req.user?.pharmacyId || '');
    res.status(200).json({ success: true, message: 'Failed import rows retried', data: publicImportView(result) });
  };

  downloadFailedRows = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const buffer = await this.service.buildFailedRowsWorkbook(
      req.params.id,
      req.user?.pharmacyId || ''
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="inventory-import-${req.params.id}-failed.xlsx"`);
    res.status(200).send(buffer);
  };

  list = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    const result = await this.service.getImports(pharmacyId, page, limit);
    res.status(200).json({
      success: true,
      data: result.data.map(publicImportView),
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.getImportById(req.params.id, pharmacyId);
    res.status(200).json({ success: true, data: publicImportView(result) });
  };
}
