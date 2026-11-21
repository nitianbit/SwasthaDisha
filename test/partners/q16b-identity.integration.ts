/**
 * Q16b pre-production fixes in identity, auth and the partner core, against the real app routes and MongoDB (only the
 * SMS/email providers are stubbed): partner sign-in needs a session (SESSION_REQUIRED); pharmacy, doctor and partner
 * token generations end bearer tokens on contact changes and "sign out everywhere"; admin contact changes of customers
 * and doctors end their sign-ins; a clinic doctor is removed only through the doctor unlink; owners' sign-in emails are
 * admin-only and members are told of email changes; partner own views; the admin actor's lowercase partner id; admin
 * audits and reinstate restoring the previous state; branch request keys; concurrent owner changes; the partnerId send
 * oracle; logo validation; idempotent logout.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q16b_identity_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx test/partners/q16b-identity.integration.ts
 */
import { removeFixtureDir } from './q8-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import { AuthService } from '@/modules/auth/services';
import { AdminRepository } from '@/modules/admin/repository';
import { HRRepository } from '@/modules/hr/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CorporateRepository } from '@/modules/corporates/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import NotificationModel from '@/modules/notification/model';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import { SMSService } from '@/modules/sms/services';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { FileUploadModel, FileGrantModel } from '@/modules/file/model/access';
import { UserService } from '@/modules/user/services';
import { SpecialistService } from '@/modules/specialists/services';
import { PharmacyService } from '@/modules/pharmacies/services';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { createNativeSession, refreshNativeSession } from '@/modules/auth/sessions';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import * as clinic from '@/modules/partners/services/clinic';
import { updateMyPartnerSchema, updatePartnerSchema } from '@/modules/partners/validation';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q16b_identity_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const STAFF = 'https://staff.jansetu.test';
if (CONFIG.SESSION_ORIGINS_WORKSPACE !== STAFF) throw new Error('Run with SESSION_ORIGINS_WORKSPACE=' + STAFF + ' (and SESSION_ORIGINS_CUSTOMER)');

/** Real message texts (OTP and member_email), recorded instead of sent. A `failNext` makes the next send throw. */
const sms: { to: string; text: string; templateId?: string }[] = [];
let failNextSms = false;
class RecordingSMS extends SMSService {
  async sendSMS(m: { to: string; text: string; templateId?: string }) {
    if (failNextSms) { failNextSms = false; throw new Error('provider down'); }
    sms.push(m); return { success: true, data: null };
  }
}
const smsService = new RecordingSMS();
const users = new UserRepository();
const notifications = new NotificationService(new NotificationRepository(), users, {} as never);
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(users, new AdminRepository(), new HRRepository(),
  new SpecialistRepository(), new PharmacyRepository(), {}, new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  notifications, { sendEmail: async () => ({ success: true }) }, smsService, new MemberRepository());
const partners = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const doctors = new SpecialistService(new SpecialistRepository(), new CorporateRepository(), new BookingRepository());
const customers = new UserService(new UserRepository(), new CorporateRepository());
const pharmacies = new PharmacyService(new PharmacyRepository(), new UserRepository());
Container.set(AuthService, auth);
Container.set(PartnerService, partners);
Container.set(PharmacyService, pharmacies);
Container.set(BannerService, new BannerService(new BannerRepository()));
Container.set(NotificationService, notifications);
Container.set(SMSService, smsService);
clinic.setClinicNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let seq = 0;
const nextPhone = () => '95' + String(10_000_000 + ++seq).padStart(8, '0');
const ADMIN = new Types.ObjectId().toHexString();
const adminTok = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
/** A bearer token as issued before Q16b (no authVersion). */
const legacy = (claims: Record<string, unknown>) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '30d' });
const memberTok = (m: { _id?: unknown; partnerId: unknown }, extra: Record<string, unknown> = {}) =>
  legacy({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner', ...extra });
const lastOtp = () => /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
const branchIn = (name: string, inClinic = false) => ({ name, phone: '9876500000', holidays: [], hours: {},
  services: { homeCollection: false, inLab: !inClinic, inClinic }, address: { line1: 'x', city: 'Pune', state: 'MH', stateCode: '27', pincode: '411001' } }) as any;

let base = '';
type Res = { status: number; body: any; cookie: string | null };
async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; native?: boolean; cookieMode?: boolean; cookie?: string | null } = {}): Promise<Res> {
  if (/\/auth\/[a-z]+\/(send|verify)$/.test(path)) await OtpThrottleModel.deleteMany({});
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: STAFF };
  if (opts.bearer) headers.authorization = 'Bearer ' + opts.bearer;
  if (opts.native) headers['x-jansetu-native'] = '1';
  if (opts.cookieMode) headers['x-jansetu-session'] = '1';
  if (opts.cookie) headers.cookie = opts.cookie.split(';')[0]!;
  const r = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.getSetCookie().find((c) => /sd_staff_rt=/.test(c)) ?? null };
}
const nativeBody = { session: 'native', app: 'workspace' };

async function verifiedPartner(name: string, kind: 'lab' | 'clinic' = 'lab', ownerPhone = nextPhone()) {
  const { partner, owner } = await partners.createPartner({ kind, name, contactPhone: nextPhone(), invoiceSeriesPrefix: 'QB',
    firstOwner: { phone: ownerPhone, name: 'Owner ' + name }, adminId: ADMIN } as any);
  await partners.verifyPartner(String(partner._id), ADMIN);
  return { partnerId: String(partner._id), owner, own: actorFor(owner), admin: adminActor(ADMIN, String(partner._id)) };
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  for (const name of mongoose.modelNames().sort()) { const M = mongoose.model(name); await M.createCollection(); await M.syncIndexes(); }
  (CONFIG as any).SMS_API_BASE_URL = 'https://sms.invalid'; (CONFIG as any).SMS_USERNAME = 'u'; (CONFIG as any).SMS_PASSWORD = 'p';
  (CONFIG as any).SMS_FROM = 'JANSTU'; (CONFIG as any).SMS_TEMPLATE_ID_MEMBER_EMAIL = 'tmpl-member-email';

  const { configureRoutes } = await import('@/routes');
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const A = await verifiedPartner('Alpha Labs');

    // ── 1. No 30-day bearer for partner members ──
    await check('partner verify/select without a session are refused 400 SESSION_REQUIRED before the code or ticket is used', async () => {
      const phone = String(A.owner.phone);
      assert.equal((await call('POST', '/api/v1/auth/partner/send', { body: { phone } })).status, 200);
      const otp = lastOtp();
      const bare = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp } });
      assert.deepEqual([bare.status, bare.body.code], [400, 'SESSION_REQUIRED']);
      // The code was not used: the same code still signs in, with a phone-app session.
      const ok = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp, ...nativeBody }, native: true });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(ok.body.data.refreshToken);
      const claims = jwt.decode(ok.body.data.token) as any;
      assert.deepEqual([typeof claims.sid, claims.authVersion], ['string', 0]);
      const sel = await call('POST', '/api/v1/auth/partner/select', { body: { ticket: 'x', partnerId: A.partnerId } });
      assert.deepEqual([sel.status, sel.body.code], [400, 'SESSION_REQUIRED']);
      // A web sign-in with a cookie session works as before.
      await call('POST', '/api/v1/auth/partner/send', { body: { phone } });
      const web = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: lastOtp(), session: 'cookie' }, cookieMode: true });
      assert.equal(web.status, 200, JSON.stringify(web.body));
      assert.ok(web.cookie);
      // Other roles keep the bearer answer.
      const ph = await PharmacyModel.create({ name: 'Bearer Pharmacy', phone: nextPhone(), isActive: true, isVerified: true });
      await call('POST', '/api/v1/auth/pharmacy/send', { body: { phone: ph.phone } });
      const p = await call('POST', '/api/v1/auth/pharmacy/verify', { body: { phone: ph.phone, otp: lastOtp() } });
      assert.equal(p.status, 200);
      assert.equal((jwt.decode(p.body.data.token) as any).sid, undefined);
    });

    await check('POST /auth/session/logout is idempotent (twice, no cookie, a dead bearer) and ends the session at once', async () => {
      const phone = String(A.owner.phone);
      await call('POST', '/api/v1/auth/partner/send', { body: { phone } });
      const web = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: lastOtp(), session: 'cookie' }, cookieMode: true });
      const token = web.body.data.token as string;
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: token })).status, 200);
      const first = await call('POST', '/api/v1/auth/session/logout', { cookieMode: true, cookie: web.cookie, bearer: token });
      assert.deepEqual([first.status, first.body.data?.signedOut], [200, true]);
      assert.match(first.cookie!, /Max-Age=0/);
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: token })).status, 401);
      for (const again of [{ cookie: web.cookie, bearer: token }, {}, { bearer: 'not.a.token' }]) {
        const r = await call('POST', '/api/v1/auth/session/logout', { cookieMode: true, ...again });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      // Only the simple same-origin request a keepalive fetch makes: Origin, the app header and a JSON body; no bearer.
      assert.equal((await call('POST', '/api/v1/auth/session/logout', { cookieMode: true, cookie: web.cookie })).status, 200);
    });

    // ── 2. Token generations: partner members, pharmacies, doctors, customers ──
    await check('partner member: a sign-in email change ends a bearer token issued before Q16b (and the sessions)', async () => {
      const staff = await partners.addMember(A.own, { phone: nextPhone(), name: 'Desk', role: 'staff', email: 'desk@example.com', permissions: [] } as any);
      const old = memberTok(staff);
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: old })).status, 200, 'absent generation = 0: still admitted');
      const app = await createNativeSession('native_workspace', { _id: String(staff._id), memberId: String(staff._id), partnerId: A.partnerId,
        phone: staff.phone, userType: 'partner', authVersion: 0 });
      await partners.updateMemberEmail(A.own, String(staff._id), 'desk.new@example.com');
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: old })).status, 401);
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: app.token })).status, 401);
      await assert.rejects(refreshNativeSession({ headers: { 'x-jansetu-native': '1', 'content-type': 'application/json' },
        body: { app: 'workspace', refreshToken: app.refreshToken } } as any));
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', { bearer: memberTok(staff, { authVersion: 1 }) })).status, 200);
    });

    await check('pharmacy: a phone change and "sign out on all devices" end the 30-day bearer; nobody is signed out by the deploy', async () => {
      const ph = await PharmacyModel.create({ name: 'Versioned Pharmacy', phone: nextPhone(), isActive: true, isVerified: true });
      const id = String(ph._id);
      const before = legacy({ _id: id, pharmacyId: id, phone: ph.phone, userType: 'pharmacy' });
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: before })).status, 200, 'pre-Q16b token admitted');
      await call('POST', '/api/v1/auth/pharmacy/send', { body: { phone: ph.phone } });
      const issued = (await call('POST', '/api/v1/auth/pharmacy/verify', { body: { phone: ph.phone, otp: lastOtp() } })).body.data.token as string;
      assert.equal((jwt.decode(issued) as any).authVersion, 0);
      const fresh = await createNativeSession('native_workspace', { _id: id, pharmacyId: id, phone: ph.phone, userType: 'pharmacy', authVersion: 0 });
      const newPhone = nextPhone();
      await pharmacies.update(id, { phone: newPhone } as any);
      for (const t of [before, issued, fresh.token]) assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: t })).status, 401);
      // A new sign-in carries the new generation and works; sign out everywhere then ends it.
      await call('POST', '/api/v1/auth/pharmacy/send', { body: { phone: newPhone } });
      const again = (await call('POST', '/api/v1/auth/pharmacy/verify', { body: { phone: newPhone, otp: lastOtp() } })).body.data.token as string;
      assert.equal((jwt.decode(again) as any).authVersion, 1);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: again })).status, 200);
      assert.equal((await call('POST', '/api/v1/auth/sessions/revoke', { bearer: again })).status, 200);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: again })).status, 401);
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph._id }))!.authVersion, 2);
      // A token claiming a malformed generation is refused.
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: legacy({ _id: id, pharmacyId: id, userType: 'pharmacy', authVersion: '2' }) })).status, 401);
    });

    await check('doctor: an admin phone or email change ends the bearer and the sessions; other edits end nothing', async () => {
      const sp = await SpecialistModel.create({ name: 'Dr Version', phone: nextPhone(), email: 'dr.version@example.com', isActive: true, isVerified: true });
      const id = String(sp._id);
      const tok = legacy({ _id: id, specialistId: id, phone: sp.phone, userType: 'specialist' });
      const app = await createNativeSession('native_workspace', { _id: id, specialistId: id, phone: sp.phone, userType: 'specialist', authVersion: 0 });
      await doctors.update(id, { name: 'Dr Renamed' } as any);
      await doctors.update(id, { phone: sp.phone } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: tok })).status, 200);
      assert.equal(await AuthSessionModel.countDocuments({ userId: id, revokedAt: { $exists: false } }), 1);
      await doctors.update(id, { phone: nextPhone() } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: tok })).status, 401);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: app.token })).status, 401);
      assert.equal(await AuthSessionModel.countDocuments({ userId: id, revokedAt: { $exists: false } }), 0);
      const v1 = legacy({ _id: id, specialistId: id, userType: 'specialist', authVersion: 1 });
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: v1 })).status, 200);
      await doctors.update(id, { email: 'dr.other@example.com' } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: v1 })).status, 401);
    });

    await check('customer: an admin phone or email change ends the bearer and the sessions; their own edit does not', async () => {
      const u = await UserModel.create({ name: 'Ravi', phone: nextPhone(), email: 'ravi@example.com', userType: 'user' });
      const id = String(u._id);
      const tok = legacy({ _id: id, phone: u.phone, userType: 'user' });
      await AuthSessionModel.create({ _id: 'cust-' + id, audience: 'customer', userType: 'user', userId: id, authTime: new Date(), authVersion: 0,
        absoluteExpiresAt: new Date(Date.now() + 86_400_000), idleExpiresAt: new Date(Date.now() + 86_400_000), gen: 1, createdAt: new Date() } as any);
      await customers.updateWithContacts(id, { name: 'Ravi K', phone: nextPhone() } as any, { _id: id, userType: 'user' } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: tok })).status, 200, 'own edit (contacts left out) ends nothing');
      await customers.updateWithContacts(id, { phone: nextPhone() } as any, { _id: ADMIN, userType: 'admin' } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: tok })).status, 401);
      assert.equal(await AuthSessionModel.countDocuments({ userId: id, revokedAt: { $exists: false } }), 0);
      const v1 = legacy({ _id: id, userType: 'user', authVersion: 1 });
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: v1 })).status, 200);
      await customers.updateWithContacts(id, { email: 'ravi.new@example.com' } as any, { _id: ADMIN, userType: 'admin' } as any);
      assert.equal((await call('GET', '/api/v1/auth/profile', { bearer: v1 })).status, 401);
    });

    // ── 3. A clinic's doctor leaves only through the doctor unlink ──
    await check('DELETE /members/:id of a member with a doctor link: 409 USE_DOCTOR_UNLINK (staff manager and owner); the unlink works', async () => {
      const C = await verifiedPartner('Care Clinic', 'clinic');
      const br = await partners.createBranch(C.own, branchIn('Main', true));
      const dr = await SpecialistModel.create({ name: 'Dr Linked', phone: nextPhone(), isActive: true, isVerified: true });
      const link = await clinic.linkDoctor(C.admin, { doctorId: String(dr._id), branchIds: [String(br._id)], requestKey: 'q16b-link-0001' });
      const manager = await partners.addMember(C.own, { phone: nextPhone(), name: 'Manager', role: 'staff', permissions: ['staff.manage'] } as any);
      const r = await call('DELETE', `/api/v1/partner-workspace/members/${link.memberId}`, { bearer: memberTok(manager) });
      assert.deepEqual([r.status, r.body.code], [409, 'USE_DOCTOR_UNLINK']);
      await assert.rejects(partners.removeMember(C.own, String(link.memberId)), code('USE_DOCTOR_UNLINK'));
      await assert.rejects(partners.removeMember(C.admin, String(link.memberId)), code('USE_DOCTOR_UNLINK'));
      assert.equal((await MemberModel.findById(link.memberId).lean())!.isActive, true);
      assert.equal((await call('DELETE', `/api/v1/partner-workspace/clinic/doctors/${dr._id}`, { bearer: memberTok(manager) })).status, 403);
      assert.equal((await call('DELETE', `/api/v1/partner-workspace/clinic/doctors/${dr._id}`, { bearer: memberTok(C.owner) })).status, 200);
      assert.equal((await MemberModel.findById(link.memberId).lean())!.isActive, false);
    });

    // ── 4. Owners' sign-in emails are admin-only; members are told of every change ──
    await check("an owner's email (another owner's or their own) is admin-only: 403 OWNER_EMAIL_ADMIN_ONLY; also on owner add", async () => {
      const co = await partners.addMember(A.own, { phone: nextPhone(), name: 'Co-owner', role: 'owner', permissions: [] } as any);
      await assert.rejects(partners.updateMemberEmail(A.own, String(co._id), 'mine@example.com'), code('OWNER_EMAIL_ADMIN_ONLY'));
      await assert.rejects(partners.updateMemberEmail(A.own, String(A.owner._id), 'me@example.com'), code('OWNER_EMAIL_ADMIN_ONLY'));
      await assert.rejects(partners.updateMemberEmail(A.own, String(co._id), null), code('OWNER_EMAIL_ADMIN_ONLY'));
      await assert.rejects(partners.addMember(A.own, { phone: nextPhone(), name: 'Owner 3', role: 'owner', email: 'o3@example.com', permissions: [] } as any),
        code('OWNER_EMAIL_ADMIN_ONLY'));
      const http = await call('PUT', `/api/v1/partner-workspace/members/${co._id}/email`, { bearer: memberTok(A.owner), body: { email: 'x@example.com' } });
      assert.deepEqual([http.status, http.body.code], [403, 'OWNER_EMAIL_ADMIN_ONLY']);
      assert.equal((await partners.updateMemberEmail(A.admin, String(co._id), 'co.owner@example.com')).email, 'co.owner@example.com');
      const byAdmin = await call('PUT', `/api/v1/partner-workspace/admin/${A.partnerId}/workspace/members/${A.owner._id}/email`, { bearer: adminTok, body: { email: 'owner.a@example.com' } });
      assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
      // Staff emails stay with owners.
      const staff = await partners.addMember(A.own, { phone: nextPhone(), name: 'Front desk', role: 'staff', permissions: [] } as any);
      assert.equal((await partners.updateMemberEmail(A.own, String(staff._id), 'front@example.com')).email, 'front@example.com');
    });

    await check('the member is told when their email is set, changed or removed (in-app + SMS); a failed SMS never affects the change', async () => {
      const phone = nextPhone();
      const staff = await partners.addMember(A.own, { phone, name: 'Told', role: 'staff', email: 'told@example.com', permissions: [] } as any);
      const smsTo = () => sms.filter((m) => m.to === phone);
      await partners.updateMemberEmail(A.own, String(staff._id), 'told.new@example.com');
      await partners.updateMemberEmail(A.admin, String(staff._id), null);
      await partners.updateMemberEmail(A.own, String(staff._id), null); // unchanged: no notice
      failNextSms = true;
      assert.equal((await partners.updateMemberEmail(A.own, String(staff._id), 'told.again@example.com')).email, 'told.again@example.com');
      const rows = await NotificationModel.find({ userId: String(staff._id) }).sort({ createdAt: 1 }).lean() as any[];
      assert.deepEqual(rows.map((r) => r.data.change), ['set', 'changed', 'removed', 'set']);
      assert.ok(rows.every((r) => r.title === 'Your sign-in email changed' && !/told\.new@example\.com/.test(r.message)));
      assert.match(rows[1]!.message, /to\*\*\*@example\.com.*an owner of your workspace/);
      assert.match(rows[2]!.message, /was removed.*the Jansetu team/);
      assert.equal(smsTo().length, 3, 'set, changed, removed (the 4th send failed)');
      assert.ok(smsTo().every((m) => m.templateId === 'tmpl-member-email' && !/@/.test(m.text)));
      // Without the DLT template only the in-app notice is made.
      (CONFIG as any).SMS_TEMPLATE_ID_MEMBER_EMAIL = undefined;
      await partners.updateMemberEmail(A.own, String(staff._id), 'told.last@example.com');
      (CONFIG as any).SMS_TEMPLATE_ID_MEMBER_EMAIL = 'tmpl-member-email';
      assert.equal(smsTo().length, 3);
      const v = (await MemberModel.collection.findOne({ _id: staff._id }))!.authVersion as number;
      const mine = await call('GET', '/api/v1/partner-workspace/me/notifications', { bearer: memberTok(staff, { authVersion: v }) });
      assert.equal(mine.status, 200);
      assert.equal(mine.body.data.length, 5);
      assert.equal((await call('GET', `/api/v1/partner-workspace/admin/${A.partnerId}/workspace/me/notifications`, { bearer: adminTok })).status, 404);
    });

    // ── 5. Own views ──
    await check('own views hide createdBy, createRequestKey/Hash and verification.verifiedBy; admin answers keep them', async () => {
      const ownerPhone = nextPhone();
      const created = await call('POST', '/api/v1/partner-workspace/admin', { bearer: adminTok, body: { kind: 'lab', name: 'Keyed Lab', contactPhone: nextPhone(),
        invoiceSeriesPrefix: 'KL', firstOwner: { phone: ownerPhone, name: 'K' }, requestKey: 'q16b-create-0001' } });
      assert.equal(created.status, 201);
      const pid = String(created.body.data.partner._id);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${pid}/verify`, { bearer: adminTok })).status, 200);
      const owner = await MemberModel.findOne({ partnerId: pid, role: 'owner' }).lean() as IMember;
      const hidden = (p: any) => { assert.equal(p.createdBy, undefined); assert.equal(p.createRequestKey, undefined); assert.equal(p.createRequestHash, undefined); assert.equal(p.verification.verifiedBy, undefined); assert.equal(p.verification.state, 'verified'); };
      hidden((await call('GET', '/api/v1/partner-workspace/me', { bearer: memberTok(owner) })).body.data);
      hidden((await call('PUT', '/api/v1/partner-workspace/me', { bearer: memberTok(owner), body: { name: 'Keyed Lab Pvt' } })).body.data);
      hidden((await call('GET', '/api/v1/auth/profile', { bearer: memberTok(owner) })).body.data.partner);
      const adminView = (await call('GET', `/api/v1/partner-workspace/admin/${pid}`, { bearer: adminTok })).body.data;
      assert.deepEqual([adminView.createdBy, adminView.createRequestKey, adminView.verification.verifiedBy], [ADMIN, 'q16b-create-0001', ADMIN]);
    });

    // ── 6. Admin-as-owner with an upper-case partner id writes under the one lowercase spelling ──
    await check('admin-as-owner through an upper-case URL: rows and audit are stored under the lowercase id', async () => {
      const upper = A.partnerId.toUpperCase();
      const r = await call('POST', `/api/v1/partner-workspace/admin/${upper}/workspace/branches`, { bearer: adminTok, body: branchIn('Upper Case') });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.partnerId, A.partnerId);
      const m = await call('POST', `/api/v1/partner-workspace/admin/${upper}/workspace/members`, { bearer: adminTok, body: { phone: nextPhone(), name: 'Via upper', role: 'staff', permissions: [] } });
      assert.equal(m.body.data.partnerId, A.partnerId);
      assert.equal(await PartnerAuditEventModel.countDocuments({ partnerId: upper }), 0);
      assert.ok(await PartnerAuditEventModel.exists({ partnerId: A.partnerId, action: 'branch.create', actorKind: 'admin' }));
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${upper}/suspend`, { bearer: adminTok })).status, 200);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${upper}/reinstate`, { bearer: adminTok })).status, 200);
      assert.equal(await PartnerAuditEventModel.countDocuments({ partnerId: upper }), 0);
    });

    // ── 7. Admin partner actions are audited; reinstate restores the previous state ──
    await check('admin create, update, verify, suspend and reinstate each write a PartnerAuditEvent naming the admin', async () => {
      const c = await call('POST', '/api/v1/partner-workspace/admin', { bearer: adminTok, body: { kind: 'clinic', name: 'Audited Clinic', contactPhone: nextPhone(),
        invoiceSeriesPrefix: 'AC', firstOwner: { phone: nextPhone(), name: 'A' } } });
      const pid = String(c.body.data.partner._id);
      assert.equal((await call('PUT', `/api/v1/partner-workspace/admin/${pid}`, { bearer: adminTok, body: { name: 'Audited Clinic 2', gstin: '27ABCDE1234F1Z5' } })).status, 200);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${pid}/verify`, { bearer: adminTok })).status, 200);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${pid}/suspend`, { bearer: adminTok })).status, 200);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${pid}/reinstate`, { bearer: adminTok })).status, 200);
      const rows = await PartnerAuditEventModel.find({ partnerId: pid }).sort({ at: 1, _id: 1 }).lean() as any[];
      assert.deepEqual(rows.map((r) => r.action), ['partner.create', 'partner.update', 'partner.verify', 'partner.suspend', 'partner.reinstate']);
      assert.ok(rows.every((r) => r.actorKind === 'admin' && r.actorId === ADMIN));
      assert.deepEqual(rows[1].detail.fields.sort(), ['gstin', 'name']);
      // An audit failure rolls the action back (same transaction).
      const coll = PartnerAuditEventModel.collection.collectionName;
      await mongoose.connection.db.command({ collMod: coll, validator: { action: { $ne: 'partner.suspend' } }, validationLevel: 'strict', validationAction: 'error' });
      try {
        assert.notEqual((await call('POST', `/api/v1/partner-workspace/admin/${pid}/suspend`, { bearer: adminTok })).status, 200);
      } finally {
        await mongoose.connection.db.command({ collMod: coll, validator: {}, validationLevel: 'off' });
      }
      assert.equal((await PartnerModel.findById(pid).lean())!.verification.state, 'verified');
    });

    await check('suspend then reinstate restores the previous state: a never-verified partner stays pending; a verified one is verified', async () => {
      const { partner } = await partners.createPartner({ kind: 'lab', name: 'Never Verified', contactPhone: nextPhone(), invoiceSeriesPrefix: 'NV',
        firstOwner: { phone: nextPhone(), name: 'N' }, adminId: ADMIN } as any);
      const pid = String(partner._id);
      await partners.suspendPartner(pid, ADMIN);
      await assert.rejects(partners.suspendPartner(pid, ADMIN), code('ALREADY_SUSPENDED'));
      const back = await partners.reinstatePartner(pid, ADMIN);
      assert.deepEqual([back.verification.state, back.isActive, back.verification.verifiedBy], ['pending', true, undefined]);
      assert.equal((back.verification as any).stateBeforeSuspension, undefined);
      await partners.verifyPartner(pid, ADMIN);
      await partners.suspendPartner(pid, ADMIN);
      assert.equal((await partners.reinstatePartner(pid, ADMIN)).verification.state, 'verified');
      // Suspended before Q16b recorded the previous state: back to pending, an admin verifies it again.
      await PartnerModel.updateOne({ _id: pid }, { $set: { 'verification.state': 'suspended', isActive: false } });
      assert.equal((await partners.reinstatePartner(pid, ADMIN)).verification.state, 'pending');
    });

    // ── 9. Grouped ──
    await check('POST /branches with a requestKey: exactly once (replay 200 with the same branch, other content 409, races make one)', async () => {
      const body = { ...branchIn('Keyed Branch'), requestKey: 'q16b-branch-0001' };
      const first = await call('POST', '/api/v1/partner-workspace/branches', { bearer: memberTok(A.owner), body });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.data.createRequestHash, undefined);
      const again = await call('POST', '/api/v1/partner-workspace/branches', { bearer: memberTok(A.owner), body });
      assert.deepEqual([again.status, again.body.data._id, again.body.replayed], [200, first.body.data._id, true]);
      assert.equal(again.body.data.createRequestHash, undefined);
      const other = await call('POST', '/api/v1/partner-workspace/branches', { bearer: memberTok(A.owner), body: { ...body, name: 'Other' } });
      assert.deepEqual([other.status, other.body.code], [409, 'REQUEST_KEY_REUSED']);
      const raceBody = { ...branchIn('Raced'), requestKey: 'q16b-branch-0002' };
      const raced = await Promise.all([1, 2, 3, 4, 5].map(() => partners.createBranch(A.own, raceBody)));
      assert.equal(new Set(raced.map((b) => String(b._id))).size, 1);
      assert.equal(await BranchModel.countDocuments({ partnerId: A.partnerId, createRequestKey: 'q16b-branch-0002' }), 1);
      // Without a key nothing changes: two creates make two branches.
      await partners.createBranch(A.own, branchIn('Plain'));
      await partners.createBranch(A.own, branchIn('Plain'));
      assert.equal(await BranchModel.countDocuments({ partnerId: A.partnerId, name: 'Plain' }), 2);
    });

    await check('concurrent owner adds and removals are retried (no raw WriteConflict); the owner count stays exact', async () => {
      const P = await verifiedPartner('Busy Owners');
      const added = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => partners.addMember(P.own, { phone: nextPhone(), name: 'Owner ' + i, role: 'owner', permissions: [] } as any)));
      assert.deepEqual(added.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.code ?? r.reason?.message), []);
      const count = async () => [(await PartnerModel.findById(P.partnerId).lean())!.activeOwnerCount, await MemberModel.countDocuments({ partnerId: P.partnerId, role: 'owner', isActive: true })];
      assert.deepEqual(await count(), [7, 7]);
      const ids = added.map((r: any) => String(r.value._id));
      const removed = await Promise.allSettled(ids.map((id) => partners.removeMember(P.own, id)));
      assert.deepEqual(removed.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.code ?? r.reason?.message), []);
      assert.deepEqual(await count(), [1, 1]);
    });

    await check('send with a partnerId answers exactly as without it; the membership there is learnt only after the code', async () => {
      const B = await verifiedPartner('Beta Labs');
      const phone = nextPhone();
      await partners.addMember(A.own, { phone, name: 'Only at Alpha', role: 'staff', permissions: [] } as any);
      const plain = await call('POST', '/api/v1/auth/partner/send', { body: { phone } });
      const named = await call('POST', '/api/v1/auth/partner/send', { body: { phone, partnerId: B.partnerId } });
      assert.deepEqual([named.status, named.body], [plain.status, plain.body]);
      const stranger = nextPhone();
      const s1 = await call('POST', '/api/v1/auth/partner/send', { body: { phone: stranger } });
      const s2 = await call('POST', '/api/v1/auth/partner/send', { body: { phone: stranger, partnerId: B.partnerId } });
      assert.deepEqual([s2.status, s2.body], [s1.status, s1.body]);
      assert.deepEqual([s1.status, s1.body.code], [404, 'PARTNER_MEMBER_NOT_FOUND']);
      // A wrong code fails the same way whether or not the phone is staff at the named partner.
      const wrongB = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: '000000', partnerId: B.partnerId, ...nativeBody }, native: true });
      const wrongA = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: '000000', partnerId: A.partnerId, ...nativeBody }, native: true });
      assert.deepEqual([wrongB.status, wrongB.body.code], [wrongA.status, wrongA.body.code]);
      await call('POST', '/api/v1/auth/partner/send', { body: { phone, partnerId: B.partnerId } });
      const proven = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: lastOtp(), partnerId: B.partnerId, ...nativeBody }, native: true });
      assert.deepEqual([proven.status, proven.body.code], [403, 'PARTNER_NOT_AVAILABLE']);
      // Naming their own partner (any letter case) still signs straight in.
      await call('POST', '/api/v1/auth/partner/send', { body: { phone, partnerId: A.partnerId.toUpperCase() } });
      const mine = await call('POST', '/api/v1/auth/partner/verify', { body: { phone, otp: lastOtp(), partnerId: A.partnerId.toUpperCase(), ...nativeBody }, native: true });
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.equal((jwt.decode(mine.body.data.token) as any).partnerId, A.partnerId);
    });

    await check('logo: an upload of the actor (bound as a public image) or an https URL; anything else refused', async () => {
      for (const schema of [updateMyPartnerSchema, updatePartnerSchema]) {
        for (const bad of ['javascript:alert(1)', 'http://cdn.example.com/a.png', 'data:image/png;base64,AAAA', 'just text', '/etc/passwd', 'general/../../x.png']) {
          assert.ok(schema.validate({ logo: bad }).error, bad);
        }
        for (const good of ['https://cdn.example.com/logo.png', '/api/static/general/a.png', '/api/v1/file/static/general/a.png', 'general/a.png']) {
          assert.equal(schema.validate({ logo: good }).error, undefined, good);
        }
      }
      const mine = 'general/q16b-alpha-logo.png';
      const theirs = 'general/q16b-someone-else.png';
      await FileUploadModel.create({ path: mine, uploaderType: 'partner', uploaderId: String(A.owner._id), createdAt: new Date() });
      await FileUploadModel.create({ path: theirs, uploaderType: 'user', uploaderId: new Types.ObjectId().toHexString(), createdAt: new Date() });
      const refused = await call('PUT', '/api/v1/partner-workspace/me', { bearer: memberTok(A.owner), body: { logo: `/api/static/${theirs}` } });
      assert.deepEqual([refused.status, refused.body.code], [400, 'FILE_NOT_ATTACHABLE']);
      const bad = await call('PUT', '/api/v1/partner-workspace/me', { bearer: memberTok(A.owner), body: { logo: 'javascript:alert(1)' } });
      assert.equal(bad.status, 400);
      const ok = await call('PUT', '/api/v1/partner-workspace/me', { bearer: memberTok(A.owner), body: { logo: `/api/static/${mine}` } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(await FileGrantModel.exists({ path: mine, model: 'PartnerOrg', resourceId: A.partnerId, field: 'logo', kind: 'public', state: 'active' }));
      const ext = await call('PUT', `/api/v1/partner-workspace/admin/${A.partnerId}`, { bearer: adminTok, body: { logo: 'https://cdn.example.com/alpha.png' } });
      assert.equal(ext.status, 200);
      assert.equal(ext.body.data.logo, 'https://cdn.example.com/alpha.png');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    removeFixtureDir();
  }
  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); try { removeFixtureDir(); } catch { /* gone */ } process.exit(1); });
