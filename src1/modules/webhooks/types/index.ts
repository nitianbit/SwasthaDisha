export type WebhookType = 'booking';

export interface IWebhook {
  _id?: string;
  webhookType: WebhookType;
  payload: Record<string, any>;
  headers?: Record<string, any>;
  queryParams?: Record<string, any>;
  method?: string;
  path?: string;
  sourceIp?: string;
  userAgent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateWebhookRequest {
  webhookType: WebhookType;
  payload: Record<string, any>;
  headers?: Record<string, any>;
  queryParams?: Record<string, any>;
  method?: string;
  path?: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface WebhookProcessResult {
  matched: boolean;
  action: 'ignored' | 'updated' | 'cancelled' | 'completed' | 'rescheduled';
  reason?: string;
  externalBookingId?: string;
  normalizedStatus?: string;
  bookingId?: string;
}
