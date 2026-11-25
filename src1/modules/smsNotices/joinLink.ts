import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import logger from '@/services/logger';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import BookingModel from '@/modules/bookings/model';
import { appointmentIntervalOf, slotsOf } from '@/modules/assisted/rxAccess';
import { doctorExistsIneligible } from '@/modules/specialists/eligibility';
import { hit, OtpLimitError, throttleId } from '@/modules/otp/throttle';
import { smsFlags } from '@/modules/smsNotices/flags';

/**
 * Phase 5d (ASSISTED_BOOKING_DESIGN.md §27.8): the video link a patient taps in an SMS, `<SMS_JOIN_LINK_BASE_URL>/<token>`.
 * - **Token** (29 characters, nothing stored): `<shortRef>-<mac>`; `mac` = the first 100 bits of
 *   HMAC-SHA256(JOIN_LINK_SECRET, `<bookingId>:<join.linkVersion>`) in RFC 4648 base32. The admin account move bumps
 *   `linkVersion`, so links sent to the old number die; a booker move keeps it and the window follows the new slot.
 * - **`GET /j/:token`** (no sign-in): 30 requests a minute per IP (the OTP counter store); a 302 to the Meet link only
 *   inside the visit window of a paid, confirmed video consultation joined on the patient's phone with an eligible
 *   doctor. Every other answer is one neutral page (status 200, English and Hindi); 429 over the limit, 503 when the
 *   counter store fails. Logs carry the outcome only; the request logger prints `/j/:token` (never the token).
 */
type Row = Record<string, any>;
const MIN_MS = 60_000;
const TOKEN = /^([A-Z2-7]{8})-([A-Z2-7]{20})$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The first 100 bits of the MAC, RFC 4648 base32 (20 characters, upper case, no padding). */
function macOf(bookingId: string, linkVersion: unknown, secret: string): string {
  const d = createHmac('sha256', secret).update(`${String(bookingId).toLowerCase()}:${Number(linkVersion)}`).digest();
  let out = '';
  for (let i = 0; i < 20; i++) {
    const bit = i * 5;
    const two = (d[bit >> 3]! << 8) | d[(bit >> 3) + 1]!;
    out += ALPHABET[(two >> (11 - (bit & 7))) & 31];
  }
  return out;
}

/** The token of a partner-made consultation; null without the secret, a Ref or a link version. */
export function joinTokenOf(b: Row | null | undefined): string | null {
  const secret = smsFlags.joinSecret();
  const ref = b?.assisted?.shortRef;
  const version = b?.assisted?.join?.linkVersion;
  if (!secret || typeof ref !== 'string' || !/^[A-Z2-7]{8}$/.test(ref) || !Number.isInteger(version)) return null;
  return `${ref}-${macOf(String(b!._id), version, secret)}`;
}

/**
 * §27.8.2: the `_LINK` texts are candidates only for a video consultation joined on the patient's own phone, while the
 * secret and the link address are set. The link goes to the account phone like every notice, never to `join.phone` (SM15).
 */
export const linkTokenFor = (kind: 'booking' | 'lab_booking', b: Row): string | null =>
  kind === 'booking' && b.consultationMode === 'video' && b.assisted?.join?.on === 'patient_phone' && !!smsFlags.joinBase() ? joinTokenOf(b) : null;

/** The visit window: a scheduled visit from its start − 10 min to its end; an instant one from acceptance to the later of +60 min and its last extension. */
async function windowOf(b: Row): Promise<{ from: number; to: number } | null> {
  if (b.bookingKind === 'instant') {
    const accepted = new Date(b.createdAt ?? NaN).getTime();
    if (!Number.isFinite(accepted)) return null;
    const ends = (Array.isArray(b.instantExtensions) ? b.instantExtensions : []).map((x: Row) => new Date(x?.endTime).getTime()).filter(Number.isFinite);
    return { from: accepted, to: Math.max(accepted + 60 * MIN_MS, ...ends) };
  }
  const interval = appointmentIntervalOf(b, (await slotsOf([b])).get(String(b.slotId ?? '')));
  return interval ? { from: interval.start.getTime() - 10 * MIN_MS, to: interval.end.getTime() } : null;
}

/** The Meet address the token opens now, or null (every closed case alike). */
export async function joinUrlFor(token: unknown, now: Date = new Date()): Promise<string | null> {
  const m = TOKEN.exec(String(token ?? ''));
  const secret = smsFlags.joinSecret();
  if (!m || !secret) return null;
  const b = await BookingModel.findOne({ 'assisted.shortRef': m[1] }).select({ specialistId: 1, status: 1, paymentStatus: 1, consultationMode: 1,
    bookingKind: 1, bookingDate: 1, bookingTime: 1, slotId: 1, createdAt: 1, instantExtensions: 1, virtualMeeting: 1, 'assisted.join': 1,
    'assisted.identity': 1 }).lean() as Row | null;
  if (!b || !timingSafeEqual(Buffer.from(macOf(String(b._id), b.assisted?.join?.linkVersion, secret)), Buffer.from(m[2]!))) return null;
  const meet = b.virtualMeeting;
  if (b.status !== 'confirmed' || b.paymentStatus !== 'paid' || b.consultationMode !== 'video' || b.assisted?.join?.on !== 'patient_phone'
    || b.assisted?.identity?.disputed?.state === 'open' || meet?.status !== 'active' || !/^https:\/\/meet\.google\.com\//.test(String(meet?.joinUrl ?? ''))) return null;
  const w = await windowOf(b);
  if (!w || now.getTime() < w.from || now.getTime() >= w.to || await doctorExistsIneligible(b.specialistId)) return null;
  return String(meet.joinUrl);
}

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<meta name="robots" content="noindex"><title>Jansetu</title></head><body><main>'
  + '<p>This Jansetu link is not open now. It opens 10 minutes before the booked time. You can also sign in to the Jansetu app with this mobile number and tap Join.</p>'
  + '<p lang="hi">यह जनसेतु लिंक अभी खुला नहीं है। यह बुक किए गए समय से 10 मिनट पहले खुलता है। आप इसी मोबाइल नंबर से जनसेतु ऐप में साइन इन करके Join दबा सकते हैं।</p>'
  + '</main></body></html>';

async function join(req: Request, res: Response): Promise<void> {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  const page = (status: number, outcome: string) => {
    logger.info('join link', { outcome });
    res.status(status).type('html').send(PAGE);
  };
  try {
    await hit('join-ip', throttleId(`ip|${req.ip}`), [{ seconds: 60, max: smsFlags.joinRatePerMinute() }]);
  } catch (e) {
    if (e instanceof OtpLimitError) { res.set('Retry-After', String(e.retryAfter)); return page(429, 'limited'); }
    return page(503, 'unavailable');
  }
  const url = await joinUrlFor(req.params.token).catch(() => null);
  if (!url) return page(200, 'closed');
  logger.info('join link', { outcome: 'redirect' });
  res.redirect(302, url);
}

/** Mounted at `/j` (configureRoutes), without sign-in. HEAD answers as GET, without a body (Express). */
export const joinRouter = Router();
joinRouter.get('/:token', catchAsync(join));
