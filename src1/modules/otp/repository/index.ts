import { Service } from 'typedi';
import { Model } from 'mongoose';
import OTPModel from '@/modules/otp/model';
import { IOTP } from '@/modules/otp/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class OTPRepository extends BaseRepository<IOTP> {
  constructor() {
    super(OTPModel as Model<IOTP>);
  }

  findByUserIdAndTarget = async (
    userId: string,
    target: 'phone' | 'email',
    isVerified: boolean = false,
    targetValue?: string
  ): Promise<IOTP | null> => {
    const query: any = { userId, target, isVerified };
    if (targetValue) {
      query.targetValue = targetValue;
    }
    return this.findOne(query);
  };

  findByUserIdAndOTP = async (
    userId: string,
    otp: string,
    target?: 'phone' | 'email',
    targetValue?: string
  ): Promise<IOTP | null> => {
    const query: any = { userId, otp };
    if (target) {
      query.target = target;
    }
    if (targetValue) {
      query.targetValue = targetValue;
    }
    return this.findOne(query);
  };

  markAsVerified = async (otpId: string): Promise<IOTP | null> => {
    return this.update({ _id: otpId }, { isVerified: true });
  };

  deleteExpiredOTPs = async (): Promise<void> => {
    await this.deleteMany({ expireAt: { $lt: new Date() } });
  };
}
