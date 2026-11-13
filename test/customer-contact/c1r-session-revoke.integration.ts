/**
 * C1 revoke-only against a real MongoDB replica set: today's customer OTP login (unchanged), credential generation in
 * customer tokens, the authenticate middleware check and POST /v1/auth/sessions/revoke. Real AuthService, UserModel,
 * OTP and notification code; only SMS/email/wallet providers are stubbed.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/c1r_revoke_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/customer-contact/c1r-session-revoke.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { authenticate, authenticateOptional } from '@/modules/middleware/auth';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import { storedCredentialVersion } from '@/modules/user/credentialGeneration';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/c1r_revoke_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const sms: { to: string; text: string }[] = [];
const mail: { to: string[]; textBody: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const emailService = { sendEmail: async (m: { to: string[]; textBody: string }) => { mail.push(m); return { success: true, data: null }; } };
const userRepository = new UserRepository();
const otpService = new OTPService(new OTPRepository());
const notificationService = new NotificationService(new NotificationRepository(), userRepository, {} as never);
const walletService = { getByUserId: async () => ({}) };
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(userRepository, {}, {}, {}, {}, {},
  otpService, walletService, notificationService, emailService, smsService);

const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '30d' });
const claims = (token: string) => jwt.verify(token, CONFIG.JWT_SECRET_KEY) as Record<string, unknown>;
async function admits(token: string, mw = authenticate): Promise<{ ok: boolean; code?: string; status?: number }> {
  const req = { headers: { authorization: 'Bearer ' + token } } as never;
  let result: { ok: boolean; code?: string; status?: number } = { ok: false, code: 'NO_CALL' };
  await mw(req, {} as never, ((e?: { code?: string; status?: number }) => { result = e ? { ok: false, code: e.code, status: e.status } : { ok: true }; }) as never);
  return result;
}
const version = async (id: string) => (await UserModel.findById(id).select('+authVersion').lean())?.authVersion;
const lastOtp = (text: string) => /(\d{6})/.exec(text)?.[1] ?? '';
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}
let phoneSeq = 0;
async function customer() {
  const phone = '98' + String(10_000_000 + ++phoneSeq).padStart(8, '0');
  const u = await UserModel.create({ phone, userType: 'user', isActive: true });
  return { id: String(u._id), phone };
}
async function login(phone: string): Promise<string> {
  await auth.sendOTP({ userType: 'user', phone } as never);
  const out = await auth.verifyOTP({ userType: 'user', phone, otp: lastOtp(sms[sms.length - 1].text) } as never) as { accessToken: string };
  return out.accessToken;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await UserModel.init();

  await check('today\'s OTP login still works and the token carries generation 0; nobody is signed out by the deploy', async () => {
    const c = await customer();
    const legacy = sign({ _id: c.id, phone: c.phone, userType: 'user' });          // token issued before this change
    const token = await login(c.phone);
    assert.equal(claims(token).authVersion, 0);
    assert.deepEqual(await admits(token), { ok: true });
    assert.deepEqual(await admits(legacy), { ok: true }, 'pre-deploy tokens keep working');
    assert.equal(await version(c.id), undefined, 'login does not write the field');
  });

  await check('sign out everywhere: every device (and pre-deploy tokens) refused; a new OTP login works at the next generation', async () => {
    const c = await customer();
    const legacy = sign({ _id: c.id, phone: c.phone, userType: 'user' });
    const a = await login(c.phone), b = await login(c.phone);
    assert.deepEqual(await auth.revokeSessions(claims(a) as never), { signedOutEverywhere: true, reauthenticationRequired: true });
    assert.equal(await version(c.id), 1);
    for (const t of [a, b, legacy]) assert.deepEqual(await admits(t), { ok: false, code: 'UNAUTHORIZED', status: 401 });
    assert.equal((await admits(a, authenticateOptional)).status, 401, 'optional auth refuses it too (no silent downgrade)');
    const fresh = await login(c.phone);
    assert.equal(claims(fresh).authVersion, 1);
    assert.deepEqual(await admits(fresh), { ok: true });
    await rejects(auth.revokeSessions(claims(a) as never), 'UNAUTHORIZED', 401);  // an old token cannot revoke again
    assert.equal(await version(c.id), 1);
  });

  await check('two devices revoke at the same moment: exactly one advances the generation', async () => {
    const c = await customer();
    const a = await login(c.phone), b = await login(c.phone);
    const r = await Promise.allSettled([auth.revokeSessions(claims(a) as never), auth.revokeSessions(claims(b) as never)]);
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(await version(c.id), 1);
  });

  await check('a login whose token is signed while a revoke commits carries the old generation and is refused', async () => {
    const c = await customer();
    const a = await login(c.phone);
    await auth.sendOTP({ userType: 'user', phone: c.phone } as never);
    const otp = lastOtp(sms[sms.length - 1].text);
    await auth.revokeSessions(claims(a) as never);                                   // generation 0 -> 1
    const out = await auth.verifyOTP({ userType: 'user', phone: c.phone, otp } as never) as { accessToken: string };
    assert.equal(claims(out.accessToken).authVersion, 1, 'issued after the revoke: current generation');
    const racing = sign({ _id: c.id, phone: c.phone, userType: 'user', authVersion: 0 }); // signed from a pre-revoke read
    assert.equal((await admits(racing)).code, 'UNAUTHORIZED');
  });

  await check('email verification re-issues a token only for a still-valid session, at the same generation', async () => {
    const c = await customer();
    const a = await login(c.phone);
    const sendAndVerify = async (token: string, email: string) => {
      await auth.sendEmailVerificationOTP(c.id, { email } as never);
      const otp = lastOtp(mail[mail.length - 1].textBody);
      return auth.verifyEmailVerificationOTP(c.id, { otp, email } as never, Number(claims(token).authVersion ?? 0));
    };
    const ok = await sendAndVerify(a, `c${phoneSeq}@example.com`);
    assert.equal(claims(ok.accessToken).authVersion, 0);
    assert.deepEqual(await admits(ok.accessToken), { ok: true });
    // A request admitted just before "sign out everywhere" must not get a fresh valid token or set the email. (Since the
    // milestone F4 rule an existing email can only be re-verified, so use a customer adding their first email.)
    const d = await customer();
    const t = await login(d.phone);
    await auth.sendEmailVerificationOTP(d.id, { email: `late${phoneSeq}@example.com` } as never);
    const otp = lastOtp(mail[mail.length - 1].textBody);
    await auth.revokeSessions(claims(t) as never);
    await rejects(auth.verifyEmailVerificationOTP(d.id, { otp, email: `late${phoneSeq}@example.com` } as never, 0), 'UNAUTHORIZED', 401);
    assert.equal((await UserModel.findById(d.id).lean())!.email, undefined, 'email not set');
  });

  await check('malformed generation claims, deleted accounts and corrupt stored values are refused; other user types are unaffected', async () => {
    const c = await customer();
    for (const bad of [-1, 1.5, '0', [0], null]) {
      assert.equal((await admits(sign({ _id: c.id, userType: 'user', authVersion: bad }))).status, 401, `claim ${JSON.stringify(bad)}`);
    }
    assert.equal((await admits(sign({ _id: new Types.ObjectId().toHexString(), userType: 'user' }))).status, 401, 'no such customer');
    await UserModel.collection.updateOne({ _id: new Types.ObjectId(c.id) }, { $set: { authVersion: [0] } });
    assert.equal((await admits(sign({ _id: c.id, userType: 'user', authVersion: 0 }))).status, 401, 'array stored value never matches');
    await rejects(auth.revokeSessions({ _id: c.id, userType: 'user', authVersion: 0 }), 'UNAUTHORIZED', 401);
    // Only an absent field is legacy 0. Present-but-undefined (BSON Undefined decodes to an own undefined property)
    // and null are corrupt, so the reader and the revoke filter agree: never admitted-but-unrevocable.
    assert.equal(storedCredentialVersion({}), 0);
    assert.equal(storedCredentialVersion({ authVersion: undefined }), -1);
    assert.equal(storedCredentialVersion({ authVersion: null }), -1);
    assert.equal(storedCredentialVersion({ authVersion: 3 }), 3);
    const n = await customer();
    await UserModel.collection.updateOne({ _id: new Types.ObjectId(n.id) }, { $set: { authVersion: null } });
    assert.equal((await admits(sign({ _id: n.id, userType: 'user' }))).status, 401, 'stored null never admits a generation-0 token');
    await rejects(auth.revokeSessions({ _id: n.id, userType: 'user' }), 'UNAUTHORIZED', 401);
    const pharmacy = sign({ _id: new Types.ObjectId().toHexString(), pharmacyId: 'x', userType: 'pharmacy' });
    assert.deepEqual(await admits(pharmacy), { ok: true }, 'non-customer tokens are not checked against the user collection');
    await rejects(auth.revokeSessions(claims(pharmacy) as never), 'FORBIDDEN', 403);
  });

  await check('HTTP: POST /v1/auth/sessions/revoke through the real router; the old token is then refused on a protected route', async () => {
    const c = await customer();
    const token = await login(c.phone);
    Container.set(AuthService, auth);
    const { default: router } = await import('@/modules/auth/routes');
    const app = express(); app.use(express.json());
    app.use('/api/v1/auth', router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const call = (path: string, t?: string) => fetch(`http://127.0.0.1:${port}/api/v1/auth${path}`, { method: path.endsWith('revoke') ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: path.endsWith('revoke') ? '{}' : undefined });
      assert.equal((await call('/sessions/revoke')).status, 401);
      assert.equal((await call('/profile', token)).status, 200);
      const r = await call('/sessions/revoke', token);
      assert.equal(r.status, 200);
      assert.deepEqual(((await r.json()) as { data: unknown }).data, { signedOutEverywhere: true, reauthenticationRequired: true });
      assert.equal((await call('/profile', token)).status, 401);
      assert.equal((await call('/sessions/revoke', token)).status, 401);
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
