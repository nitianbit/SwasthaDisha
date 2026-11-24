import axios from 'axios';
import { CONFIG } from '@/config/config';
import { gatewayConfigured, gatewayRequest } from '@/modules/sms/services';
import { withDeadline } from '@/modules/common/utils/lease';
import { smsFlags } from '@/modules/smsNotices/flags';

/**
 * Phase 5 (ASSISTED_BOOKING_DESIGN.md §27.5.4): the provider-neutral sender of booking notices. It never throws and
 * answers codes only; the caller bounds the call (`signal`). The gateway's answer is read for its status only and is
 * never logged or stored.
 */
export type SmsSendCode = 'timeout' | 'network' | 'http_5xx' | 'http_429' | 'http_4xx';
export type SmsSendResult = { ok: true; status?: number } | { ok: false; retryable: boolean; code: SmsSendCode; status?: number };

export interface SmsProvider {
  configured(): boolean;
  send(m: { to: string; text: string; templateId: string; unicode: boolean }, signal: AbortSignal): Promise<SmsSendResult>;
}

/**
 * The one implementation: the gateway that already sends sign-in codes (`gatewayRequest`), with the notices header,
 * the Unicode flag for non-Latin text, a timeout, and no template fallback (the caller always gives the DLT id).
 */
export const gatewayProvider: SmsProvider = {
  configured: () => gatewayConfigured() && !!CONFIG.SMS_PE_ID,
  async send(m, signal) {
    const unicode = m.unicode ? smsFlags.unicodeParam() : null;
    const r = gatewayRequest({ to: m.to, text: m.text, templateId: m.templateId, peId: CONFIG.SMS_PE_ID,
      from: smsFlags.noticesFrom() || undefined, ...(unicode ? { extra: unicode } : {}) });
    try {
      const res = await axios.get(r.url, { params: r.params, headers: r.headers, signal, timeout: smsFlags.timeoutMs(),
        validateStatus: () => true, responseType: 'text' });
      const status = res.status;
      if (status >= 200 && status < 300) return { ok: true, status };
      if (status === 429) return { ok: false, retryable: true, code: 'http_429', status };
      if (status >= 500) return { ok: false, retryable: true, code: 'http_5xx', status };
      return { ok: false, retryable: false, code: 'http_4xx', status };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const timedOut = signal.aborted || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED';
      return { ok: false, retryable: true, code: timedOut ? 'timeout' : 'network' };
    }
  },
};

let provider: SmsProvider = gatewayProvider;
export const smsProvider = (): SmsProvider => provider;
/** Tests replace the sender; no argument restores the gateway. Returns the previous one. */
export function setSmsProvider(p?: SmsProvider): SmsProvider {
  const prev = provider;
  provider = p ?? gatewayProvider;
  return prev;
}

/** One call through the current sender, cut at SMS_SEND_TIMEOUT_MS even if the sender ignores its signal. */
export function sendBounded(m: { to: string; text: string; templateId: string; unicode: boolean }): Promise<SmsSendResult> {
  const p = smsProvider();
  return withDeadline(smsFlags.timeoutMs(), (signal) => p.send(m, signal), () => new Error('timeout'))
    .catch((): SmsSendResult => ({ ok: false, retryable: true, code: 'timeout' }));
}
