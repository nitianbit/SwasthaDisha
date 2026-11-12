import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { AuthRequest } from '@/modules/middleware/auth';
import { PharmacySupplierService } from '@/modules/pharmacySuppliers/services';
import { supplierUnavailable } from '@/modules/pharmacySuppliers/validation';

export class PharmacySupplierController {
  private service = Container.get(PharmacySupplierService);

  private reply(res: Response, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') >= 512 * 1024) throw supplierUnavailable();
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(status).type('application/json').send(body);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.service.create(req.user?.pharmacyId, req.user?._id, req.body);
    this.reply(res, 201, { success: true, data });
  };

  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.service.update(req.user?.pharmacyId, req.user?._id, req.params.id, req.body);
    this.reply(res, 200, { success: true, data });
  };

  archive = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data = await this.service.archive(req.user?.pharmacyId, req.user?._id, req.params.id, req.body);
    this.reply(res, 200, { success: true, data });
  };

  list = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const query = {
      state: req.query.state,
      page: req.query.page === undefined ? 1 : Number(req.query.page),
      limit: req.query.limit === undefined ? 20 : Number(req.query.limit),
    };
    const result = await this.service.list(req.user?.pharmacyId, query);
    this.reply(res, 200, {
      success: true, data: result.data,
      pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
    });
  };
}
