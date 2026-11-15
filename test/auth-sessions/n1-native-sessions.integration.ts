/**
 * N1: phone app (native) sessions, against a real MongoDB replica set and the real auth routes over HTTP: OTP verify
 * with {"session":"native","app":...}, body refresh tokens with rotation, the lost-answer retry window, reuse detection,
 * logout, sign-out-everywhere, staff deactivation, expiry and separation from web cookie sessions.
 * Real AuthService, OTP, user and pharmacy models; only SMS/email/wallet providers are stubbed.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/n1_native_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx --tsconfig tsconfig.json test/auth-sessions/n1-native-sessions.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { authenticate } from '@/modules/middleware/auth';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import { UserRepository } from '@/modules/user/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { NATIVE_RETRY_GRACE_MS } from '@/modules/auth/sessions';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/n1_native_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const CUSTOMER = 'https://app.jansetu.test';
if (CONFIG.SESSION_ORIGINS_CUSTOMER !== CUSTOMER) throw new Error('Run with SESSION_ORIGINS_CUSTOMER=' + CUSTOMER + ' SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test');

const sms: { to: string; text: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const userRepository = new UserRepository();
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, new PharmacyRepository(), {},
  new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), userRepository, {} as never), { sendEmail: async () => ({ success: true }) }, smsService);

let base = '';
type Res = { status: number; body: { data?: Record<string, unknown>; code?: string }; setCookie: string | null; headers: Headers };
async function call(path: string, opts: { native?: boolean; origin?: string; webHeader?: boolean; body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Res> {
  if (path.endsWith('/send')) await OtpThrottleModel.deleteMany({}); // O1 limits have their own suite
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.native !== false) headers['x-jansetu-native'] = '1';
  if (opts.origin) headers.origin = opts.origin;
  if (opts.webHeader) headers['x-jansetu-session'] = '1';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer;
  const get = path === '/api/v1/me';
  const r = await fetch(base + path, { method: get ? 'GET' : 'POST', headers, body: get ? undefined : JSON.stringify(opts.body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) as Res['body'], setCookie: r.headers.get('set-cookie'), headers: r.headers };
}
let phoneSeq = 0;
const nextPhone = () => '93' + String(10_000_000 + ++phoneSeq).padStart(8, '0');
const lastOtp = () => /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
const sidOf = (token: string) => String((jwt.decode(token) as { sid: string }).sid);

async function login(userType = 'user', app = 'customer', phone = nextPhone(), extra: Record<string, unknown> = {}) {
  assert.equal((await call(`/api/v1/auth/${userType}/send`, { body: { phone }, native: false })).status, 200);
  const r = await call(`/api/v1/auth/${userType}/verify`, { body: { phone, otp: lastOtp(), session: 'native', app, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { phone, token: String(r.body.data!.token), refresh: String(r.body.data!.refreshToken), res: r };
}
const refresh = (refreshToken: string, app = 'customer') => call('/api/v1/auth/session/native/refresh', { body: { app, refreshToken } });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await AuthSessionModel.createCollection(); await AuthSessionModel.syncIndexes();
  Container.set(AuthService, auth);
  const { default: router } = await import('@/modules/auth/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', router);
  app.get('/api/v1/me', authenticate, (req, res) => { res.json({ data: (req as unknown as { user: unknown }).user }); });
  app.use(errorHandler);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    await check('a phone sign-in returns a 15-minute access token and a refresh token in the body; no cookie, no-store', async () => {
      const l = await login();
      const c = jwt.verify(l.token, CONFIG.JWT_SECRET_KEY) as Record<string, number | string>;
      assert.equal(c.aud, 'native_customer'); assert.equal(Number(c.exp) - Number(c.iat), 900); assert.ok(Number(c.auth_time) > 0);
      assert.match(l.refresh, /^[0-9a-f]{32}\.1\.[A-Za-z0-9_-]{43}$/);
      assert.equal(l.res.setCookie, null); assert.equal(l.res.headers.get('cache-control'), 'no-store');
      assert.equal(Number(l.res.body.data!.refreshExpiresIn), 30 * 86400);
      assert.equal((await call('/api/v1/me', { bearer: l.token })).status, 200);
      const row = (await AuthSessionModel.findById(sidOf(l.token)).lean())!;
      assert.equal(row.audience, 'native_customer');
      assert.ok(Math.abs(row.absoluteExpiresAt.getTime() - row.createdAt.getTime() - 90 * 86400_000) < 5000);
      assert.equal(JSON.stringify(row).includes(l.refresh.split('.')[2]!), false, 'no token secret stored');
    });

    await check('refused BEFORE the code is used: no app header, no app, or the wrong app for the role', async () => {
      const phone = nextPhone();
      await call('/api/v1/auth/user/send', { body: { phone }, native: false });
      const otp = lastOtp();
      const noHeader = await call('/api/v1/auth/user/verify', { native: false, body: { phone, otp, session: 'native', app: 'customer' } });
      assert.equal(noHeader.status, 403); assert.equal(noHeader.body.code, 'NATIVE_SESSION_REFUSED');
      const noApp = await call('/api/v1/auth/user/verify', { body: { phone, otp, session: 'native' } });
      assert.equal(noApp.status, 400);
      const wrongApp = await call('/api/v1/auth/user/verify', { body: { phone, otp, session: 'native', app: 'workspace' } });
      assert.equal(wrongApp.status, 403); assert.equal(wrongApp.body.code, 'SESSION_ROLE_REFUSED');
      const ok = await call('/api/v1/auth/user/verify', { body: { phone, otp, session: 'native', app: 'customer' } });
      assert.equal(ok.status, 200, 'the code was still unused');
    });

    await check('refresh rotates; a lost answer can be retried once within the window; anything older ends the family', async () => {
      const l = await login();
      const r1 = await refresh(l.refresh);
      assert.equal(r1.status, 200); const t1 = String(r1.body.data!.refreshToken);
      assert.match(t1, /\.2\./);
      assert.equal((r1.body.data!.principal as { userType: string }).userType, 'user');
      // The answer to r1 was lost: the app presents gen 1 again within the window and gets the same gen 2 token.
      const retry = await refresh(l.refresh);
      assert.equal(retry.status, 200); assert.equal(retry.body.data!.refreshToken, t1);
      const r2 = await refresh(t1);
      assert.equal(r2.status, 200); const t2 = String(r2.body.data!.refreshToken);
      // gen 1 is now two generations old: reuse, the family ends (even inside the window).
      const reuse = await refresh(l.refresh);
      assert.equal(reuse.status, 401);
      assert.equal((await refresh(t2)).status, 401, 'the family is revoked');
      assert.equal((await call('/api/v1/me', { bearer: String(r2.body.data!.token) })).status, 401, 'and its access token at once');
      assert.equal((await AuthSessionModel.findById(sidOf(l.token)).lean())!.revokeReason, 'reuse_detected');
    });

    await check('the previous token after the retry window is reuse; a forged token revokes nothing', async () => {
      const l = await login();
      const r1 = await refresh(l.refresh);
      const sid = sidOf(l.token);
      await AuthSessionModel.collection.updateOne({ _id: sid as never }, { $set: { lastRefreshAt: new Date(Date.now() - NATIVE_RETRY_GRACE_MS - 1000) } });
      const forged = l.refresh.replace(/\.[A-Za-z0-9_-]{43}$/, '.' + 'A'.repeat(43));
      assert.equal((await refresh(forged)).status, 401);
      assert.equal((await AuthSessionModel.findById(sid).lean())!.revokedAt, undefined);
      assert.equal((await refresh(l.refresh)).status, 401);
      assert.equal((await AuthSessionModel.findById(sid).lean())!.revokeReason, 'reuse_detected');
      assert.equal((await refresh(String(r1.body.data!.refreshToken))).status, 401);
    });

    await check('native and web sessions stay apart: neither token works on the other route, nor revokes the other', async () => {
      const l = await login();
      // A native refresh token presented as the web cookie.
      const asCookie = await call('/api/v1/auth/session/refresh', { native: false, origin: CUSTOMER, webHeader: true, cookie: `__Host-sd_rt=${l.refresh}` });
      assert.equal(asCookie.status, 401);
      assert.equal((await AuthSessionModel.findById(sidOf(l.token)).lean())!.revokedAt, undefined);
      // The customer app on the workspace audience: not this family.
      assert.equal((await refresh(l.refresh, 'workspace')).status, 401);
      assert.equal((await AuthSessionModel.findById(sidOf(l.token)).lean())!.revokedAt, undefined);
      // A refresh without the app header is refused outright.
      const noHeader = await call('/api/v1/auth/session/native/refresh', { native: false, body: { app: 'customer', refreshToken: l.refresh } });
      assert.equal(noHeader.status, 403);
      assert.equal((await refresh(l.refresh)).status, 200, 'still live');
    });

    await check('logout by refresh token ends the family and its access token; the access token alone ends its own family', async () => {
      const a = await login();
      const out = await call('/api/v1/auth/session/native/logout', { body: { app: 'customer', refreshToken: a.refresh } });
      assert.equal(out.status, 200);
      assert.equal((await call('/api/v1/me', { bearer: a.token })).status, 401);
      assert.equal((await refresh(a.refresh)).status, 401);
      const b = await login();
      assert.equal((await call('/api/v1/auth/session/native/logout', { bearer: b.token, body: { app: 'customer' } })).status, 200);
      assert.equal((await AuthSessionModel.findById(sidOf(b.token)).lean())!.revokeReason, 'logout');
      assert.equal((await call('/api/v1/auth/session/native/logout', { body: { app: 'customer', refreshToken: a.refresh } })).status, 200, 'idempotent');
    });

    await check('a new sign-in on the phone ends the family the app still held (previousRefreshToken)', async () => {
      const a = await login();
      const b = await login('user', 'customer', nextPhone(), { previousRefreshToken: a.refresh });
      assert.equal((await AuthSessionModel.findById(sidOf(a.token)).lean())!.revokeReason, 'replaced_by_new_sign_in');
      assert.equal((await call('/api/v1/me', { bearer: a.token })).status, 401);
      assert.equal((await call('/api/v1/me', { bearer: b.token })).status, 200);
    });

    await check('customer sign-out everywhere ends phone sessions too', async () => {
      const phone = nextPhone();
      const a = await login('user', 'customer', phone);
      const b = await login('user', 'customer', phone);
      assert.equal((await call('/api/v1/auth/sessions/revoke', { native: false, bearer: a.token })).status, 200);
      assert.equal((await refresh(b.refresh)).status, 401);
      assert.equal((await call('/api/v1/me', { bearer: b.token })).status, 401);
    });

    await check('staff on the phone: a pharmacy signs in to the workspace app; deactivation ends refresh', async () => {
      const phone = nextPhone();
      await PharmacyModel.create({ name: 'Phone Pharmacy', phone, isActive: true, isVerified: true });
      const p = await login('pharmacy', 'workspace', phone);
      assert.equal((jwt.decode(p.token) as { aud: string }).aud, 'native_workspace');
      const row = (await AuthSessionModel.findById(sidOf(p.token)).lean())!;
      assert.ok(Math.abs(row.idleExpiresAt.getTime() - row.createdAt.getTime() - 12 * 3600_000) < 5000);
      const r1 = await refresh(p.refresh, 'workspace');
      assert.equal(r1.status, 200);
      await PharmacyModel.updateOne({ phone }, { $set: { isActive: false } });
      assert.equal((await refresh(String(r1.body.data!.refreshToken), 'workspace')).status, 401);
      assert.equal((await AuthSessionModel.findById(sidOf(p.token)).lean())!.revokeReason, 'account_changed');
    });

    await check('idle and absolute expiry end refresh (also inside the retry window)', async () => {
      const a = await login();
      await AuthSessionModel.collection.updateOne({ _id: sidOf(a.token) as never }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await refresh(a.refresh)).status, 401);
      const b = await login();
      await refresh(b.refresh);
      await AuthSessionModel.collection.updateOne({ _id: sidOf(b.token) as never }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await refresh(b.refresh)).status, 401, 'no retry past the absolute expiry');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed`);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
