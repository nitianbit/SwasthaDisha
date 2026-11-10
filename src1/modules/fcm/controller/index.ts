import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { FcmService } from '@/modules/fcm/services';
import { AuthRequest } from '@/modules/middleware/auth';
import { SaveFcmTokenRequest } from '@/modules/fcm/types';

export class FcmController {
  private fcmService: FcmService;

  constructor() {
    this.fcmService = Container.get(FcmService);
  }

  saveToken = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: SaveFcmTokenRequest = req.body;
    const tokenRecord = await this.fcmService.saveToken(req.user, data);

    res.status(201).json({
      success: true,
      message: 'FCM token saved successfully',
      data: { token: tokenRecord },
    });
  };

  sendTestNotification = async (req: Request, res: Response, _next: NextFunction) => {
    const { userId } = req.body as { userId: string };

    await this.fcmService.sendNotificationToUser(userId, {
      title: 'Booking Successful',
      body: 'Your booking has been confirmed successfully. We will confirm it shortly.',
      data: {
        type: 'test',
      },
    });

    res.status(200).json({
      success: true,
      message: 'Test notification sent (if user has active FCM tokens)',
    });
  };
}
