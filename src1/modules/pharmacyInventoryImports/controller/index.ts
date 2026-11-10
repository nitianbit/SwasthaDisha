import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { ImportMode } from '@/modules/pharmacyInventoryImports/types';

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
    const importMode = (req.body.importMode as ImportMode) || 'upsert';

    const result = await this.service.preview(
      pharmacyId,
      req.user?._id || '',
      req.user?.userType || 'pharmacy',
      req.file.originalname,
      req.file.path,
      importMode
    );

    res.status(200).json({ success: true, message: 'Preview ready', data: result });
  };

  commit = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const { importId } = req.body;

    const result = await this.service.commit(importId, pharmacyId);
    res.status(200).json({ success: true, message: 'Import committed', data: result });
  };

  retry = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.service.retry(req.params.id, req.user?.pharmacyId || '');
    res.status(200).json({ success: true, message: 'Failed import rows retried', data: result });
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
      data: result.data,
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };

  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const result = await this.service.getImportById(req.params.id, pharmacyId);
    res.status(200).json({ success: true, data: result });
  };
}
