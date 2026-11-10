import { Service } from 'typedi';
import { Model } from 'mongoose';
import FcmTokenModel from '@/modules/fcm/model';
import { IFcmToken } from '@/modules/fcm/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class FcmRepository extends BaseRepository<IFcmToken> {
  constructor() {
    super(FcmTokenModel as Model<IFcmToken>);
  }

  async saveOrUpdate(data: {
    userId: string;
    userType: string;
    token: string;
    platform?: string;
    deviceId?: string;
  }): Promise<IFcmToken> {
    const tokenRecord = await FcmTokenModel.findOneAndUpdate(
      { token: data.token },
      {
        $set: {
          userId: data.userId,
          userType: data.userType,
          token: data.token,
          platform: data.platform,
          deviceId: data.deviceId,
          isActive: true,
          lastUsedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return tokenRecord as IFcmToken;
  }

  async findActiveTokensByUserId(
    userId: string,
    userType?: string
  ): Promise<IFcmToken[]> {
    return this.findAll(
      userType ? { userId, userType } : { userId },
      { sort: { lastUsedAt: -1 } }
    );
  }

  async findActiveTokensByUserIds(
    userIds: string[],
    userType?: string
  ): Promise<IFcmToken[]> {
    if (userIds.length === 0) return [];
    return this.findAll(
      userType ? { userId: { $in: userIds }, userType } : { userId: { $in: userIds } },
      { sort: { lastUsedAt: -1 } }
    );
  }
}
