import axios from 'axios';
import { Service } from 'typedi';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';

export interface SendSMSPayload {
  to: string;
  text: string;
  templateId?: string;
  peId?: string;
}

export type SMSType = 'otp';

export interface BuildSMSContentPayload {
  otp?: string;
  expiryMinutes?: number;
}

@Service()
export class SMSService {
  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');

    if (digits.length === 10) {
      return `91${digits}`;
    }

    if (digits.length === 12 && digits.startsWith('91')) {
      return digits;
    }

    return digits;
  }

  buildSMSContent(
    type: SMSType,
    payload: BuildSMSContentPayload = {}
  ): { text: string; templateId?: string } {
    switch (type) {
      case 'otp':
        return {
          text: `Your OTP for verification on MyEwaCare, a service of EWA Healthcare Solutions, is ${payload.otp}. This OTP is valid for ${payload.expiryMinutes} minutes. Do not share this OTP with anyone.`,
          templateId: CONFIG.SMS_TEMPLATE_ID,
        };
      default:
        throw new AppError({
          status: 400,
          code: 'INVALID_SMS_TYPE',
          message: 'Unsupported SMS type',
        });
    }
  }

  async sendSMS(payload: SendSMSPayload): Promise<{ success: boolean; data: unknown }> {
    if (
      !CONFIG.SMS_API_BASE_URL ||
      !CONFIG.SMS_USERNAME ||
      !CONFIG.SMS_PASSWORD ||
      !CONFIG.SMS_FROM
    ) {
      throw new AppError({
        status: 500,
        code: 'SMS_PROVIDER_NOT_CONFIGURED',
        message: 'SMS provider is not configured',
      });
    }

    try {
      const response = await axios.get(
        CONFIG.SMS_API_BASE_URL,
        {
          params: {
            username: CONFIG.SMS_USERNAME,
            password: CONFIG.SMS_PASSWORD,
            from: CONFIG.SMS_FROM,
            to: this.normalizePhone(payload.to),
            text: payload.text,
            tmplId: payload.templateId || CONFIG.SMS_TEMPLATE_ID,
            peId: payload.peId || CONFIG.SMS_PE_ID,
          },
          headers: {
            ...(CONFIG.SMS_COOKIE ? { Cookie: CONFIG.SMS_COOKIE } : {}),
          },
        }
      );

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      throw new AppError({
        status: 400,
        code: 'SMS_SEND_FAILED',
        message:
          error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          'Failed to send SMS',
      });
    }
  }
}
