import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { AuthRequest } from '@/modules/middleware/auth';

export class PharmacyCustomerController {
  private service: PharmacyCustomerService;

  constructor() {
    this.service = Container.get(PharmacyCustomerService);
  }

  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const createdById = req.user?._id || '';
    const createdByRole = req.user?.userType || 'pharmacy';

    const result = await this.service.createCustomer(
      { ...req.body, pharmacyId },
      createdById,
      createdByRole
    );

    res.status(201).json({
      success: true,
      message: result.isNewUser ? 'New user created and linked' : 'Customer linked to pharmacy',
      data: result,
    });
  };

  list = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const pharmacyId = req.user?.pharmacyId || '';
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const search = req.query.search as string | undefined;

    const result = await this.service.getCustomers({ pharmacyId, page, limit, search });

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: { page: result.page, limit, total: result.total, totalPages: result.totalPages },
    });
  };
}
