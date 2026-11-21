/**
 * Q7: partner sign-in for a person with several memberships (e.g. a doctor's solo practice and a clinic): the code
 * proves the phone, then the person chooses a workspace with a short-lived, one-use ticket (bearer, cookie or native).
 * Real AuthService, OTP, member/partner models and auth routes over HTTP; only SMS/email/wallet providers are stubbed.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q7_select_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx test/auth-sessions/q7-partner-select.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { authenticate } from '@/modules/middleware/auth';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { UserRepository } from '@/modules/user/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { PartnerSelectionTicketModel } from '@/modules/auth/model/partnerSelection';
import { errorHandler } from '@/modules/middleware';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q7_select_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const STAFF = 'https://staff.jansetu.test';
if (CONFIG.SESSION_ORIGINS_WORKSPACE !== STAFF) throw new Error('Run with SESSION_ORIGINS_WORKSPACE=' + STAFF + ' (and SESSION_ORIGINS_CUSTOMER)');

const sms: { to: string; text: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const userRepository = new UserRepository();
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, new PharmacyRepository(), {},
  new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), userRepository, {} as never), { sendEmail: async () => ({ success: true }) }, smsService,
  new MemberRepository());

let base = '';
type Res = { status: number; body: { data?: Record<string, any>; code?: string }; cookie: string | null };
async function call(path: string, body: unknown, opts: { cookieMode?: boolean; native?: boolean; bearer?: string; noSession?: boolean } = {}): Promise<Res> {
  if (path.endsWith('/send')) await OtpThrottleModel.deleteMany({});
  // Q16b: partner sign-in (verify, select) always opens a session; a call that names none uses the phone-app session.
  if (/\/auth\/partner\/(verify|select)$/.test(path) && !opts.noSession && body && typeof body === 'object' && !(body as { session?: unknown }).session) {
    body = { ...body, session: 'native', app: 'workspace' };
    opts = { ...opts, native: true };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: STAFF };
  if (opts.cookieMode) headers['x-jansetu-session'] = '1';
  if (opts.native) headers['x-jansetu-native'] = '1';
  if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer;
  const r = await fetch(base + path, { method: path === '/api/v1/me' ? 'GET' : 'POST', headers, body: path === '/api/v1/me' ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as Res['body'], cookie: r.headers.getSetCookie().find((c) => /sd_staff_rt=/.test(c)) ?? null };
}
const lastOtp = () => /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
let seq = 0;
const nextPhone = () => '97' + String(10_000_000 + ++seq).padStart(8, '0');

async function partner(name: string, kind: 'lab' | 'clinic', isActive = true) {
  const [p] = await PartnerModel.create([{ kind, name, contact: { phone: nextPhone() }, taxRegime: 'unregistered', invoiceSeries: { prefix: 'X' },
    activeOwnerCount: 1, isActive, verification: { state: 'verified', documents: [] } }]);
  return String(p!._id);
}
const member = (partnerId: string, phone: string, role: 'owner' | 'staff' = 'staff') =>
  MemberModel.create({ partnerId, phone, name: 'Dr Iyer', role, permissions: [], branchIds: [], isActive: true });

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  for (const M of [AuthSessionModel, PartnerSelectionTicketModel, MemberModel, PartnerModel] as mongoose.Model<any>[]) { await M.createCollection(); await M.syncIndexes(); }
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
    const phone = nextPhone();
    const solo = await partner('Iyer Practice', 'clinic');
    const clinic = await partner('Care Clinic', 'clinic');
    await member(solo, phone, 'owner');
    await member(clinic, phone);

    await check('one membership: the code signs straight in (unchanged)', async () => {
      const p = nextPhone();
      const only = await partner('Only Lab', 'lab');
      await member(only, p);
      assert.equal((await call('/api/v1/auth/partner/send', { phone: p })).status, 200);
      const r = await call('/api/v1/auth/partner/verify', { phone: p, otp: lastOtp() });
      assert.equal(r.status, 200);
      assert.equal((jwt.decode(String(r.body.data!.token)) as any).partnerId, only);
    });

    let ticket = '';
    await check('several memberships: the code is sent and proves the phone; the answer is the choices and a ticket, never a token', async () => {
      assert.equal((await call('/api/v1/auth/partner/send', { phone })).status, 200);
      await assert.equal((await call('/api/v1/auth/partner/verify', { phone, otp: '000000' })).status >= 400, true, 'a wrong code still fails');
      const r = await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data!.selectionRequired, true);
      assert.equal(r.body.data!.token, undefined);
      assert.deepEqual(r.body.data!.choices.map((c: any) => c.name).sort(), ['Care Clinic', 'Iyer Practice']);
      ticket = String(r.body.data!.ticket);
      assert.equal((await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() })).status >= 400, true, 'the code was used');
    });

    await check('the chosen workspace signs in once (cookie session); the ticket cannot be reused or name a workspace that is not theirs', async () => {
      const elsewhere = await partner('Not Mine', 'lab');
      assert.equal((await call('/api/v1/auth/partner/select', { ticket, partnerId: elsewhere })).status, 403);
      // A refusal still spent the ticket: a new code is needed.
      assert.equal((await call('/api/v1/auth/partner/select', { ticket, partnerId: clinic })).status, 401);
      await call('/api/v1/auth/partner/send', { phone });
      const fresh = String((await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() })).body.data!.ticket);
      const s = await call('/api/v1/auth/partner/select', { ticket: fresh, partnerId: clinic, session: 'cookie' }, { cookieMode: true });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.ok(s.cookie, 'a workspace session cookie');
      const claims = jwt.decode(String(s.body.data!.token)) as any;
      assert.deepEqual([claims.userType, claims.partnerId, claims.aud], ['partner', clinic, 'workspace']);
      assert.equal((await call('/api/v1/me', {}, { bearer: String(s.body.data!.token) })).status, 200);
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: fresh, partnerId: solo })).status, 401, 'one use');
    });

    await check('tickets: forged, wrong purpose or expired are refused; an inactive partner is not offered', async () => {
      const forged = jwt.sign({ purpose: 'partner_select', phone, jti: 'x' }, 'not-the-secret', { expiresIn: 300 });
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: forged, partnerId: clinic })).status, 401);
      const wrong = jwt.sign({ purpose: 'other', phone, jti: 'y' }, CONFIG.JWT_SECRET_KEY, { expiresIn: 300 });
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: wrong, partnerId: clinic })).status, 401);
      await PartnerSelectionTicketModel.create({ jti: 'old', phone, expiresAt: new Date(Date.now() - 1000) });
      const stale = jwt.sign({ purpose: 'partner_select', phone, jti: 'old' }, CONFIG.JWT_SECRET_KEY, { expiresIn: 300 });
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: stale, partnerId: clinic })).status, 401);
      const off = await partner('Closed Lab', 'lab', false);
      await member(off, phone);
      await call('/api/v1/auth/partner/send', { phone });
      const r = await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() });
      assert.ok(!r.body.data!.choices.some((c: any) => c.partnerId === off));
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: r.body.data!.ticket, partnerId: off })).status, 403);
    });

    await check('native phone-app choice and role/audience checks on select', async () => {
      await call('/api/v1/auth/partner/send', { phone });
      const t = String((await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() })).body.data!.ticket);
      const n = await call('/api/v1/auth/partner/select', { ticket: t, partnerId: solo, session: 'native', app: 'workspace' }, { native: true });
      assert.equal(n.status, 200, JSON.stringify(n.body));
      assert.ok(n.body.data!.refreshToken && n.body.data!.token);
      assert.equal((jwt.decode(String(n.body.data!.token)) as any).partnerId, solo);
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: 'x', partnerId: solo, session: 'native', app: 'customer' }, { native: true })).status, 400);
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: 'x', partnerId: 'nope' })).status, 400);
    });

    await check('a selection ticket never authenticates an ordinary route, before or after it is used; nor does any non-access token', async () => {
      await call('/api/v1/auth/partner/send', { phone });
      const t = String((await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp() })).body.data!.ticket);
      assert.equal((await call('/api/v1/me', {}, { bearer: t })).status, 401, 'unused ticket');
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: t, partnerId: clinic })).status, 200);
      assert.equal((await call('/api/v1/me', {}, { bearer: t })).status, 401, 'used ticket');
      // Defence in depth: even signed with the access key, a purpose-carrying or identity-less token is refused.
      const withPurpose = jwt.sign({ purpose: 'partner_select', phone, jti: 'z', _id: 'x', userType: 'partner' }, CONFIG.JWT_SECRET_KEY, { expiresIn: 300 });
      assert.equal((await call('/api/v1/me', {}, { bearer: withPurpose })).status, 401);
      assert.equal((await call('/api/v1/me', {}, { bearer: jwt.sign({ phone }, CONFIG.JWT_SECRET_KEY) })).status, 401);
      assert.equal((await call('/api/v1/me', {}, { bearer: jwt.sign({ _id: 'u1', userType: 'robot' }, CONFIG.JWT_SECRET_KEY) })).status, 401);
      // A ticket signed with the access key (the old format) is not a ticket either.
      const old = jwt.sign({ purpose: 'partner_select', phone, jti: 'w' }, CONFIG.JWT_SECRET_KEY, { expiresIn: 300 });
      await PartnerSelectionTicketModel.create({ jti: 'w', phone, expiresAt: new Date(Date.now() + 60_000) });
      assert.equal((await call('/api/v1/auth/partner/select', { ticket: old, partnerId: clinic })).status, 401);
    });

    await check('naming the partner up front still works (code bound to that membership)', async () => {
      await call('/api/v1/auth/partner/send', { phone, partnerId: clinic });
      const r = await call('/api/v1/auth/partner/verify', { phone, otp: lastOtp(), partnerId: clinic });
      assert.equal(r.status, 200);
      assert.equal((jwt.decode(String(r.body.data!.token)) as any).partnerId, clinic);
      assert.ok(Types.ObjectId.isValid(clinic));
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
