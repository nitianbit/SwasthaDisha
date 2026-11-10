import { Service } from 'typedi';
import { Model } from 'mongoose';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { IPharmacyOrder, OrderQueryParams } from '@/modules/pharmacyOrders/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class PharmacyOrderRepository extends BaseRepository<IPharmacyOrder> {
  constructor() {
    super(PharmacyOrderModel as Model<IPharmacyOrder>);
  }

  private applyCommonFilters(query: Record<string, unknown>, filter: OrderQueryParams): Record<string, unknown> {
    const effectiveCustomerId = filter.userId || filter.customerId;
    if (effectiveCustomerId) {
      query.customerId = effectiveCustomerId;
    }
    if (filter.buyerPharmacyId) {
      query.buyerPharmacyId = filter.buyerPharmacyId;
    }
    if (filter.orderType) {
      query.orderType = filter.orderType;
    }
    if (filter.orderFor === 'consultation') {
      query.linkedConsultationId = { $exists: true, $ne: null };
    }
    if (filter.orderFor === 'diagnostic') {
      query.linkedDiagnosticOrderId = { $exists: true, $nin: [null, ''] };
    }
    if (filter.status) query.status = filter.status;
    if (filter.paymentStatus) query.paymentStatus = filter.paymentStatus;

    return query;
  }

  private buildAdminQuery(filter: OrderQueryParams): Record<string, unknown> {
    const query: Record<string, unknown> = {};

    if (filter.pharmacyId) {
      query.pharmacyId = filter.pharmacyId;
    }

    return this.applyCommonFilters(query, filter);
  }

  private buildPharmacyViewerQuery(filter: OrderQueryParams): Record<string, unknown> {
    const query: Record<string, unknown> = {
      $or: [
        { pharmacyId: filter.viewerPharmacyId },
        { buyerPharmacyId: filter.viewerPharmacyId },
      ],
    };

    return this.applyCommonFilters(query, filter);
  }

  private buildUserQuery(filter: OrderQueryParams): Record<string, unknown> {
    return this.applyCommonFilters({}, filter);
  }

  private buildQuery(filter: OrderQueryParams): Record<string, unknown> {
    if (filter.viewerPharmacyId) {
      return this.buildPharmacyViewerQuery(filter);
    }

    if (filter.userId || filter.customerId) {
      return this.buildUserQuery(filter);
    }

    return this.buildAdminQuery(filter);
  }

  async findWithPagination(
    filter: OrderQueryParams,
    page: number = 1,
    limit: number = 20
  ): Promise<{ data: IPharmacyOrder[]; total: number; page: number; totalPages: number }> {
    const query = this.buildQuery(filter);

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PharmacyOrderModel.find(query)
        .populate('customerId', 'name phone')
        .populate('buyerPharmacyId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PharmacyOrderModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findByCustomer(customerId: string, page = 1, limit = 20) {
    return this.findWithPagination({ customerId }, page, limit);
  }

  async findStalePendingOnlineOrders(
    cutoff: Date,
    limit = 200
  ): Promise<IPharmacyOrder[]> {
    const rows = await PharmacyOrderModel.find({
      orderType: 'online',
      paymentMode: 'online_payment',
      paymentStatus: 'pending',
      status: 'placed',
      createdAt: { $lt: cutoff },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    return rows as IPharmacyOrder[];
  }
}
