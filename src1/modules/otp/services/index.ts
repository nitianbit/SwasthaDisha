import { Service } from 'typedi';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { OTPRepository } from '@/modules/otp/repository';
import { IOTP, CreateOTPRequest, VerifyOTPRequest } from '@/modules/otp/types';
import { AppError } from '@/modules/common/types';
import { CONFIG } from '@/config/config';
import { hit, limits, throttleId } from '@/modules/otp/throttle';

const hashKey = () => createHash('sha256').update(`${CONFIG.JWT_SECRET_KEY}:o1-otp-hash-v1`).digest();
/** The stored proof of a code: bound to its user and destination, so a row can never verify another identity. */
const otpHash = (userId: string, target: string, targetValue: string | undefined, otp: string) =>
  createHmac('sha256', hashKey()).update(`${userId}|${target}|${targetValue ?? ''}|${otp}`).digest('base64url');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const unavailable = () => new AppError({
  status: 400,
  code: 'OTP_UNAVAILABLE',
  message: 'OTP is no longer available; request a new OTP',
});
const expired = () => new AppError({ status: 400, code: 'OTP_EXPIRED', message: 'OTP has expired' });
const burnt = () => new AppError({
  status: 429,
  code: 'OTP_ATTEMPTS_EXCEEDED',
  message: 'Too many incorrect codes. Please request a new code.',
});

const isLive = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

@Service()
export class OTPService {
  constructor(private otpRepository: OTPRepository) {}

  /**
   * Stores a new code for one destination (only its HMAC). The destination's older pending codes stop working:
   * only the newest pending code is ever checked, and the older ones are deleted.
   */
  async createOTP(data: CreateOTPRequest): Promise<IOTP> {
    const expireAt = data.expireAt || new Date(Date.now() + CONFIG.OTP_EXPIRY_MINUTES * 60 * 1000);

    const otp = await this.otpRepository.save({
      userId: data.userId,
      otpHash: otpHash(String(data.userId), data.target, data.targetValue, data.otp),
      attempts: 0,
      target: data.target,
      targetValue: data.targetValue,
      expireAt,
      isVerified: false,
    });

    await this.otpRepository.deleteOlderPending(String(data.userId), data.target, data.targetValue, String(otp._id));

    return otp;
  }

  /**
   * O1: checks a code against the destination's newest pending code. Every check spends one of the code's
   * OTP_MAX_ATTEMPTS (atomically, before comparing), and counts toward the destination's hourly/daily check limit, so a
   * 6-digit code cannot be guessed by parallel or repeated requests. A burnt code answers 429; request a new one.
   */
  async verifyOTP(data: VerifyOTPRequest): Promise<IOTP> {
    const userId = String(data.userId);
    await hit('verify', throttleId(`verify|${userId}|${data.target}|${data.targetValue ?? ''}`), limits.verify());

    const pending = await this.otpRepository.findLatestPending(userId, data.target, data.targetValue);
    if (!pending) {
      throw new AppError({ status: 404, code: 'OTP_NOT_FOUND', message: 'OTP not found' });
    }
    if (!isLive(pending.expireAt) || pending.expireAt <= new Date()) throw expired();
    if (typeof pending.targetValue !== 'string' || pending.targetValue.trim() === ''
      || (data.targetValue !== undefined && data.targetValue !== pending.targetValue)) {
      throw unavailable();
    }

    const max = CONFIG.OTP_MAX_ATTEMPTS > 0 ? CONFIG.OTP_MAX_ATTEMPTS : 5;
    const claimed = await this.otpRepository.claimAttempt(String(pending._id), max, new Date());
    if (!claimed) {
      if ((pending.attempts ?? 0) >= max) throw burnt();
      // Consumed, replaced or expired between the read and the claim.
      const again = await this.otpRepository.findLatestPending(userId, data.target, data.targetValue);
      if (again && String(again._id) === String(pending._id) && (again.attempts ?? 0) >= max) throw burnt();
      throw unavailable();
    }

    const candidate = typeof data.otp === 'string' ? data.otp : '';
    const matches = claimed.otpHash
      ? sameSecret(claimed.otpHash, otpHash(userId, claimed.target, claimed.targetValue, candidate))
      : typeof claimed.otp === 'string' && sameSecret(claimed.otp, candidate); // legacy row (pre-O1)
    if (!matches) {
      const left = max - (claimed.attempts ?? max);
      if (left <= 0) throw burnt();
      throw new AppError({
        status: 404,
        code: 'OTP_NOT_FOUND',
        message: `Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
      });
    }

    const observedExpiry = new Date(claimed.expireAt.getTime());
    const verifiedOTP = await this.otpRepository.markAsVerified(
      String(claimed._id),
      { userId, target: claimed.target, targetValue: claimed.targetValue! },
      observedExpiry,
      new Date()
    );
    if (!verifiedOTP) throw unavailable();
    if (!isLive(verifiedOTP.expireAt) || verifiedOTP.expireAt <= new Date()) throw expired();
    return verifiedOTP;
  }

  async getLatestOTP(
    userId: string,
    target: 'phone' | 'email'
  ): Promise<IOTP | null> {
    return this.otpRepository.findLatestPending(userId, target);
  }
}
