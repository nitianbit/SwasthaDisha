import { Service } from 'typedi';
import { WebhookRepository } from '@/modules/webhooks/repository';
import { ExternalBookingService } from '@/modules/externalBookings/services';
import {
  CreateWebhookRequest,
  IWebhook,
  WebhookProcessResult,
} from '@/modules/webhooks/types';

@Service()
export class WebhookService {
  constructor(
    private webhookRepository: WebhookRepository,
    private externalBookingService: ExternalBookingService
  ) {}

  async processBookingStatusWebhook(
    data: Omit<CreateWebhookRequest, 'webhookType'>
  ): Promise<{
    webhook: IWebhook;
    processing: WebhookProcessResult;
  }> {
    const webhook = await this.webhookRepository.save({
      webhookType: 'booking',
      ...data,
    });

    const syncResult = await this.externalBookingService.syncBookingFromWebhook(
      data.payload || {}
    );

    return {
      webhook,
      processing: {
        matched: syncResult.matched,
        action: syncResult.action,
        reason: syncResult.reason,
        externalBookingId: syncResult.externalBookingId,
        normalizedStatus: syncResult.normalizedStatus,
        bookingId: syncResult.booking?._id
          ? String(syncResult.booking._id)
          : undefined,
      },
    };
  }
}
