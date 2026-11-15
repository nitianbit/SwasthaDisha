import { Service } from 'typedi';
import { Model, Types } from 'mongoose';
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

  /** O1: the newest (highest `_id`) unverified code for one destination (older ones are dead even if not yet deleted). */
  findLatestPending = async (
    userId: string,
    target: 'phone' | 'email',
    targetValue?: string
  ): Promise<IOTP | null> => {
    const query: Record<string, unknown> = { userId, target, isVerified: false };
    if (targetValue) query.targetValue = targetValue;
    return OTPModel.findOne(query).sort({ _id: -1 }).lean<IOTP>().exec();
  };

  /** O1: atomically spends one attempt on a live code; null when it is used up, consumed or expired. */
  claimAttempt = async (otpId: string, maxAttempts: number, now: Date): Promise<IOTP | null> => {
    return OTPModel.findOneAndUpdate(
      {
        _id: otpId,
        isVerified: false,
        expireAt: { $gt: now },
        $or: [{ attempts: { $lt: maxAttempts } }, { attempts: { $exists: false } }],
      },
      { $inc: { attempts: 1 } },
      { new: true }
    ).lean<IOTP>().exec();
  };

  /** O1: removes the destination's older pending codes once a newer one exists. */
  deleteOlderPending = async (
    userId: string,
    target: 'phone' | 'email',
    targetValue: string | undefined,
    newestId: string
  ): Promise<void> => {
    // Strict `_id` order: of two codes created at once exactly one survives, and it is the one findLatestPending picks.
    const query: Record<string, unknown> = { userId, target, isVerified: false, _id: { $lt: new Types.ObjectId(newestId) } };
    if (targetValue) query.targetValue = targetValue;
    await OTPModel.deleteMany(query).exec();
  };

  markAsVerified = async (
    otpId: string,
    data: { userId: string; target: 'phone' | 'email'; targetValue: string },
    observedExpiry: Date,
    consumeCheckpoint: Date
  ): Promise<IOTP | null> => {
    return this.update(
      {
        _id: otpId,
        userId: data.userId,
        target: data.target,
        targetValue: data.targetValue,
        isVerified: false,
        expireAt: { $eq: observedExpiry, $gt: consumeCheckpoint },
      },
      { $set: { isVerified: true } },
      { new: true }
    );
  };

  deleteExpiredOTPs = async (): Promise<void> => {
    await this.deleteMany({ expireAt: { $lt: new Date() } });
  };
}
