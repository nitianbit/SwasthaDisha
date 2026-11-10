import { Service } from 'typedi';
import { Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import PaymentRecordModel from '@/modules/payment/model';
import { IPaymentRecord } from '@/modules/payment/types';

@Service()
export class PaymentRepository extends BaseRepository<IPaymentRecord> {
  constructor() {
    super(PaymentRecordModel as Model<IPaymentRecord>);
  }

  async findByRazorpayOrderId(razorpayOrderId: string): Promise<IPaymentRecord | null> {
    return this.findOne({ razorpayOrderId });
  }
}
