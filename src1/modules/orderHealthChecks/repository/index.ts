import { Service } from 'typedi';
import { Model } from 'mongoose';
import OrderHealthCheckModel from '@/modules/orderHealthChecks/model';
import { IOrderHealthCheck } from '@/modules/orderHealthChecks/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class OrderHealthCheckRepository extends BaseRepository<IOrderHealthCheck> {
  constructor() {
    super(OrderHealthCheckModel as Model<IOrderHealthCheck>);
  }

  async findByOrder(orderId: string): Promise<IOrderHealthCheck | null> {
    return this.findOne({ orderId });
  }

  async findByUserAndPharmacy(userId: string, pharmacyId: string): Promise<IOrderHealthCheck[]> {
    return this.findAll({ userId, pharmacyId }, { sort: { checkedAt: -1 } });
  }
}
