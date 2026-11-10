import { Service } from 'typedi';
import { OrderHealthCheckRepository } from '@/modules/orderHealthChecks/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import {
  IOrderHealthCheck,
  CreateHealthCheckRequest,
  UpdateHealthCheckRequest,
} from '@/modules/orderHealthChecks/types';
import { AppError } from '@/modules/common/types';

@Service()
export class OrderHealthCheckService {
  constructor(
    private repo: OrderHealthCheckRepository,
    private orderService: PharmacyOrderService
  ) {}

  async create(
    pharmacyId: string,
    checkedBy: string,
    data: CreateHealthCheckRequest
  ): Promise<IOrderHealthCheck> {
    const order = await this.orderService.getById(data.orderId, checkedBy, 'pharmacy');
    if (String(order.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Order does not belong to this pharmacy' });
    }
    if (!order.customerId) {
      throw new AppError({
        status: 400,
        code: 'CUSTOMER_REQUIRED',
        message: 'Health checks can only be recorded for customer-linked orders',
      });
    }

    const existing = await this.repo.findByOrder(data.orderId);
    if (existing) {
      throw new AppError({ status: 400, code: 'HEALTH_CHECK_EXISTS', message: 'Health check already recorded for this order' });
    }

    const record = await this.repo.save({
      orderId: data.orderId,
      pharmacyId,
      userId: String(order.customerId),
      checkedBy,
      systolicBP: data.systolicBP,
      diastolicBP: data.diastolicBP,
      fastingSugar: data.fastingSugar,
      postMealSugar: data.postMealSugar,
      hba1c: data.hba1c,
      notes: data.notes,
      checkedAt: new Date(),
    });

    // Link back to the order
    await this.orderService.linkHealthCheck(data.orderId, String(record._id));

    return record;
  }

  async update(
    orderId: string,
    pharmacyId: string,
    data: UpdateHealthCheckRequest
  ): Promise<IOrderHealthCheck> {
    const existing = await this.repo.findByOrder(orderId);
    if (!existing) {
      throw new AppError({ status: 404, code: 'HEALTH_CHECK_NOT_FOUND', message: 'Health check not found' });
    }
    if (String(existing.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    const updated = await this.repo.update({ orderId }, data);
    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update health check' });
    }
    return updated;
  }

  async getByOrder(orderId: string, requesterId: string, requesterRole: string): Promise<IOrderHealthCheck> {
    await this.orderService.getById(orderId, requesterId, requesterRole);
    const record = await this.repo.findByOrder(orderId);
    if (!record) {
      throw new AppError({ status: 404, code: 'HEALTH_CHECK_NOT_FOUND', message: 'Health check not found' });
    }
    return record;
  }
}
