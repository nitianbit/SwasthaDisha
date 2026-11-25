import { createHash, createHmac } from 'crypto';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import type { Request } from 'express';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';

/** O1: OTP send/check limits; counters live in `otp_throttles` (see model/throttle). */
export interface Window { seconds: number; max: number }

const keyMaterial = () => createHash('sha256').update(`${CONFIG.JWT_SECRET_KEY}:o1-otp-throttle-v1`).digest();
/** A stable, non-reversible name for an identity (phone/email/user id) or client address. */
export const throttleId = (value: string) => createHmac('sha256', keyMaterial()).update(value).digest('base64url').slice(0, 32);

/**
 * The one counter name of a destination (a phone number or an email address), shared by every account, role and
 * purpose that sends to it or checks a code sent to it (Codex O1 review): no caller gets a budget of its own.
 */
export const destinationId = (target: 'phone' | 'email', value: string) =>
  throttleId(`dest|${target}|${target === 'email' ? value.trim().toLowerCase() : value.trim().replace(/\s+/g, '')}`);

async function bump(id: string, expireAt: Date): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await OtpThrottleModel.findOneAndUpdate(
        { _id: id }, { $inc: { count: 1 }, $setOnInsert: { expireAt } }, { upsert: true, new: true }).lean();
      return row!.count;
    } catch (err) {
      // Two first hits racing on the same new window: one insert wins, the other retries as an increment.
      if ((err as { code?: number }).code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
}

/**
 * Counts one event for `name`, window by window in the given order (shortest first), and refuses (429,
 * `Retry-After`) at the first window over its limit. A refused event is not counted in the later (longer) windows,
 * so tapping "resend" during the 30-second gap does not use up the hourly allowance; within a window every call
 * counts, refused ones included, so hammering a limit does not reopen it.
 */
export async function hit(kind: string, name: string, windows: readonly Window[], now = Date.now()): Promise<void> {
  for (const w of windows) {
    if (!(w.max > 0) || !(w.seconds > 0)) continue;
    const ms = w.seconds * 1000;
    const index = Math.floor(now / ms);
    const end = (index + 1) * ms;
    const count = await bump(`${kind}:${w.seconds}:${index}:${name}`, new Date(end + 60_000));
    if (count > w.max) throw new OtpLimitError(kind, Math.max(1, Math.ceil((end - now) / 1000)));
  }
}

export class OtpLimitError extends AppError {
  retryAfter: number;
  constructor(kind: string, retryAfter: number) {
    const sending = kind.includes('send');
    super({
      status: 429,
      code: sending ? 'OTP_SEND_LIMIT' : 'OTP_VERIFY_LIMIT',
      message: sending
        ? `Too many codes requested. Please try again in ${humanWait(retryAfter)}.`
        : `Too many attempts. Please try again in ${humanWait(retryAfter)}.`,
    });
    this.retryAfter = retryAfter;
  }
}

function humanWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}

/** Limits, from config (see CONFIG.OTP_*). */
export const limits = {
  /** One identity asking for codes: at most 1 per 30 s, 5 per hour, 10 per day. */
  send: (): Window[] => [
    { seconds: 30, max: 1 },
    { seconds: 3600, max: CONFIG.OTP_SEND_PER_HOUR },
    { seconds: 86400, max: CONFIG.OTP_SEND_PER_DAY },
  ],
  /** One signed-in account asking for email-verification codes, whatever the addresses: 10 per hour, 20 per day. */
  sendAccount: (): Window[] => [{ seconds: 3600, max: 10 }, { seconds: 86400, max: 20 }],
  /** Checking codes for one identity, across all its codes: 10 per hour, 20 per day. */
  verify: (): Window[] => [
    { seconds: 3600, max: CONFIG.OTP_VERIFY_PER_HOUR },
    { seconds: 86400, max: CONFIG.OTP_VERIFY_PER_DAY },
  ],
  /** One client address (only when OTP_IP_LIMITS is on; needs TRUST_PROXY behind a proxy). */
  ipSend: (): Window[] => [{ seconds: 3600, max: CONFIG.OTP_IP_SEND_PER_HOUR }],
  ipVerify: (): Window[] => [{ seconds: 3600, max: CONFIG.OTP_IP_VERIFY_PER_HOUR }],
};

/**
 * Per-address limit for public routes. The OTP routes (`ip-send`, `ip-verify`) are a no-op unless OTP_IP_LIMITS=true;
 * r34: another public route passes its own kind and windows and `always` (its limit does not depend on that switch).
 */
export async function hitClient(kind: string, req: Request, windows?: readonly Window[], opts: { always?: boolean } = {}): Promise<void> {
  if (!opts.always && !CONFIG.OTP_IP_LIMITS) return;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  await hit(kind, throttleId(`ip|${ip}`), windows ?? (kind === 'ip-send' ? limits.ipSend() : limits.ipVerify()));
}
