import { Service } from 'typedi';
import { FcmRepository } from '@/modules/fcm/repository';
import { IFcmToken, SaveFcmTokenRequest } from '@/modules/fcm/types';
import { AppError } from '@/modules/common/types';
import { getFirebaseMessaging } from '@/services/firebase';
import logger from '@/services/logger';

@Service()
export class FcmService {
  constructor(private fcmRepository: FcmRepository) {}

  async saveToken(
    user: { _id: string; userType: string } | undefined,
    data: SaveFcmTokenRequest
  ): Promise<IFcmToken> {
    if (!user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    return this.fcmRepository.saveOrUpdate({
      userId: user._id,
      userType: user.userType,
      token: data.token.trim(),
      platform: data.platform,
      deviceId: data.deviceId?.trim(),
    });
  }

  async sendNotificationToUser(
    userId: string,
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
    },
    userType?: string
  ): Promise<void> {
    const tokens = await this.fcmRepository.findActiveTokensByUserId(
      userId,
      userType
    );
    if (tokens.length === 0) {
      return;
    }

    const messaging = getFirebaseMessaging();
    if (!messaging) {
      return;
    }

    const tokenValues = tokens.map((t) => t.token).filter(Boolean);
    if (tokenValues.length === 0) {
      return;
    }

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: tokenValues,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
      });
      logger.info('FCM notification sent successfully', {
        response,
      });
    } catch (error) {
      logger.error('Failed to send FCM notification', {
        userId,
        error,
      });
    }
  }

  /** Send the same notification to multiple users in batches (FCM limit 500 tokens per request). */
  async sendNotificationToUsers(
    userIds: string[],
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
    },
    userType?: string
  ): Promise<void> {
    if (userIds.length === 0) return;

    const tokens = await this.fcmRepository.findActiveTokensByUserIds(
      userIds,
      userType
    );
    const tokenValues = tokens.map((t) => t.token).filter(Boolean);
    if (tokenValues.length === 0) return;

    const messaging = getFirebaseMessaging();
    if (!messaging) return;

    const FCM_BATCH_SIZE = 500;
    for (let i = 0; i < tokenValues.length; i += FCM_BATCH_SIZE) {
      const batch = tokenValues.slice(i, i + FCM_BATCH_SIZE);
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title: payload.title, body: payload.body },
          data: payload.data,
        });
        logger.info('FCM notification sent successfully', {
          response,
        });
      } catch (error) {
        logger.error('Failed to send FCM batch', { batchIndex: i / FCM_BATCH_SIZE, error });
      }
    }
  }
}
