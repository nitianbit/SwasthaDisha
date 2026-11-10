import 'reflect-metadata';
import { NextFunction, Request, Response } from 'express';
import { Container } from 'typedi';
import { WebhookService } from '@/modules/webhooks/services';

export class WebhookController {
  private webhookService: WebhookService;

  constructor() {
    this.webhookService = Container.get(WebhookService);
  }

  processBookingStatusWebhook = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const result = await this.webhookService.processBookingStatusWebhook({
      payload: req.body || {},
      headers: req.headers as Record<string, any>,
      queryParams: req.query as Record<string, any>,
      method: req.method,
      path: req.originalUrl,
      sourceIp: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(200).json({
      success: true,
      message: 'Booking status webhook processed successfully',
      data: result,
    });
  };
}
