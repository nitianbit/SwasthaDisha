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

export type SMSType = 'otp' | 'partner_bill' | 'member_email';

export interface BuildSMSContentPayload {
  otp?: string;
  expiryMinutes?: number;
  supplierName?: string;
  serial?: string;
  /** Q16b member_email: what happened to the sign-in email. */
  change?: 'set' | 'changed' | 'removed';
}

function gatewayPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  }

  return digits;
}

/** The gateway account is set (sign-in codes, bills, member e-mail notices and phase 5 booking notices share it). */
export const gatewayConfigured = (): boolean =>
  !!(CONFIG.SMS_API_BASE_URL && CONFIG.SMS_USERNAME && CONFIG.SMS_PASSWORD && CONFIG.SMS_FROM);

/**
 * The gateway's one request shape (HTTP GET). Callers choose the template and PE id; `from` defaults to SMS_FROM and
 * `extra` adds gateway parameters (phase 5: the Unicode flag).
 */
export function gatewayRequest(p: { to: string; text: string; templateId?: string; peId?: string; from?: string; extra?: Record<string, string> }) {
  return {
    url: CONFIG.SMS_API_BASE_URL as string,
    params: {
      username: CONFIG.SMS_USERNAME,
      password: CONFIG.SMS_PASSWORD,
      from: p.from || CONFIG.SMS_FROM,
      to: gatewayPhone(p.to),
      text: p.text,
      tmplId: p.templateId,
      peId: p.peId,
      ...p.extra,
    },
    headers: {
      ...(CONFIG.SMS_COOKIE ? { Cookie: CONFIG.SMS_COOKIE } : {}),
    },
  };
}

@Service()
export class SMSService {

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
      case 'partner_bill':
        // No health details and no document link: the bill is reached by signing in to the app with this number.
        return {
          text: `Your bill ${payload.serial} from ${payload.supplierName} is in the SwasthaDisha app. Sign in with this mobile number to view it.`,
          templateId: CONFIG.SMS_TEMPLATE_ID_PARTNER_BILL,
        };
      case 'member_email':
        // Q16b: no address and no link; the member checks in the workspace or asks their owner.
        return {
          text: `Your sign-in email for ${payload.supplierName} on Jansetu was ${payload.change === 'removed' ? 'removed' : payload.change === 'set' ? 'added' : 'changed'}. If this was not expected, contact your workspace owner or Jansetu support.`,
          templateId: CONFIG.SMS_TEMPLATE_ID_MEMBER_EMAIL,
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
    if (!gatewayConfigured()) {
      throw new AppError({
        status: 500,
        code: 'SMS_PROVIDER_NOT_CONFIGURED',
        message: 'SMS provider is not configured',
      });
    }

    try {
      // Sign-in codes and the other callers keep the sign-in template and PE id as their fallbacks.
      const request = gatewayRequest({
        to: payload.to,
        text: payload.text,
        templateId: payload.templateId || CONFIG.SMS_TEMPLATE_ID,
        peId: payload.peId || CONFIG.SMS_PE_ID,
      });
      const response = await axios.get(request.url, { params: request.params, headers: request.headers });

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
