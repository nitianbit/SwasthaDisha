/**
 * O1: OTP attempt and send limits, against a real MongoDB replica set and the real auth routes over HTTP.
 * Real AuthService, OTPService and models; only SMS/email/wallet providers are stubbed.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/o1_otp_limits_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/otp-limits/o1-otp-limits.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import OTPModel from '@/modules/otp/model';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import { UserRepository } from '@/modules/user/repository';
import UserModel from '@/modules/user/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/o1_otp_limits_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const sms: { to: string; text: string }[] = [];
const mails: { to: string[]; textBody: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const emailService = { sendEmail: async (m: { to: string[]; textBody: string }) => { mails.push(m); return { success: true, data: null }; } };
const userRepository = new UserRepository();
const otpService = new OTPService(new OTPRepository());
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, new PharmacyRepository(), {},
  otpService, { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), userRepository, {} as never), emailService, smsService);

let base = '';
type Res = { status: number; body: { data?: Record<string, unknown>; code?: string; message?: string; retryAfter?: number }; headers: Headers };
async function post(path: string, body: unknown, ip?: string): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip) headers['x-forwarded-for'] = ip;
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as Res['body'], headers: r.headers };
}
let phoneSeq = 0;
const nextPhone = () => '95' + String(10_000_000 + ++phoneSeq).padStart(8, '0');
const lastOtp = () => /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
const wrong = (code: string) => String((Number(code) - 100000 + 1) % 900000 + 100000);
/** Lets the next send through the 30-second gap (the hourly/daily counters stay). */
const skipGap = () => OtpThrottleModel.deleteMany({ _id: /^send:30:/ });
const send = (phone: string, userType = 'user', ip?: string) => post(`/api/v1/auth/${userType}/send`, { phone }, ip);
const verify = (phone: string, otp: string, userType = 'user', ip?: string) => post(`/api/v1/auth/${userType}/verify`, { phone, otp }, ip);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await OtpThrottleModel.deleteMany({});
  await fn(); passed++; console.log('ok -', name);
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await OTPModel.createCollection(); await OTPModel.syncIndexes();
  await OtpThrottleModel.createCollection(); await OtpThrottleModel.syncIndexes();
  Container.set(AuthService, auth);
  const { default: router } = await import('@/modules/auth/routes');
  const app = express();
  app.set('trust proxy', true); // the test sets X-Forwarded-For to play different client addresses
  app.use(express.json());
  app.use('/api/v1/auth', router);
  app.use(errorHandler);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    await check('a code is stored only as an HMAC bound to its destination, and the right code signs in once', async () => {
      const phone = nextPhone();
      assert.equal((await send(phone)).status, 200);
      const code = lastOtp();
      const row = await OTPModel.findOne({ targetValue: phone }).lean();
      assert.ok(row && !('otp' in row) && typeof row.otpHash === 'string' && row.attempts === 0);
      assert.ok(!JSON.stringify(row).includes(code));
      const ok = await verify(phone, code);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const again = await verify(phone, code);
      assert.equal(again.status, 404); // consumed: nothing pending any more
    });

    await check('five wrong codes burn the code: the right code is then refused (429) until a new one is sent', async () => {
      const phone = nextPhone();
      await send(phone);
      const code = lastOtp();
      for (let i = 1; i <= 4; i++) {
        const r = await verify(phone, wrong(code));
        assert.equal(r.status, 404); assert.equal(r.body.code, 'OTP_NOT_FOUND');
        assert.match(String(r.body.message), new RegExp(`${5 - i} attempts? left`));
      }
      const fifth = await verify(phone, wrong(code));
      assert.equal(fifth.status, 429); assert.equal(fifth.body.code, 'OTP_ATTEMPTS_EXCEEDED');
      const right = await verify(phone, code);
      assert.equal(right.status, 429); assert.equal(right.body.code, 'OTP_ATTEMPTS_EXCEEDED');
      assert.equal((await OTPModel.findOne({ targetValue: phone }).lean())!.attempts, 5);
      await skipGap();
      await send(phone);
      assert.equal((await verify(phone, lastOtp())).status, 200);
    });

    await check('parallel guessing: 40 requests at once spend at most 5 attempts and none signs in', async () => {
      const phone = nextPhone();
      await send(phone);
      const code = lastOtp();
      const guesses = Array.from({ length: 40 }, (_, i) => String(100000 + ((Number(code) - 100000 + 1 + i) % 900000)));
      const results = await Promise.all(guesses.map((g) => verify(phone, g)));
      assert.equal(results.filter((r) => r.status === 200).length, 0);
      assert.ok(results.filter((r) => r.status === 404).length <= 4);
      const row = await OTPModel.findOne({ targetValue: phone }).lean();
      assert.equal(row!.attempts, 5);
      assert.equal(row!.isVerified, false);
    });

    await check('the destination is limited across codes: 10 checks an hour, whatever new codes are sent', async () => {
      const phone = nextPhone();
      await send(phone); let code = lastOtp();
      for (let i = 0; i < 5; i++) await verify(phone, wrong(code)); // first code burnt (5 checks)
      await skipGap(); await send(phone); code = lastOtp();
      for (let i = 0; i < 4; i++) assert.equal((await verify(phone, wrong(code))).status, 404); // 9 checks
      assert.equal((await verify(phone, code)).status, 200); // the 10th check, right code: allowed
      await skipGap(); await send(phone); code = lastOtp();
      const r = await verify(phone, code); // 11th check this hour
      assert.equal(r.status, 429); assert.equal(r.body.code, 'OTP_VERIFY_LIMIT');
      assert.ok(Number(r.headers.get('retry-after')) > 0); assert.ok(Number(r.body.retryAfter) > 0);
      assert.equal((await OTPModel.findOne({ targetValue: phone, isVerified: false }).lean())!.attempts, 0); // not spent
    });

    await check('a new code replaces the old one: only the newest pending code works', async () => {
      const phone = nextPhone();
      await send(phone); const first = lastOtp();
      await skipGap(); await send(phone); const second = lastOtp();
      if (first !== second) assert.equal((await verify(phone, first)).status, 404);
      assert.equal(await OTPModel.countDocuments({ targetValue: phone, isVerified: false }), 1);
      assert.equal((await verify(phone, second)).status, 200);
    });

    await check('sending is limited per number before anything happens: 1 per 30 s (Retry-After), 5 per hour', async () => {
      const phone = nextPhone();
      assert.equal((await send(phone)).status, 200);
      const users = await UserModel.countDocuments({ phone });
      const smsBefore = sms.length;
      const r = await send(phone);
      assert.equal(r.status, 429); assert.equal(r.body.code, 'OTP_SEND_LIMIT');
      const wait = Number(r.headers.get('retry-after'));
      assert.ok(wait > 0 && wait <= 30, String(wait));
      assert.equal(sms.length, smsBefore); // no SMS
      for (let i = 2; i <= 5; i++) { await skipGap(); assert.equal((await send(phone)).status, 200, `send ${i}`); }
      await skipGap();
      const sixth = await send(phone);
      assert.equal(sixth.status, 429); assert.ok(Number(sixth.headers.get('retry-after')) > 30);
      assert.equal(await UserModel.countDocuments({ phone }), users);
      // A different number is not affected.
      assert.equal((await send(nextPhone())).status, 200);
    });

    await check('an unknown number refused by the limit creates no account', async () => {
      const phone = nextPhone();
      assert.equal((await send(phone)).status, 200);
      await UserModel.deleteMany({ phone }); await OTPModel.deleteMany({ targetValue: phone });
      assert.equal((await send(phone)).status, 429);
      assert.equal(await UserModel.countDocuments({ phone }), 0);
    });

    await check('counters never contain the number or email, and they expire on their own (TTL)', async () => {
      const phone = nextPhone();
      await send(phone);
      const rows = await OtpThrottleModel.find({}).lean();
      assert.ok(rows.length >= 3);
      for (const r of rows) { assert.ok(!r._id.includes(phone)); assert.ok(r.expireAt.getTime() > Date.now()); }
      const idx = await OtpThrottleModel.collection.indexes();
      assert.ok(idx.some((i) => i.key.expireAt === 1 && i.expireAfterSeconds === 0));
    });

    await check('a code sent before the deploy (plain text row) still works, under the same attempt limit', async () => {
      const phone = nextPhone();
      const u = await UserModel.create({ phone, userType: 'user', isActive: true });
      await OTPModel.collection.insertOne({ userId: u._id, otp: '246810', target: 'phone', targetValue: phone,
        expireAt: new Date(Date.now() + 600000), isVerified: false, createdAt: new Date(), updatedAt: new Date() });
      assert.equal((await verify(phone, '135790')).status, 404);
      assert.equal((await verify(phone, '246810')).status, 200);
    });

    await check('email verification codes have the same limits (send gap and per-code attempts)', async () => {
      const u = await UserModel.create({ phone: nextPhone(), userType: 'user', isActive: true });
      const email = `o1-${Date.now()}@example.com`;
      await auth.sendEmailVerificationOTP(String(u._id), { email } as never);
      await assert.rejects(auth.sendEmailVerificationOTP(String(u._id), { email } as never), (e: { status?: number; code?: string }) =>
        e.status === 429 && e.code === 'OTP_SEND_LIMIT');
      const code = /(\d{6})/.exec(mails[mails.length - 1]!.textBody)![1]!;
      for (let i = 0; i < 4; i++) {
        await assert.rejects(auth.verifyEmailVerificationOTP(String(u._id), { email, otp: wrong(code) } as never),
          (e: { status?: number }) => e.status === 404);
      }
      await assert.rejects(auth.verifyEmailVerificationOTP(String(u._id), { email, otp: wrong(code) } as never),
        (e: { status?: number; code?: string }) => e.status === 429 && e.code === 'OTP_ATTEMPTS_EXCEEDED');
      await assert.rejects(auth.verifyEmailVerificationOTP(String(u._id), { email, otp: code } as never),
        (e: { status?: number }) => e.status === 429);
    });

    await check('per-address limits are off by default and, when on, limit one address across numbers', async () => {
      const settings = CONFIG as unknown as Record<string, unknown>;
      for (let i = 0; i < 4; i++) assert.equal((await send(nextPhone(), 'user', '203.0.113.7')).status, 200);
      settings.OTP_IP_LIMITS = true; settings.OTP_IP_SEND_PER_HOUR = 3; settings.OTP_IP_VERIFY_PER_HOUR = 2;
      try {
        await OtpThrottleModel.deleteMany({});
        for (let i = 0; i < 3; i++) assert.equal((await send(nextPhone(), 'user', '203.0.113.7')).status, 200);
        const fourth = await send(nextPhone(), 'user', '203.0.113.7');
        assert.equal(fourth.status, 429); assert.equal(fourth.body.code, 'OTP_SEND_LIMIT');
        assert.equal((await send(nextPhone(), 'user', '198.51.100.9')).status, 200); // another address
        const phone = nextPhone();
        await send(phone, 'user', '198.51.100.10');
        const code = lastOtp();
        await verify(phone, wrong(code), 'user', '198.51.100.10');
        await verify(phone, wrong(code), 'user', '198.51.100.10');
        const third = await verify(phone, code, 'user', '198.51.100.10');
        assert.equal(third.status, 429); assert.equal(third.body.code, 'OTP_VERIFY_LIMIT');
      } finally {
        settings.OTP_IP_LIMITS = false; settings.OTP_IP_SEND_PER_HOUR = 30; settings.OTP_IP_VERIFY_PER_HOUR = 60;
      }
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed`);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
