import { Service } from 'typedi';
import { Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import { IWebhook } from '@/modules/webhooks/types';
import { WebhookModel } from '@/modules/webhooks/model';

@Service()
export class WebhookRepository extends BaseRepository<IWebhook> {
  constructor() {
    super(WebhookModel as Model<IWebhook>);
  }
}
