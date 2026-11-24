import { randomBytes } from 'crypto';
import { Router, type Response } from 'express';
import Joi from 'joi';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, type AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { hit, OtpLimitError, throttleId } from '@/modules/otp/throttle';
import { finishedFields, SmsNoticeModel } from '@/modules/smsNotices/model';
import { smsFlags } from '@/modules/smsNotices/flags';
import { sendBounded, smsProvider } from '@/modules/smsNotices/provider';
import { textFor } from '@/modules/smsNotices/outbox';
import { dltText, FIRST_WAVE, sendable, SMS_MESSAGES, type SmsMessage } from '@/modules/smsNotices/templates';

/**
 * Phase 5a admin routes (ASSISTED_BOOKING_DESIGN.md §27.5.7), `/api/v1/admin/sms-notices`, admins only:
 * - `GET /summary`: the switches, which message × language pairs are sendable, the text to register on DLT, and the
 *   last 24 hours by state. Booleans and counts only, never a secret or a phone number.
 * - `POST /test { message, lang, phone }`: one text with sample values, now, even while that pair's switch is off (to
 *   check a registered template before turning it on). Recorded as an `admin_test` row (no phone); 20 an hour per admin.
 */
const SAMPLE: Record<string, string> = { name: 'Rina', service: 'video consultation', date: '01-12-2026', time: '10:30', place: 'Jansetu Pharmacy',
  ref: 'ABCD2345', token: 'ABCD2345-ABCDEFGHIJKLMNOPQRST', what: 'cancelled', code: '123456' };
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const send = (res: Response, data: unknown) => { res.setHeader('Cache-Control', 'private, no-store'); res.json({ success: true, data }); };

async function summary() {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const counts = await SmsNoticeModel.aggregate([{ $match: { createdAt: { $gte: since }, bookingKind: { $ne: 'admin_test' } } },
    { $group: { _id: { state: '$state', reason: '$reason' }, n: { $sum: 1 } } }]);
  const last24h: Record<string, number | Record<string, number>> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: {} };
  for (const c of counts) {
    if (c._id.state === 'skipped') (last24h.skipped as Record<string, number>)[c._id.reason ?? 'unknown'] = c.n;
    else last24h[c._id.state] = Number(last24h[c._id.state] ?? 0) + c.n;
  }
  return {
    enabled: smsFlags.enabled(),
    provider: { configured: smsProvider().configured(), unicode: !!smsFlags.unicodeParam(), noticesHeader: !!smsFlags.noticesFrom(),
      joinBase: !!smsFlags.joinBase() },
    pairs: SMS_MESSAGES.flatMap((message) => FIRST_WAVE.map((lang) => {
      const p = smsFlags.pair(message, lang);
      return { message, lang, enabled: p.enabled, templateSet: !!p.templateId, dltText: dltText(message, lang) };
    })),
    last24h,
  };
}

async function testSend(adminId: string, input: { message: SmsMessage; lang: string; phone: string }) {
  if (!smsFlags.enabled()) throw err(503, 'SMS_NOTICES_DISABLED', 'SMS notices are not switched on');
  const to = canonicalMobile(input.phone);
  if (!to) throw err(400, 'VALIDATION_ERROR', 'phone must be a 10-digit mobile number');
  const provider = smsProvider();
  if (!provider.configured()) throw err(503, 'SMS_PROVIDER_NOT_CONFIGURED', 'The SMS gateway is not configured');
  // The pair's own switch is not required (a template is checked before it goes live); everything else is as sent.
  const template = sendable(input.message, input.lang, true);
  const prepared = template ? textFor(to, template, SAMPLE) : { skip: 'no_template' };
  if ('skip' in prepared) throw err(409, 'SMS_TEMPLATE_NOT_SET', `This template cannot be sent: ${prepared.skip}`);
  try {
    await hit('sms-test', throttleId(`admin|${adminId}`), [{ seconds: 3600, max: 20 }]);
  } catch (e) {
    if (e instanceof OtpLimitError) throw err(429, 'SMS_TEST_LIMIT', 'At most 20 test messages an hour');
    throw e;
  }
  const p = prepared;
  const r = await sendBounded({ to: p.to, text: p.text, templateId: p.template.templateId, unicode: p.unicode });
  const at = new Date();
  await SmsNoticeModel.create({ bookingKind: 'admin_test', bookingId: String(adminId).toLowerCase(), event: 'test',
    version: `${at.getTime()}:${randomBytes(4).toString('hex')}`, state: r.ok ? 'sent' : 'failed', dueAt: at, attempts: 1,
    message: input.message, lang: input.lang, ...(r.ok ? { sentAt: at } : { reason: r.code }), ...(r.status ? { providerStatus: r.status } : {}),
    ...finishedFields(at) });
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

const testSchema = Joi.object({
  message: Joi.string().valid(...SMS_MESSAGES).required(),
  lang: Joi.string().trim().lowercase().pattern(/^[a-z]{2,3}$/).required(),
  phone: Joi.string().trim().max(20).required(),
});

export const smsAdminRouter = Router();
smsAdminRouter.use(requireAdmin);
smsAdminRouter.get('/summary', catchAsync(async (_req: AuthRequest, res: Response) => send(res, await summary())));
smsAdminRouter.post('/test', validate(testSchema), catchAsync(async (req: AuthRequest, res: Response) =>
  send(res, await testSend(String(req.user?._id), req.body))));
