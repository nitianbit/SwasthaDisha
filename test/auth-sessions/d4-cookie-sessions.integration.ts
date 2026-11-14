/**
 * D4: web sessions that survive a reload, against a real MongoDB replica set and the real auth routes over HTTP:
 * OTP verify with {"session":"cookie"}, refresh rotation with reuse detection, logout, sign-out-everywhere, staff
 * sessions, idle/absolute expiry, origin/header (login CSRF) refusal, and per-request session checks.
 * Real AuthService, OTP, user and pharmacy models; only SMS/email/wallet providers are stubbed.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/d4_sessions_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx --tsconfig tsconfig.json test/auth-sessions/d4-cookie-sessions.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { authenticate, authenticateOptional } from '@/modules/middleware/auth';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { UserRepository } from '@/modules/user/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { reissueForCaller } from '@/modules/auth/sessions';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d4_sessions_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const CUSTOMER = 'https://app.jansetu.test';
const STAFF = 'https://staff.jansetu.test';
if (CONFIG.SESSION_ORIGINS_CUSTOMER !== CUSTOMER || CONFIG.SESSION_ORIGINS_WORKSPACE !== STAFF) {
  throw new Error('Run with SESSION_ORIGINS_CUSTOMER=' + CUSTOMER + ' SESSION_ORIGINS_WORKSPACE=' + STAFF);
}

const sms: { to: string; text: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const emailService = { sendEmail: async () => ({ success: true, data: null }) };
const userRepository = new UserRepository();
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, new PharmacyRepository(), {},
  new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), userRepository, {} as never), emailService, smsService);

let base = '';
type Res = { status: number; body: { data?: Record<string, unknown>; code?: string }; cookie: string | null; headers: Headers };
async function call(path: string, opts: { origin?: string | null; header?: boolean; body?: unknown; cookie?: string | null; bearer?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== null) headers.origin = opts.origin ?? CUSTOMER;
  if (opts.header !== false) headers['x-jansetu-session'] = '1';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer;
  const r = await fetch(base + path, { method: path === '/api/v1/me' ? 'GET' : 'POST', headers, body: path === '/api/v1/me' ? undefined : JSON.stringify(opts.body ?? {}) });
  const set = r.headers.getSetCookie().find((c) => /sd_(staff_)?rt=/.test(c)) ?? null;
  return { status: r.status, body: await r.json().catch(() => ({})) as Res['body'], cookie: set, headers: r.headers };
}
const pair = (setCookie: string | null) => (setCookie ? setCookie.split(';')[0]! : null);
let phoneSeq = 0;
const nextPhone = () => '96' + String(10_000_000 + ++phoneSeq).padStart(8, '0');
const lastOtp = () => /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;

async function login(userType: string, origin: string, phone = nextPhone()) {
  const sent = await call(`/api/v1/auth/${userType}/send`, { body: { phone }, origin, header: false });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const r = await call(`/api/v1/auth/${userType}/verify`, { body: { phone, otp: lastOtp(), session: 'cookie' }, origin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { phone, token: String(r.body.data!.token), cookie: pair(r.cookie)!, setCookie: r.cookie!, res: r };
}

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
    await check('a customer cookie login: 15-minute access token with sid/aud/auth_time, a first-party refresh cookie, no-store', async () => {
      const l = await login('user', CUSTOMER);
      const c = jwt.verify(l.token, CONFIG.JWT_SECRET_KEY) as Record<string, number | string>;
      assert.equal(c.aud, 'customer'); assert.equal(c.userType, 'user'); assert.match(String(c.sid), /^[0-9a-f]{32}$/);
      assert.ok(Number(c.exp) - Number(c.iat) === 900); assert.ok(Number(c.auth_time) > 0);
      assert.match(l.setCookie, /^__Host-sd_rt=[0-9a-f]{32}\.1\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
      assert.equal(l.res.headers.get('cache-control'), 'no-store');
      assert.equal((await call('/api/v1/me', { bearer: l.token })).status, 200);
      const row = (await AuthSessionModel.findById(String(c.sid)).lean())!;
      assert.equal(row.gen, 1); assert.equal(JSON.stringify(row).includes(l.cookie.split('=')[1]!.split('.')[2]!), false, 'no token secret stored');
    });

    await check('login CSRF: missing / null / unlisted Origin, missing header, or the wrong app refuse BEFORE the OTP is used', async () => {
      const phone = nextPhone();
      await call('/api/v1/auth/user/send', { body: { phone }, header: false });
      const otp = lastOtp();
      for (const [opts, code] of [
        [{ origin: null }, 'SESSION_ORIGIN_REFUSED'], [{ origin: 'null' }, 'SESSION_ORIGIN_REFUSED'],
        [{ origin: 'https://evil.example' }, 'SESSION_ORIGIN_REFUSED'], [{ header: false }, 'SESSION_ORIGIN_REFUSED'],
        [{ origin: STAFF }, 'SESSION_ROLE_REFUSED'],
      ] as const) {
        const r = await call('/api/v1/auth/user/verify', { ...opts, body: { phone, otp, session: 'cookie' } });
        assert.equal(r.status, 403, JSON.stringify(opts)); assert.equal(r.body.code, code); assert.equal(r.cookie, null);
      }
      const ok = await call('/api/v1/auth/user/verify', { body: { phone, otp, session: 'cookie' } });
      assert.equal(ok.status, 200, 'the code was still unused');
    });

    await check('refresh rotates the cookie; presenting an old one ends the whole session', async () => {
      const l = await login('user', CUSTOMER);
      const r1 = await call('/api/v1/auth/session/refresh', { cookie: l.cookie });
      assert.equal(r1.status, 200); assert.ok(r1.cookie); assert.notEqual(pair(r1.cookie), l.cookie);
      assert.equal(r1.headers.get('cache-control'), 'no-store');
      const t1 = jwt.decode(String(r1.body.data!.token)) as Record<string, number>;
      const t0 = jwt.decode(l.token) as Record<string, number>;
      assert.equal(t1.auth_time, t0.auth_time, 'auth time is never refreshed');
      const r2 = await call('/api/v1/auth/session/refresh', { cookie: pair(r1.cookie) });
      assert.equal(r2.status, 200);
      const reuse = await call('/api/v1/auth/session/refresh', { cookie: l.cookie });
      assert.equal(reuse.status, 401); assert.match(reuse.cookie ?? '', /Max-Age=0/);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: pair(r2.cookie) })).status, 401, 'the family is revoked');
      assert.equal((await call('/api/v1/me', { bearer: String(r2.body.data!.token) })).status, 401, 'and its access token at once');
      const row = (await AuthSessionModel.findById(String(t0.sid)).lean())!;
      assert.equal(row.revokeReason, 'reuse_detected');
    });

    await check('two refreshes with the same cookie (no client lock): one wins, the other is treated as reuse', async () => {
      const l = await login('user', CUSTOMER);
      const [a, b] = await Promise.all([call('/api/v1/auth/session/refresh', { cookie: l.cookie }), call('/api/v1/auth/session/refresh', { cookie: l.cookie })]);
      assert.deepEqual([a.status, b.status].sort(), [200, 401]);
    });

    await check('reuse is detected for the whole family lifetime (an old token after 25 rotations), never from a forged token', async () => {
      const l = await login('user', CUSTOMER);
      let cookie = l.cookie;
      for (let i = 0; i < 25; i++) {
        const r = await call('/api/v1/auth/session/refresh', { cookie });
        assert.equal(r.status, 200); cookie = pair(r.cookie)!;
      }
      const forged = l.cookie.replace(/\.[A-Za-z0-9_-]{43}$/, '.' + 'A'.repeat(43));
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: forged })).status, 401);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie.replace('.1.', '.99.') })).status, 401);
      const sid = String((jwt.decode(l.token) as Record<string, string>).sid);
      assert.equal((await AuthSessionModel.findById(sid).lean())!.revokedAt, undefined, 'unsigned or forged tokens revoke nothing');
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie })).status, 401, 'the original token, 25 generations old');
      assert.equal((await AuthSessionModel.findById(sid).lean())!.revokeReason, 'reuse_detected');
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie })).status, 401, 'the current holder (maybe a thief) is out too');
    });

    await check('a replacement token for a session-bound caller stays bound to that session (and dies with its logout)', async () => {
      const l = await login('user', CUSTOMER);
      const caller = jwt.verify(l.token, CONFIG.JWT_SECRET_KEY) as Record<string, unknown>;
      const legacy = jwt.sign({ _id: caller._id, userType: 'user', authVersion: caller.authVersion ?? 0 }, CONFIG.JWT_SECRET_KEY, { expiresIn: '30d' });
      const replaced = reissueForCaller(caller as never, legacy);
      const r = jwt.decode(replaced) as Record<string, number | string>;
      assert.equal(r.sid, caller.sid); assert.equal(r.aud, 'customer'); assert.equal(r.auth_time, caller.auth_time);
      assert.equal(Number(r.exp) - Number(r.iat), 900);
      assert.equal(reissueForCaller({} as never, legacy), legacy, 'legacy callers keep the legacy token');
      assert.equal((await call('/api/v1/me', { bearer: replaced })).status, 200);
      await call('/api/v1/auth/session/logout', { cookie: l.cookie });
      assert.equal((await call('/api/v1/me', { bearer: replaced })).status, 401);
    });

    await check('a fresh sign-in replaces the browser\'s previous family; sign-out also ends the family of the token in use', async () => {
      const phone = nextPhone();
      const first = await login('user', CUSTOMER, phone);
      // Sign in again in the same browser (the old cookie is presented): the old family is revoked.
      await call('/api/v1/auth/user/send', { body: { phone }, header: false });
      const again = await call('/api/v1/auth/user/verify', { body: { phone, otp: lastOtp(), session: 'cookie' }, cookie: first.cookie });
      assert.equal(again.status, 200);
      assert.equal((await call('/api/v1/me', { bearer: first.token })).status, 401, 'the replaced family is over');
      // A tab holding family S1's token while the cookie belongs to S2 (signed in elsewhere without the old cookie).
      const s1 = await login('user', CUSTOMER, phone);
      await call('/api/v1/auth/user/send', { body: { phone }, header: false });
      const s2 = await call('/api/v1/auth/user/verify', { body: { phone, otp: lastOtp(), session: 'cookie' } });
      const out = await call('/api/v1/auth/session/logout', { cookie: pair(s2.cookie), bearer: s1.token });
      assert.equal(out.status, 200);
      assert.equal((await call('/api/v1/me', { bearer: s1.token })).status, 401, 'the tab\'s own family ended');
      assert.equal((await call('/api/v1/me', { bearer: String(s2.body.data!.token) })).status, 401, 'and the cookie\'s');
    });

    await check('refresh is refused without the header, from another origin, or with the other app\'s cookie', async () => {
      const l = await login('user', CUSTOMER);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie, header: false })).status, 403);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie, origin: 'https://evil.example' })).status, 403);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie, origin: STAFF })).status, 401, 'the staff app reads its own cookie');
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie })).status, 200, 'still valid on its own app');
    });

    await check('logout ends the session and its access token immediately', async () => {
      const l = await login('user', CUSTOMER);
      const out = await call('/api/v1/auth/session/logout', { cookie: l.cookie });
      assert.equal(out.status, 200); assert.match(out.cookie ?? '', /Max-Age=0/);
      assert.equal((await call('/api/v1/me', { bearer: l.token })).status, 401);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: l.cookie })).status, 401);
      assert.equal((await call('/api/v1/auth/session/logout', { cookie: l.cookie })).status, 200, 'idempotent');
    });

    await check('customer "sign out everywhere" ends every web session and token', async () => {
      const phone = nextPhone();
      const a = await login('user', CUSTOMER, phone);
      const b = await login('user', CUSTOMER, phone);
      assert.equal((await call('/api/v1/auth/sessions/revoke', { bearer: a.token })).status, 200);
      for (const s of [a, b]) {
        assert.equal((await call('/api/v1/auth/session/refresh', { cookie: s.cookie })).status, 401);
        assert.equal((await call('/api/v1/me', { bearer: s.token })).status, 401);
      }
    });

    await check('staff: a pharmacy signs in on the staff app with its own cookie; deactivation and revoke-all end it', async () => {
      const l = await login('pharmacy', STAFF);
      assert.match(l.setCookie, /^__Host-sd_staff_rt=/);
      const c = jwt.decode(l.token) as Record<string, string>;
      assert.equal(c.aud, 'workspace'); assert.equal(c.pharmacyId, c._id);
      const r = await call('/api/v1/auth/session/refresh', { cookie: l.cookie, origin: STAFF });
      assert.equal(r.status, 200);
      // Policy: an unverified (onboarding) pharmacy keeps its session; operational routes check verification per action.
      await PharmacyModel.updateOne({ _id: c._id }, { $set: { isVerified: false } });
      const onboarding = await call('/api/v1/auth/session/refresh', { cookie: pair(r.cookie), origin: STAFF });
      assert.equal(onboarding.status, 200);
      r.cookie = onboarding.cookie;
      await PharmacyModel.updateOne({ _id: c._id }, { $set: { isActive: false } });
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: pair(r.cookie), origin: STAFF })).status, 401);
      await PharmacyModel.updateOne({ _id: c._id }, { $set: { isActive: true } });
      const again = await login('pharmacy', STAFF, l.phone);
      assert.equal((await call('/api/v1/auth/sessions/revoke', { bearer: again.token })).status, 200);
      assert.equal((await call('/api/v1/me', { bearer: again.token })).status, 401);
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: again.cookie, origin: STAFF })).status, 401);
      // A pharmacy cannot open a customer-app session.
      const phone = nextPhone();
      await call('/api/v1/auth/pharmacy/send', { body: { phone }, header: false, origin: STAFF });
      const refused = await call('/api/v1/auth/pharmacy/verify', { body: { phone, otp: lastOtp(), session: 'cookie' }, origin: CUSTOMER });
      assert.equal(refused.status, 403); assert.equal(refused.body.code, 'SESSION_ROLE_REFUSED');
    });

    await check('idle and absolute expiry end refresh; refresh never moves the absolute expiry', async () => {
      const l = await login('user', CUSTOMER);
      const sid = String((jwt.decode(l.token) as Record<string, string>).sid);
      const before = (await AuthSessionModel.findById(sid).lean())!;
      const r = await call('/api/v1/auth/session/refresh', { cookie: l.cookie });
      const after = (await AuthSessionModel.findById(sid).lean())!;
      assert.equal(after.absoluteExpiresAt.getTime(), before.absoluteExpiresAt.getTime());
      assert.ok(after.idleExpiresAt.getTime() <= after.absoluteExpiresAt.getTime());
      await AuthSessionModel.collection.updateOne({ _id: sid as never }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: pair(r.cookie) })).status, 401);
      const m = await login('user', CUSTOMER);
      const sid2 = String((jwt.decode(m.token) as Record<string, string>).sid);
      await AuthSessionModel.collection.updateOne({ _id: sid2 as never }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call('/api/v1/auth/session/refresh', { cookie: m.cookie })).status, 401);
      assert.equal((await call('/api/v1/me', { bearer: m.token })).status, 401);
    });

    await check('without {"session":"cookie"} the login is unchanged (bearer, no cookie); bad tokens on optional auth are 401', async () => {
      const phone = nextPhone();
      await call('/api/v1/auth/user/send', { body: { phone }, header: false });
      const r = await call('/api/v1/auth/user/verify', { body: { phone, otp: lastOtp() }, origin: null, header: false });
      assert.equal(r.status, 200); assert.equal(r.cookie, null);
      const c = jwt.decode(String(r.body.data!.token)) as Record<string, number>;
      assert.equal(c.sid, undefined); assert.ok(c.exp - c.iat >= 29 * 24 * 3600);
      let seen: { status?: number } | undefined;
      await authenticateOptional({ headers: { authorization: 'Bearer not-a-token' } } as never, {} as never, ((e?: { status?: number }) => { seen = e; }) as never);
      assert.equal(seen?.status, 401);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
