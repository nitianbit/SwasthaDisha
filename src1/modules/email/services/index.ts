import axios from 'axios';
import { Service } from 'typedi';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';

export interface SendEmailPayload {
  to: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  sender?: string;
}

@Service()
export class EmailService {
  private readonly endpoint = 'https://api.smtp2go.com/v3/email/send';

  async sendEmail(payload: SendEmailPayload): Promise<{ success: boolean; data: unknown }> {
    if (!CONFIG.SMTP2GO_API_KEY) {
      throw new AppError({
        status: 500,
        code: 'EMAIL_PROVIDER_NOT_CONFIGURED',
        message: 'SMTP2GO API key is not configured',
      });
    }

    const sender = CONFIG.SMTP2GO_SENDER ;
    if (!sender) {
      throw new AppError({
        status: 500,
        code: 'EMAIL_SENDER_NOT_CONFIGURED',
        message: 'Email sender is not configured',
      });
    }

    try {
      const response = await axios.post(
        this.endpoint,
        {
          sender,
          to: payload.to,
          cc: ['mala@myewacare.com'],
          subject: payload.subject,
          text_body: payload.textBody,
          ...(payload.htmlBody ? { html_body: payload.htmlBody } : {}),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Smtp2go-Api-Key': CONFIG.SMTP2GO_API_KEY,
            accept: 'application/json',
          },
        }
      );

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      throw new AppError({
        status: 502,
        code: 'EMAIL_SEND_FAILED',
        message:
          error?.response?.data?.data?.error ||
          error?.response?.data?.error ||
          error?.message ||
          'Failed to send email',
      });
    }
  }
}
